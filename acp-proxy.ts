/*
 * What: a line-delimited JSON-RPC proxy between bb's shared ACP bridge and `agy acp`.
 *
 * Why: the shared bridge cannot be changed from a plugin, and it talks to agy in ways
 * agy supports better natively. The first behaviour here: bb sends its thread and skill
 * instructions as a `<system_instructions>` text block at the top of the first prompt and
 * never again after a session is restored (get-bb/bb#7537). agy accepts a real system
 * prompt as `_meta.antigravity.systemPrompt.append` on session/new, session/load, and
 * session/resume (it ignores it on session/prompt), so the proxy lifts the block out of
 * the first prompt, applies it with a live session/resume, and re-injects it whenever the
 * bridge loads or resumes that session later.
 *
 * Design notes:
 * - The host artifact doubles as the proxy executable: host.ts rewrites the agy launch
 *   spec to `node <host.mjs> --agy-acp-proxy <agy> acp ...` on the agent host, so nothing
 *   extra is installed. See `proxyAntigravityLaunchSpec` in cli.ts.
 * - Messages the proxy does not change are forwarded as the original line.
 * - Proxy-originated requests use string ids with a reserved prefix; the bridge uses its
 *   own ids, so responses are routed without collisions.
 * - While a proxy-originated request is in flight, client messages are queued, so the
 *   prompt and anything after it (cancel, config changes) keep their order.
 * - Instructions are persisted per agy session id so they survive bridge and bb restarts.
 * - Every failure falls back to the bridge's own behaviour (the original prompt).
 *
 * Gotchas:
 * - Verified against agy 1.5.14: a live session/resume keeps model, thought_level and mode.
 * - The instruction store grows by one small file per Antigravity thread; nothing prunes it.
 * - The proxy never reads stdin until `run` is called, so importing this module starts nothing.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

export const AGY_ACP_PROXY_FLAG = "--agy-acp-proxy";
export const AGY_ACP_PROXY_STATE_DIR_ENV = "BB_AGY_ACP_PROXY_STATE_DIR";

const INSTRUCTIONS_OPEN = "<system_instructions>";
const INSTRUCTIONS_CLOSE = "</system_instructions>";
const INTERNAL_ID_PREFIX = "bb-agy-acp-proxy:";
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

type Json = Record<string, any>;

export interface InstructionStore {
  get(sessionId: string): string | undefined;
  set(sessionId: string, instructions: string): void;
}

/** Keeps instructions in memory and, when `dir` is set, in one JSON file per session. */
export function createInstructionStore(dir: string | undefined, log: (message: string) => void = () => {}): InstructionStore {
  const memory = new Map<string, string>();
  const fileFor = (sessionId: string) => (dir && SESSION_ID_PATTERN.test(sessionId) ? join(dir, `${sessionId}.json`) : undefined);
  return {
    get(sessionId) {
      if (memory.has(sessionId)) return memory.get(sessionId);
      const file = fileFor(sessionId);
      if (!file) return undefined;
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        if (parsed?.version === 1 && typeof parsed.instructions === "string") {
          memory.set(sessionId, parsed.instructions);
          return parsed.instructions;
        }
      } catch {}
      return undefined;
    },
    set(sessionId, instructions) {
      memory.set(sessionId, instructions);
      const file = fileFor(sessionId);
      if (!file || !dir) return;
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const temp = `${file}.${process.pid}.tmp`;
        writeFileSync(temp, `${JSON.stringify({ version: 1, instructions })}\n`, { mode: 0o600 });
        renameSync(temp, file);
      } catch (error) {
        log(`could not persist instructions for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

/** Returns the instructions inside a bridge `<system_instructions>` block, or undefined. */
export function extractSystemInstructions(text: unknown): string | undefined {
  if (typeof text !== "string" || !text.startsWith(INSTRUCTIONS_OPEN)) return undefined;
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith(INSTRUCTIONS_CLOSE)) return undefined;
  const inner = trimmed.slice(INSTRUCTIONS_OPEN.length, trimmed.length - INSTRUCTIONS_CLOSE.length);
  const instructions = inner.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
  return instructions.trim() ? instructions : undefined;
}

/** Adds an agy system-prompt append to `_meta`, leaving one the client already set. */
export function withSystemPrompt(meta: unknown, instructions: string): Json {
  const base: Json = meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Json) : {};
  const antigravity: Json = base.antigravity && typeof base.antigravity === "object" ? base.antigravity : {};
  if (antigravity.systemPrompt?.append !== undefined) return base;
  return { ...base, antigravity: { ...antigravity, systemPrompt: { ...antigravity.systemPrompt, append: instructions } } };
}

const isRequest = (m: Json) => typeof m.method === "string" && m.id !== undefined && m.id !== null;
const isResponse = (m: Json) => m.method === undefined && m.id !== undefined && ("result" in m || "error" in m);

interface SessionContext { cwd: unknown; mcpServers: unknown }

export interface AgyAcpProxyOptions {
  toAgent(line: string): void;
  toClient(line: string): void;
  store: InstructionStore;
  log?(message: string): void;
}

export class AgyAcpProxy {
  private readonly sessions = new Map<string, SessionContext>();
  private readonly newSessionRequests = new Map<unknown, SessionContext>();
  private readonly internal = new Map<string, (response: Json) => void>();
  private readonly queue: string[] = [];
  private blocked = 0;
  private seq = 0;
  private readonly options: AgyAcpProxyOptions;

  constructor(options: AgyAcpProxyOptions) {
    this.options = options;
  }

  fromClient(line: string): void {
    if (this.blocked > 0) {
      this.queue.push(line);
      return;
    }
    const message = parse(line);
    if (!message) return this.options.toAgent(line);
    if (isRequest(message)) {
      const params: Json = message.params && typeof message.params === "object" ? message.params : {};
      switch (message.method) {
        case "session/new":
          this.newSessionRequests.set(message.id, { cwd: params.cwd, mcpServers: params.mcpServers });
          break;
        case "session/load":
        case "session/resume":
          return this.options.toAgent(this.reapplyInstructions(message, params) ?? line);
        case "session/prompt":
          if (this.liftInstructions(message, params, line)) return;
          break;
      }
    }
    this.options.toAgent(line);
  }

  fromAgent(line: string): void {
    const message = parse(line);
    if (message && isResponse(message)) {
      const callback = typeof message.id === "string" ? this.internal.get(message.id) : undefined;
      if (callback) {
        this.internal.delete(message.id);
        return callback(message);
      }
      const context = this.newSessionRequests.get(message.id);
      if (context) {
        this.newSessionRequests.delete(message.id);
        const sessionId = message.result?.sessionId;
        if (typeof sessionId === "string") this.sessions.set(sessionId, context);
      }
    }
    this.options.toClient(line);
  }

  private reapplyInstructions(message: Json, params: Json): string | undefined {
    const sessionId = params.sessionId;
    if (typeof sessionId !== "string") return undefined;
    this.sessions.set(sessionId, { cwd: params.cwd, mcpServers: params.mcpServers });
    const instructions = this.options.store.get(sessionId);
    if (instructions === undefined) return undefined;
    return JSON.stringify({ ...message, params: { ...params, _meta: withSystemPrompt(params._meta, instructions) } });
  }

  private liftInstructions(message: Json, params: Json, line: string): boolean {
    const sessionId = params.sessionId;
    const prompt = params.prompt;
    if (typeof sessionId !== "string" || !Array.isArray(prompt) || prompt.length < 2) return false;
    const first = prompt[0];
    if (first?.type !== "text") return false;
    const instructions = extractSystemInstructions(first.text);
    const session = this.sessions.get(sessionId);
    if (instructions === undefined || !session) return false;
    this.options.store.set(sessionId, instructions);
    const stripped = JSON.stringify({ ...message, params: { ...params, prompt: prompt.slice(1) } });
    this.request("session/resume", {
      sessionId,
      cwd: session.cwd,
      mcpServers: Array.isArray(session.mcpServers) ? session.mcpServers : [],
      _meta: withSystemPrompt(undefined, instructions),
    }, response => {
      if (response.error) {
        this.options.log?.(`session/resume with system prompt failed; sending instructions in the prompt: ${JSON.stringify(response.error)}`);
        this.options.toAgent(line);
      } else {
        this.options.toAgent(stripped);
      }
    });
    return true;
  }

  private request(method: string, params: Json, onResponse: (response: Json) => void): void {
    const id = `${INTERNAL_ID_PREFIX}${++this.seq}`;
    this.blocked++;
    this.internal.set(id, response => {
      onResponse(response);
      this.blocked--;
      this.drain();
    });
    this.options.toAgent(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  }

  private drain(): void {
    while (this.blocked === 0 && this.queue.length > 0) this.fromClient(this.queue.shift()!);
  }
}

function parse(line: string): Json | undefined {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Runs the proxy as this process: argv is the agy command and its arguments. */
export function runAgyAcpProxy(argv: string[]): void {
  const [command, ...args] = argv;
  const log = (message: string) => process.stderr.write(`agy-acp-proxy: ${message}\n`);
  if (!command) {
    log("missing agy command");
    process.exit(64);
  }
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"], env: process.env, shell: false });
  const proxy = new AgyAcpProxy({
    toAgent: line => { child.stdin.write(`${line}\n`); },
    toClient: line => { process.stdout.write(`${line}\n`); },
    store: createInstructionStore(process.env[AGY_ACP_PROXY_STATE_DIR_ENV] || undefined, log),
    log,
  });
  createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", line => proxy.fromClient(line));
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", line => proxy.fromAgent(line));
  process.stdin.on("end", () => child.stdin.end());
  child.stdin.on("error", () => {});
  child.on("error", error => {
    log(`could not start ${command}: ${error.message}`);
    process.exit(127);
  });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => child.kill(signal));
  }
}

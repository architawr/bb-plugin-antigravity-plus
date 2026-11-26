import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveAgyAppDataDir } from "./agy-fork.ts";
import { resolveAntigravityProfileArgs } from "./cli.ts";
import {
  emptySwarmBoardSnapshot,
  type SwarmBoardSnapshot,
  type SwarmMember,
  type SwarmMessage,
  type SwarmPlan,
} from "./swarm-contract.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MESSAGES = 200;
const MAX_MESSAGE_TEXT_CHARS = 8_000;
const MAX_JSON_FILE_BYTES = 2 * 1024 * 1024;

export interface ReadSwarmBoardOptions {
  appDataDir?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  maxFileBytes?: number;
}

export function resolveSwarmAppDataDir(options?: ReadSwarmBoardOptions): string {
  if (options?.appDataDir) return options.appDataDir;
  const env = options?.env ?? process.env;
  return resolveAgyAppDataDir(resolveAntigravityProfileArgs(env), options?.home ?? homedir());
}

/** Reads a JSON file only if its size fits within maxBytes; never tail-slices a JSON object. */
function readBoundedJsonText(path: string, maxBytes: number): string | null {
  if (!existsSync(path)) return null;
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    if (size === 0 || size > maxBytes) return null;
    const buf = Buffer.allocUnsafe(size);
    const bytesRead = readSync(fd, buf, 0, size, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/** Reads at most the trailing maxBytes of an NDJSON file without loading larger files into memory. */
function readBoundedTailLines(path: string, maxBytes: number): { text: string; tailTruncated: boolean } | null {
  if (!existsSync(path)) return null;
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    if (size === 0) return { text: "", tailTruncated: false };
    const start = Math.max(0, size - maxBytes);
    const toRead = size - start;
    const buf = Buffer.allocUnsafe(toRead);
    const bytesRead = readSync(fd, buf, 0, toRead, start);
    let text = buf.subarray(0, bytesRead).toString("utf8");
    const tailTruncated = start > 0;
    if (tailTruncated) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }
    return { text, tailTruncated };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseMembers(raw: Record<string, unknown> | null): { title: string | null; members: SwarmMember[] } {
  if (!raw) return { title: null, members: [] };
  const title = nonEmptyString(raw.title);
  const membersMap =
    raw.members && typeof raw.members === "object" && !Array.isArray(raw.members)
      ? (raw.members as Record<string, unknown>)
      : null;
  if (!membersMap) return { title, members: [] };

  const members: SwarmMember[] = [];
  for (const [name, entry] of Object.entries(membersMap)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const obj = entry as Record<string, unknown>;
    const role = nonEmptyString(obj.role) ?? (name === "coordinator" ? "coordinator" : "worker");
    const phase = nonEmptyString(obj.phase) ?? nonEmptyString(obj.desired_state) ?? "UNKNOWN";
    const model = nonEmptyString(obj.applied_model) ?? nonEmptyString(obj.model) ?? nonEmptyString(obj.desired_model);
    const workspaceMode = nonEmptyString(obj.workspace_mode);
    const killed = obj.killed === true;
    const lastReadSeq =
      typeof obj.last_read_seq === "number" && Number.isInteger(obj.last_read_seq) ? obj.last_read_seq : null;

    members.push({
      name,
      role,
      phase,
      model,
      workspaceMode,
      killed,
      lastReadSeq,
    });
  }

  members.sort((a, b) => {
    if (a.role === "coordinator" && b.role !== "coordinator") return -1;
    if (b.role === "coordinator" && a.role !== "coordinator") return 1;
    if (a.killed !== b.killed) return a.killed ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  return { title, members };
}

function parsePlan(raw: Record<string, unknown> | null): SwarmPlan | null {
  if (!raw) return null;
  const goalObj =
    raw.goal && typeof raw.goal === "object" && !Array.isArray(raw.goal)
      ? (raw.goal as Record<string, unknown>)
      : null;
  const goalTitle = nonEmptyString(goalObj?.title);
  const goalLine = nonEmptyString(goalObj?.line);

  const tasks: Record<string, string> = {};
  if (raw.tasks && typeof raw.tasks === "object" && !Array.isArray(raw.tasks)) {
    for (const [key, value] of Object.entries(raw.tasks as Record<string, unknown>)) {
      const text = nonEmptyString(value);
      if (text) tasks[key] = text;
    }
  }

  const threads: SwarmPlan["threads"] = [];
  if (Array.isArray(raw.threads)) {
    for (const item of raw.threads) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const obj = item as Record<string, unknown>;
      const id = nonEmptyString(obj.id);
      const title = nonEmptyString(obj.title);
      if (!id || !title) continue;
      const taskList = Array.isArray(obj.tasks)
        ? obj.tasks.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
        : [];
      threads.push({
        id,
        title,
        goal: nonEmptyString(obj.goal),
        tasks: taskList,
      });
    }
  }

  if (!goalTitle && !goalLine && Object.keys(tasks).length === 0 && threads.length === 0) {
    return null;
  }
  return { goalTitle, goalLine, tasks, threads };
}

function parseBoardMessages(
  raw: { text: string; tailTruncated: boolean } | null,
): { messages: SwarmMessage[]; totalMessages: number; truncated: boolean } {
  if (!raw) return { messages: [], totalMessages: 0, truncated: false };
  const parsed: SwarmMessage[] = [];
  let fallbackSeq = 0;

  for (const line of raw.text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      const candidate = JSON.parse(trimmed);
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      obj = candidate as Record<string, unknown>;
    } catch {
      // Ignore partial or malformed lines written concurrently by agy.
      continue;
    }
    fallbackSeq += 1;
    const seq = typeof obj.seq === "number" && Number.isInteger(obj.seq) ? obj.seq : fallbackSeq;
    const agent = nonEmptyString(obj.agent) ?? "unknown";
    const rawText = typeof obj.text === "string" ? obj.text : "";
    const text =
      rawText.length > MAX_MESSAGE_TEXT_CHARS
        ? `${rawText.slice(0, MAX_MESSAGE_TEXT_CHARS - 3)}...`
        : rawText;
    parsed.push({
      seq,
      agent,
      text,
      time: nonEmptyString(obj.time),
      kind: nonEmptyString(obj.kind),
      channel: nonEmptyString(obj.channel),
    });
  }

  const totalMessages = parsed.length;
  const truncated = raw.tailTruncated || totalMessages > MAX_MESSAGES;
  const messages = totalMessages > MAX_MESSAGES ? parsed.slice(-MAX_MESSAGES) : parsed;
  return { messages, totalMessages, truncated };
}

export function readSwarmBoard(providerThreadId: string, options?: ReadSwarmBoardOptions): SwarmBoardSnapshot {
  const trimmedId = providerThreadId.trim();
  if (!UUID_PATTERN.test(trimmedId)) {
    return emptySwarmBoardSnapshot(null);
  }

  const maxBytes = options?.maxFileBytes ?? MAX_JSON_FILE_BYTES;
  const appDataDir = resolveSwarmAppDataDir(options);
  const swarmDir = join(appDataDir, "brain", trimmedId, ".system_generated", "swarm");
  if (!existsSync(swarmDir)) {
    return emptySwarmBoardSnapshot(trimmedId);
  }

  const membersRaw = parseJsonObject(readBoundedJsonText(join(swarmDir, "members.json"), maxBytes));
  const boardRaw = readBoundedTailLines(join(swarmDir, "board.jsonl"), maxBytes);
  const swarmRaw = parseJsonObject(readBoundedJsonText(join(swarmDir, "swarm.json"), maxBytes));
  const planRaw = parseJsonObject(readBoundedJsonText(join(swarmDir, "plan.json"), maxBytes));

  const hasSwarmFiles = membersRaw !== null || boardRaw !== null || swarmRaw !== null;
  if (!hasSwarmFiles) {
    return emptySwarmBoardSnapshot(trimmedId);
  }

  const { title, members } = parseMembers(membersRaw);
  const { messages, totalMessages, truncated } = parseBoardMessages(boardRaw);
  const plan = parsePlan(planRaw);

  return {
    exists: true,
    providerThreadId: trimmedId,
    title,
    swarmId: nonEmptyString(swarmRaw?.swarm_id) ?? trimmedId,
    createdAt: nonEmptyString(swarmRaw?.created_at),
    plan,
    members,
    messages,
    totalMessages,
    truncated,
  };
}

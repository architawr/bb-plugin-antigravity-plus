import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { experimental_hostToolchain } from "@get-bb/plugin-sdk/process";
import { AGY_ACP_PROXY_FLAG, AGY_ACP_PROXY_STATE_DIR_ENV, AGY_ACP_PROXY_SWITCH_ENV } from "./acp-proxy.ts";
import { resolveAgyProfile } from "./agy-fork.ts";

const ARTIFACT_DIGEST_RE = /^[a-f0-9]{64}$/u;

function resolveProxyHostFile(hostFile: string): string | null {
  if (existsSync(hostFile)) return hostFile;
  const digestDir = dirname(hostFile);
  if (!ARTIFACT_DIGEST_RE.test(basename(digestDir))) {
    // Preserve non-artifact paths (such as synthetic test paths or direct source checkouts).
    return hostFile;
  }
  const pluginCacheDir = dirname(digestDir);
  const fileName = basename(hostFile);
  let entries;
  try {
    entries = readdirSync(pluginCacheDir, { withFileTypes: true });
  } catch {
    return null;
  }
  let bestPath: string | null = null;
  let bestMtimeMs = -1;
  for (const entry of entries) {
    if (!entry.isDirectory() || !ARTIFACT_DIGEST_RE.test(entry.name)) continue;
    const candidate = join(pluginCacheDir, entry.name, fileName);
    try {
      const stat = statSync(candidate);
      if (!stat.isFile()) continue;
      if (stat.mtimeMs > bestMtimeMs || (stat.mtimeMs === bestMtimeMs && (bestPath === null || candidate > bestPath))) {
        bestMtimeMs = stat.mtimeMs;
        bestPath = candidate;
      }
    } catch {
      continue;
    }
  }
  return bestPath;
}

function isAbsoluteDirectory(path: string): boolean {
  return isAbsolute(path) && (process.platform !== "win32" || parse(path).root.length > 1);
}

function agyInstallerPath(env: NodeJS.ProcessEnv): string {
  const localAppData = env.LOCALAPPDATA ?? "";
  return process.platform === "win32"
    ? resolve(isAbsoluteDirectory(localAppData) ? localAppData : join(homedir(), "AppData", "Local"), "agy", "bin", "agy.exe")
    : resolve(homedir(), ".local", "bin", "agy");
}

export function resolveAntigravityCommand(command: string, options?: { cwd?: string; env?: NodeJS.ProcessEnv }): string | null {
  if (command !== "agy") return experimental_hostToolchain.resolve(command, options);
  const env = options?.env ?? process.env;
  const hostEnv = experimental_hostToolchain.environment(env);
  for (const entry of (hostEnv.PATH ?? "").split(delimiter)) {
    const dir = process.platform === "win32" ? entry.replace(/^"(.*)"$/, "$1") : entry;
    if (!isAbsoluteDirectory(dir)) continue;
    // The SDK searches cwd first for bare executable names on Windows.
    const found = experimental_hostToolchain.resolve(join(dir, command), { env });
    if (found) return found;
  }
  const candidate = agyInstallerPath(env);
  try {
    if (!statSync(candidate).isFile()) return null;
    accessSync(candidate, constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

export const BB_ANTIGRAVITY_GEMINI_DIR_ENV = "BB_ANTIGRAVITY_GEMINI_DIR";
export const BB_ANTIGRAVITY_APP_DATA_DIR_ENV = "BB_ANTIGRAVITY_APP_DATA_DIR";

function nonEmptyEnvValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function hasFlag(args: readonly unknown[], names: readonly string[]): boolean {
  return args.some(arg => {
    if (typeof arg !== "string") return false;
    return names.some(name => arg === name || arg.startsWith(`${name}=`));
  });
}

export function resolveAntigravityProfileArgs(env: Record<string, unknown>, args: readonly unknown[] = []): string[] {
  const extraArgs: string[] = [];
  const geminiDir = nonEmptyEnvValue(env[BB_ANTIGRAVITY_GEMINI_DIR_ENV]);
  if (geminiDir !== null && !hasFlag(args, ["--gemini-dir", "--gemini_dir"])) {
    extraArgs.push("--gemini-dir", geminiDir);
  }
  const appDataDir = nonEmptyEnvValue(env[BB_ANTIGRAVITY_APP_DATA_DIR_ENV]);
  if (appDataDir !== null && !hasFlag(args, ["--app-data-dir", "--app_data_dir"])) {
    extraArgs.push("--app-data-dir", appDataDir);
  }
  return extraArgs;
}

function applyProfileFlags(spec: Record<string, any>, env: Record<string, unknown>): void {
  if (!Array.isArray(spec.args) || spec.args[0] !== "acp") return;
  const extraArgs = resolveAntigravityProfileArgs(env, spec.args);
  if (extraArgs.length > 0) {
    spec.args = [...spec.args, ...extraArgs];
  }
}

export function resolveAntigravityLaunchProfile(request: any, home = homedir()) {
  const params = request?.params;
  const options = params?.options;
  const spec = options?.providerOptions?.acpLaunchSpec;
  const args = Array.isArray(spec?.args)
    ? spec.args.filter((arg: unknown): arg is string => typeof arg === "string")
    : [];
  const env = { ...process.env, ...spec?.env, ...options?.envVars };
  const childHome = nonEmptyEnvValue(spec?.env?.[process.platform === "win32" ? "USERPROFILE" : "HOME"]);
  const sessionHome = nonEmptyEnvValue(options?.envVars?.[process.platform === "win32" ? "USERPROFILE" : "HOME"]);
  return resolveAgyProfile([...args, ...resolveAntigravityProfileArgs(env, args)], sessionHome ?? childHome ?? home);
}

export interface AgyAcpProxyLaunch {
  /** The host artifact, which runs the proxy when started with AGY_ACP_PROXY_FLAG. */
  hostFile: string;
  /** Where the proxy keeps per-session state; omit to keep it in memory only. */
  stateDir?: string;
}

// Resolve on the agent host, where the CLI is installed, rather than the BB server.
// With `proxy`, session launches go through the plugin's ACP proxy (acp-proxy.ts);
// provider/* requests keep calling agy directly, because health checks run `<command> --version`
// and usage runs `<command> -p /usage`. `BB_AGY_ACP_PROXY=0` in the bridge environment, the
// request's envVars, or the launch env skips the proxy (troubleshooting only).
export function resolveAntigravityLaunchSpec(request: any, proxy?: AgyAcpProxyLaunch): void {
  const params = request?.params;
  const method = typeof request?.method === "string" ? request.method : "";
  const targets = [
    { options: params?.providerOptions, envVars: params?.envVars },
    { options: params?.options?.providerOptions, envVars: params?.options?.envVars },
  ];
  for (const { options, envVars } of targets) {
    const spec = options?.acpLaunchSpec;
    if (!spec || typeof spec !== "object") continue;
    const mergedEnv = { ...process.env, ...spec.env, ...envVars };
    const isAgy = spec.command === "agy";
    if (isAgy) {
      const command = resolveAntigravityCommand(spec.command, { env: process.env });
      if (command) spec.command = command;
      // A missing host install must not trigger a second search on the session PATH.
      else if (!method.startsWith("provider/")) spec.command = agyInstallerPath(process.env);
    }
    applyProfileFlags(spec, mergedEnv);
    const switches = [process.env, params?.envVars, params?.options?.envVars, spec.env];
    if (switches.some(env => env?.[AGY_ACP_PROXY_SWITCH_ENV] === "0")) continue;
    if (!isAgy || !proxy || method.startsWith("provider/")) continue;
    const proxyHostFile = resolveProxyHostFile(proxy.hostFile);
    if (!proxyHostFile) continue;
    spec.args = [proxyHostFile, AGY_ACP_PROXY_FLAG, spec.command, ...(Array.isArray(spec.args) ? spec.args : [])];
    spec.command = process.execPath;
    spec.env = {
      ...spec.env,
      ELECTRON_RUN_AS_NODE: "1",
      ...(proxy.stateDir ? { [AGY_ACP_PROXY_STATE_DIR_ENV]: proxy.stateDir } : {}),
    };
  }
}

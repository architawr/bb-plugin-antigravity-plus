import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { experimental_hostToolchain } from "@get-bb/plugin-sdk/process";
import { AGY_ACP_PROXY_FLAG, AGY_ACP_PROXY_STATE_DIR_ENV, AGY_ACP_PROXY_SWITCH_ENV } from "./acp-proxy.ts";

export function resolveAntigravityCommand(command: string, options?: { cwd?: string; env?: NodeJS.ProcessEnv }): string | null {
  const resolved = experimental_hostToolchain.resolve(command, options);
  if (resolved || command !== "agy") return resolved;
  const env = options?.env ?? process.env;
  const candidate = process.platform === "win32"
    ? join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "agy", "bin", "agy.exe")
    : join(homedir(), ".local", "bin", "agy");
  try {
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

function applyProfileFlags(spec: Record<string, any>, env: Record<string, unknown>): void {
  if (!Array.isArray(spec.args) || spec.args[0] !== "acp") return;
  const extraArgs: string[] = [];
  const geminiDir = nonEmptyEnvValue(env[BB_ANTIGRAVITY_GEMINI_DIR_ENV]);
  if (geminiDir !== null && !hasFlag(spec.args, ["--gemini-dir", "--gemini_dir"])) {
    extraArgs.push("--gemini-dir", geminiDir);
  }
  const appDataDir = nonEmptyEnvValue(env[BB_ANTIGRAVITY_APP_DATA_DIR_ENV]);
  if (appDataDir !== null && !hasFlag(spec.args, ["--app-data-dir", "--app_data_dir"])) {
    extraArgs.push("--app-data-dir", appDataDir);
  }
  if (extraArgs.length > 0) {
    spec.args = [...spec.args, ...extraArgs];
  }
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
      const command = resolveAntigravityCommand(spec.command, { cwd: spec.cwd, env: mergedEnv });
      if (command) spec.command = command;
    }
    applyProfileFlags(spec, mergedEnv);
    const switches = [process.env, params?.envVars, params?.options?.envVars, spec.env];
    if (switches.some(env => env?.[AGY_ACP_PROXY_SWITCH_ENV] === "0")) continue;
    if (!isAgy || !proxy || method.startsWith("provider/")) continue;
    spec.args = [proxy.hostFile, AGY_ACP_PROXY_FLAG, spec.command, ...(Array.isArray(spec.args) ? spec.args : [])];
    spec.command = process.execPath;
    if (proxy.stateDir) spec.env = { ...spec.env, [AGY_ACP_PROXY_STATE_DIR_ENV]: proxy.stateDir };
  }
}

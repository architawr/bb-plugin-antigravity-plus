import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import {
  experimental_downloadedInstallerCommand,
  experimental_installationVerification,
} from "@get-bb/plugin-sdk/provider-bridge";
import { isAgyVersionTooOld, MIN_AGY_ACP_VERSION, parseAgyVersion } from "./acp-proxy.ts";
import { resolveAntigravityCommand } from "./cli.ts";
import { readAntigravityProviderUsage } from "./usage.ts";

type AntigravityProviderUsageResult = Awaited<ReturnType<typeof readAntigravityProviderUsage>>;

const execFileAsync = promisify(nodeExecFile);

export const MINIMUM_SUPPORTED_AGY_VERSION = MIN_AGY_ACP_VERSION.join(".");
export const AGY_UNIX_INSTALLER_URL = "https://antigravity.google/cli/install.sh";
export const AGY_WINDOWS_INSTALLER_URL = "https://antigravity.google/cli/install.ps1";
export const AGY_LOGIN_COMMAND = "agy acp --login";

export interface MaintenanceProbeOptions {
  command?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  resolveCommand?: (command: string, options?: { cwd?: string; env?: NodeJS.ProcessEnv }) => string | null;
  execFile?: (command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number }) => Promise<{ stdout: string; stderr: string }>;
  checkUsage?: () => Promise<AntigravityProviderUsageResult>;
}

export interface AntigravityInstallationStatus {
  executableName: string;
  executablePath: string | null;
  installed: boolean;
  installSource: "notInstalled" | "npmGlobal" | "external";
  currentVersion: string | null;
  latestVersion: string | null;
  minimumSupportedVersion: string | null;
  npmPackageName: string | null;
  npmGlobalPackageVersion: string | null;
  installAction: { kind: "install" | "update"; label: "Install" | "Update"; command: string } | null;
  needsUpdate: boolean;
  versionUnsupported: boolean;
}

export interface AntigravityHealthResult {
  supported: true;
  health: {
    status: "ready" | "not_installed" | "unauthenticated" | "expired" | "unsupported_version" | "unknown";
    statusMessage: string | null;
    accountEmail: string | null;
    planLabel: string | null;
    installedVersion: string | null;
    minimumSupportedVersion: string | null;
    canInstall: boolean;
    canUpdate: boolean;
    loginCommand: string | null;
    localLoginCommand?: string | null;
  };
}

export type AntigravityInstallationRunResult =
  | { available: false; message: string }
  | {
      available: true;
      command: { command: string; args: string[]; displayCommand: string };
      verification:
        | { kind: "installed" }
        | { kind: "version_changed"; previousVersion: string }
        | { kind: "version_at_least"; version: string };
    };

function installerCommand(platform?: NodeJS.Platform) {
  return experimental_downloadedInstallerCommand(AGY_UNIX_INSTALLER_URL, {
    platform,
    powershellUrl: AGY_WINDOWS_INSTALLER_URL,
  });
}

export async function readAntigravityInstallationStatus(
  options: MaintenanceProbeOptions = {},
): Promise<AntigravityInstallationStatus> {
  const requested = options.command || "agy";
  const env = options.env ?? process.env;
  const resolveCommand = options.resolveCommand ?? resolveAntigravityCommand;
  const run = options.execFile ?? ((cmd, args, opts) => execFileAsync(cmd, args, { ...opts, encoding: "utf8" }));

  const executablePath = requested === "agy"
    ? resolveCommand(requested, { cwd: options.cwd, env })
    : requested;

  if (!executablePath) {
    const install = installerCommand(options.platform);
    return {
      executableName: "agy",
      executablePath: null,
      installed: false,
      installSource: "notInstalled",
      currentVersion: null,
      latestVersion: null,
      minimumSupportedVersion: MINIMUM_SUPPORTED_AGY_VERSION,
      npmPackageName: null,
      npmGlobalPackageVersion: null,
      installAction: { kind: "install", label: "Install", command: install.displayCommand },
      needsUpdate: false,
      versionUnsupported: false,
    };
  }

  let currentVersion: string | null = null;
  let versionUnsupported = false;
  try {
    const { stdout, stderr } = await run(executablePath, ["--version"], {
      cwd: options.cwd,
      env,
      timeout: 10_000,
    });
    const parsed = parseAgyVersion(`${stdout}\n${stderr}`);
    if (parsed) {
      currentVersion = parsed.join(".");
      versionUnsupported = isAgyVersionTooOld(parsed);
    }
  } catch {
    currentVersion = null;
  }

  return {
    executableName: "agy",
    executablePath,
    installed: true,
    installSource: "external",
    currentVersion,
    latestVersion: null,
    minimumSupportedVersion: MINIMUM_SUPPORTED_AGY_VERSION,
    npmPackageName: null,
    npmGlobalPackageVersion: null,
    installAction: { kind: "update", label: "Update", command: "agy update" },
    needsUpdate: versionUnsupported,
    versionUnsupported,
  };
}

export async function planAntigravityInstallationRun(
  action: "install" | "update",
  options: MaintenanceProbeOptions = {},
): Promise<AntigravityInstallationRunResult> {
  const status = await readAntigravityInstallationStatus(options);
  if (action === "install") {
    return {
      available: true,
      command: installerCommand(options.platform),
      verification: experimental_installationVerification(status, "install"),
    };
  }
  if (!status.installed || !status.executablePath) {
    return {
      available: false,
      message: "Antigravity CLI (agy) is not installed on this machine.",
    };
  }
  return {
    available: true,
    command: {
      command: status.executablePath,
      args: ["update"],
      displayCommand: "agy update",
    },
    verification: experimental_installationVerification(status, "update"),
  };
}

export async function readAntigravityHealth(
  options: MaintenanceProbeOptions = {},
): Promise<AntigravityHealthResult> {
  const status = await readAntigravityInstallationStatus(options);
  if (!status.installed) {
    return {
      supported: true,
      health: {
        status: "not_installed",
        statusMessage: `Install Antigravity CLI (agy) ${MINIMUM_SUPPORTED_AGY_VERSION} or later on this machine.`,
        accountEmail: null,
        planLabel: null,
        installedVersion: null,
        minimumSupportedVersion: MINIMUM_SUPPORTED_AGY_VERSION,
        canInstall: true,
        canUpdate: false,
        loginCommand: AGY_LOGIN_COMMAND,
        localLoginCommand: AGY_LOGIN_COMMAND,
      },
    };
  }
  if (status.versionUnsupported) {
    return {
      supported: true,
      health: {
        status: "unsupported_version",
        statusMessage: `Antigravity CLI ${status.currentVersion} is older than ${MINIMUM_SUPPORTED_AGY_VERSION}. Run \`agy update\` on this machine.`,
        accountEmail: null,
        planLabel: null,
        installedVersion: status.currentVersion,
        minimumSupportedVersion: MINIMUM_SUPPORTED_AGY_VERSION,
        canInstall: false,
        canUpdate: true,
        loginCommand: AGY_LOGIN_COMMAND,
        localLoginCommand: AGY_LOGIN_COMMAND,
      },
    };
  }
  try {
    const usageResult = options.checkUsage
      ? await options.checkUsage()
      : await readAntigravityProviderUsage({
          command: status.executablePath ?? options.command ?? "agy",
          cwd: options.cwd,
          env: options.env,
          ...(options.execFile ? { execFile: options.execFile as any } : {}),
        });
    const usage = usageResult.usage as { status?: string; accountEmail?: string | null; planLabel?: string | null } | undefined;
    if (usage?.status === "unauthenticated") {
      return {
        supported: true,
        health: {
          status: "unauthenticated",
          statusMessage: `Sign in to Antigravity CLI to start coding. Run \`${AGY_LOGIN_COMMAND}\` on this machine, then retry.`,
          accountEmail: null,
          planLabel: null,
          installedVersion: status.currentVersion,
          minimumSupportedVersion: MINIMUM_SUPPORTED_AGY_VERSION,
          canInstall: false,
          canUpdate: true,
          loginCommand: AGY_LOGIN_COMMAND,
          localLoginCommand: AGY_LOGIN_COMMAND,
        },
      };
    }
    if (usage?.status === "expired") {
      return {
        supported: true,
        health: {
          status: "expired",
          statusMessage: `Your Antigravity CLI sign-in expired. Run \`${AGY_LOGIN_COMMAND}\` on this machine to refresh it.`,
          accountEmail: null,
          planLabel: null,
          installedVersion: status.currentVersion,
          minimumSupportedVersion: MINIMUM_SUPPORTED_AGY_VERSION,
          canInstall: false,
          canUpdate: true,
          loginCommand: AGY_LOGIN_COMMAND,
          localLoginCommand: AGY_LOGIN_COMMAND,
        },
      };
    }
    if (usage?.status === "ok") {
      return {
        supported: true,
        health: {
          status: "ready",
          statusMessage: null,
          accountEmail: usage.accountEmail ?? null,
          planLabel: usage.planLabel ?? null,
          installedVersion: status.currentVersion,
          minimumSupportedVersion: MINIMUM_SUPPORTED_AGY_VERSION,
          canInstall: false,
          canUpdate: true,
          loginCommand: AGY_LOGIN_COMMAND,
          localLoginCommand: AGY_LOGIN_COMMAND,
        },
      };
    }
  } catch {
    // Fall through to ready if usage probe is transiently unavailable while CLI is valid.
  }
  return {
    supported: true,
    health: {
      status: "ready",
      statusMessage: null,
      accountEmail: null,
      planLabel: null,
      installedVersion: status.currentVersion,
      minimumSupportedVersion: MINIMUM_SUPPORTED_AGY_VERSION,
      canInstall: false,
      canUpdate: true,
      loginCommand: AGY_LOGIN_COMMAND,
      localLoginCommand: AGY_LOGIN_COMMAND,
    },
  };
}

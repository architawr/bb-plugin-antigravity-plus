import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { ANTIGRAVITY_ACP_DIALECT_ID } from "./dialect.ts";
import { emptySwarmBoardSnapshot, swarmHostContract, swarmRpcContract } from "./swarm-contract.ts";
import { registerAntigravityUsageSource } from "./usage.ts";

export { swarmRpcContract };

const PROVIDER_ID = "antigravity-plus";
const MAX_THREAD_IDENTITY_CACHE = 256;

const launchSpec = {
  displayName: "Antigravity Plus",
  command: "agy",
  args: ["acp", "--disable-telemetry"],
  env: {},
};

interface CachedThreadTarget {
  providerThreadId: string;
  hostId: string;
}

export default async function antigravity(bb: BbPluginApi) {
  registerAntigravityUsageSource(bb);

  if (bb.hosts?.experimental_client && bb.rpc?.register) {
    const hostClient = bb.hosts.experimental_client({ contract: swarmHostContract });
    const threadIdentityCache = new Map<string, CachedThreadTarget>();

    function rememberThreadTarget(threadId: string, target: CachedThreadTarget): void {
      if (threadIdentityCache.size >= MAX_THREAD_IDENTITY_CACHE) {
        const oldest = threadIdentityCache.keys().next().value;
        if (oldest) threadIdentityCache.delete(oldest);
      }
      threadIdentityCache.set(threadId, target);
    }

    async function resolveThreadTarget(
      threadId: string,
      signal: AbortSignal,
    ): Promise<CachedThreadTarget | null> {
      const cached = threadIdentityCache.get(threadId);
      if (cached) return cached;

      let detail: any;
      try {
        detail = await bb.sdk.threads.get({ threadId, include: "environment", signal });
      } catch {
        return null;
      }

      const thread = detail?.thread ?? detail;
      if (!thread || thread.providerId !== PROVIDER_ID) {
        return null;
      }

      let hostId: string | null =
        typeof detail?.environment?.hostId === "string" && detail.environment.hostId.length > 0
          ? detail.environment.hostId
          : null;

      if (!hostId && typeof thread.environmentId === "string" && thread.environmentId.length > 0) {
        try {
          const envDetail: any = await bb.sdk.environments.get({
            environmentId: thread.environmentId,
            signal,
          });
          const envObj = envDetail?.environment ?? envDetail;
          if (typeof envObj?.hostId === "string" && envObj.hostId.length > 0) {
            hostId = envObj.hostId;
          }
        } catch {
          return null;
        }
      }

      if (!hostId) return null;

      let providerThreadId: string | null = null;
      try {
        const identityEvents = await bb.sdk.threads.events.list({
          threadId,
          types: ["thread/identity"],
          order: "desc",
          limit: "1",
          signal,
        });
        const first = identityEvents[0] as { data?: { providerThreadId?: unknown } } | undefined;
        if (typeof first?.data?.providerThreadId === "string" && first.data.providerThreadId.length > 0) {
          providerThreadId = first.data.providerThreadId;
        }
      } catch {
        return null;
      }

      if (!providerThreadId) return null;
      const target = { providerThreadId, hostId };
      rememberThreadTarget(threadId, target);
      return target;
    }

    bb.rpc.register(swarmRpcContract, {
      async getSwarmBoard({ threadId }, context) {
        const target = await resolveThreadTarget(threadId, context.experimental_signal);
        if (!target) return emptySwarmBoardSnapshot(null);
        try {
          return await hostClient.call(
            "readSwarmBoard",
            { providerThreadId: target.providerThreadId },
            { hostId: target.hostId, signal: context.experimental_signal },
          );
        } catch (error) {
          bb.log?.debug?.(
            `readSwarmBoard failed for ${threadId}: ${error instanceof Error ? error.message : String(error)}`,
          );
          return emptySwarmBoardSnapshot(target.providerThreadId);
        }
      },
    });

    bb.events?.on?.("experimental_thread.events", ({ thread }) => {
      if (thread.providerId === PROVIDER_ID) {
        bb.rpc.experimental_invalidate([`swarm:${thread.id}`]);
      }
    });
    bb.events?.on?.("thread.deleted", ({ thread }) => {
      threadIdentityCache.delete(thread.id);
    });
    bb.onDispose?.(() => {
      threadIdentityCache.clear();
    });
  }

  const settings = bb.settings.define({
    autoApprove: {
      type: "boolean",
      label: "Automatically approve ACP permission requests",
      description: "Automatically answer Antigravity permission requests in Accept edits mode. Applies to new turns.",
      default: false,
    },
    promptOnSandboxEscape: {
      type: "boolean",
      label: "Prompt on sandbox escapes when auto-approving",
      description: "When automatic approval is enabled in Accept edits mode, still ask for confirmation if a command requests execution outside the CLI sandbox.",
      default: true,
    },
    sandbox: {
      type: "boolean",
      label: "Request CLI terminal sandbox",
      description: "Add --sandbox for new threads. Otherwise use CLI settings. Requires a supported OS; the CLI may fall back to approval prompts. Full access can approve requests outside the sandbox.",
      default: false,
    },
    processPerSession: {
      type: "boolean",
      label: "Isolate each thread in its own worker process",
      description: "Add --process-per-session so each Antigravity thread runs in its own CLI worker process.",
      default: true,
    },
    subagentsDisabled: {
      type: "boolean",
      label: "Disable provider subagents",
      description: "Prevent Antigravity CLI from using its native subagent tools so agents use bb for delegation.",
      default: false,
    },
    commandDescriptionsEnabled: {
      type: "boolean",
      label: "Show command descriptions",
      description: "Display Antigravity tool summaries on command execution cards.",
      default: true,
    },
    autoOpenSwarmBoard: {
      type: "boolean",
      label: "Automatically open Swarm board",
      description: "Open the Swarm tab in the thread side panel automatically when an Antigravity swarm starts.",
      default: true,
    },
    enabled: {
      type: "boolean",
      label: "Enable Antigravity Plus",
      description: "Show Antigravity Plus in the provider picker. Existing running turns are not stopped.",
      default: true,
    },
  });
  const register = () => bb.providers.register({
    id: PROVIDER_ID,
    displayName: "Antigravity Plus",
    icon: "./assets/provider.svg",
    family: "antigravity",
    strings: {
      signInHint: "Run `agy acp --login` on this machine, then retry.",
      expiredHint: "Run `agy acp --login` on this machine to refresh your sign-in.",
      installUrl: "https://antigravity.google/docs/getting-started?tab=cli",
      planModeCopy: "Antigravity will research and plan before editing files.",
    },
    experimental_bridgeOptions: {
      acpLaunchSpec: launchSpec,
      acpDialect: ANTIGRAVITY_ACP_DIALECT_ID,
    },
    deriveProviderOptions({ settings }) {
      return {
        autoApprove: settings.autoApprove === true,
        promptOnSandboxEscape: settings.promptOnSandboxEscape !== false,
        providerSubagentsEnabled: settings.subagentsDisabled !== true,
        commandDescriptionsEnabled: settings.commandDescriptionsEnabled !== false,
        acpDialect: ANTIGRAVITY_ACP_DIALECT_ID,
        acpLaunchSpec: {
          ...launchSpec,
          args: [
            ...launchSpec.args,
            ...(settings.processPerSession !== false ? ["--process-per-session"] : []),
            ...(settings.sandbox === true ? ["--sandbox"] : []),
          ],
        },
      };
    },
    experimental_nativeSkillRoots: {
      user: [
        ".gemini/antigravity-cli/skills",
        { path: ".gemini/antigravity-cli/builtin/skills", namePrefix: "antigravity:" },
        ".gemini/skills",
        ".gemini/config/skills",
      ],
      project: [
        { path: ".agents/skills", ancestors: true },
        ".agent/skills",
      ],
    },
    experimental_visibility: "always",
    maintenance: { health: true, usage: true, installation: true },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      fork: "tip",
      supportsManualCompaction: true,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["accept-edits", "full"],
      reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
    },
    composerActions: [],
    models: { fallback: [], scope: "host" },
    env: {
      passthrough: [
        "BB_ANTIGRAVITY_GEMINI_DIR",
        "BB_ANTIGRAVITY_APP_DATA_DIR",
        "BB_AGY_ACP_PROXY",
      ],
    },
  });
  let registration = (await settings.get()).enabled ? register() : undefined;
  settings.onChange(({ enabled }) => {
    if (Boolean(registration) === enabled) return;
    registration?.dispose();
    registration = enabled ? register() : undefined;
  });
}

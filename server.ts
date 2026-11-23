import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { ANTIGRAVITY_ACP_DIALECT_ID } from "./dialect.ts";
import { registerAntigravityUsageSource } from "./usage.ts";

const launchSpec = {
  displayName: "Antigravity Plus",
  command: "agy",
  args: ["acp", "--disable-telemetry"],
  env: {},
};

export default async function antigravity(bb: BbPluginApi) {
  registerAntigravityUsageSource(bb);
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
    enabled: {
      type: "boolean",
      label: "Enable Antigravity Plus",
      description: "Show Antigravity Plus in the provider picker. Existing running turns are not stopped.",
      default: true,
    },
  });
  const register = () => bb.providers.register({
    id: "antigravity-plus",
    displayName: "Antigravity Plus",
    icon: "./assets/provider.svg",
    family: "antigravity",
    strings: {
      signInHint: "Run `agy acp --login` on this machine, then retry.",
      expiredHint: "Run `agy acp --login` on this machine to refresh your sign-in.",
      installUrl: "https://antigravity.google/docs/getting-started?tab=cli",
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
    models: { fallback: [], scope: "workspace" },
  });
  let registration = (await settings.get()).enabled ? register() : undefined;
  settings.onChange(({ enabled }) => {
    if (Boolean(registration) === enabled) return;
    registration?.dispose();
    registration = enabled ? register() : undefined;
  });
}


import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { ANTIGRAVITY_ACP_DIALECT_ID } from "./dialect.ts";
import { registerAntigravityUsageSource } from "./usage.ts";

const launchSpec = {
  displayName: "Antigravity CLI",
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
      description: "Automatically answer Antigravity permission requests, including commands outside the CLI sandbox. Applies to new turns.",
      default: false,
    },
    sandbox: {
      type: "boolean",
      label: "Request CLI terminal sandbox",
      description: "Add --sandbox for new threads. Otherwise use CLI settings. Requires a supported OS; the CLI may fall back to approval prompts. Full access can approve requests outside the sandbox.",
      default: false,
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
    acpProxy: {
      type: "boolean",
      label: "Send bb instructions as the Antigravity system prompt",
      description: "Run new sessions through the plugin's ACP proxy, which gives bb's thread and skill instructions to Antigravity as its system prompt and re-applies them when a thread is reopened. Turn off to connect to agy acp directly. Applies to newly started sessions.",
      default: true,
    },
    enabled: {
      type: "boolean",
      label: "Enable Antigravity CLI",
      description: "Show Antigravity in the provider picker. Existing running turns are not stopped.",
      default: true,
    },
  });
  const register = () => bb.providers.register({
    id: "antigravity-cli",
    displayName: "Antigravity CLI",
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
        providerSubagentsEnabled: settings.subagentsDisabled !== true,
        commandDescriptionsEnabled: settings.commandDescriptionsEnabled !== false,
        agyAcpProxy: settings.acpProxy !== false,
        acpDialect: ANTIGRAVITY_ACP_DIALECT_ID,
        acpLaunchSpec: {
          ...launchSpec,
          args: [...launchSpec.args, ...(settings.sandbox === true ? ["--sandbox"] : [])],
        },
      };
    },
    experimental_nativeSkillRoots: {
      user: [".gemini/antigravity-cli/skills", ".gemini/skills", ".gemini/config/skills"],
      project: [".agents/skills", ".agent/skills"],
    },
    experimental_visibility: "always",
    maintenance: { health: true, usage: true, installation: false },
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


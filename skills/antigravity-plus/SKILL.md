---
name: antigravity-plus
description: Spawn, configure, or troubleshoot Antigravity Plus (antigravity-plus) threads in BB — models, reasoning levels (low, medium, high, xhigh, max), quota/usage windows, Build/Plan work modes, tip forking, manual compaction, permissions, and sign-in.
---

# Antigravity Plus provider

Threads on the `antigravity-plus` provider run the locally installed Antigravity CLI (`agy acp --disable-telemetry --process-per-session`) through BB's shared ACP bridge and the plugin's built-in ACP proxy.

## Models and reasoning levels

`antigravity-plus` discovers models and per-model reasoning efforts from the signed-in CLI (`low`, `medium`, `high`, `xhigh`, `max`, depending on the model). Fixed-effort models (such as `gpt-oss-120b-medium`) report `supportedReasoningEfforts: []`.

- Plain `bb provider models antigravity-plus` prints only the model table and `sessionOptions` (`mode`), omitting reasoning levels. Always pass `--json` when inspecting reasoning support:

```sh
bb provider models antigravity-plus --environment "$BB_ENVIRONMENT_ID" --json
```

- Pass reasoning level with `--reasoning-level` (not `--option`):

```sh
bb thread spawn --project "$BB_PROJECT_ID" --provider antigravity-plus --model gemini-4-neon --reasoning-level high --prompt "..."
```

## Work modes and permissions

Work mode and permissions are separate controls:

- **Work mode (`--option mode=<accept-edits|plan>`)**:
  - `accept-edits` (**Build**, default): implement the task under the active permission policy.
  - `plan` (**Plan**): research and plan before implementation (behavioral mode, not enforced read-only access).
- **Permission mode (`--permission-mode <accept-edits|full>`)**:
  - `accept-edits`: workspace edits run with native Accept edits behavior; remaining ACP permission requests surface in BB unless automatic approval is enabled.
  - `full`: BB's shared bridge auto-approves all ACP permission requests, including requests to run outside the CLI terminal sandbox.
  - `auto` is not supported by the shared ACP bridge.

## Requirements and settings

- `agy` 1.5.0+ must be installed and on `PATH` on the target host (`agy --version`, `agy acp --help`).
- Sign in on the target host with `agy acp --login`.
- Plugin settings (`Settings -> Installed plugins -> Antigravity Plus`):
  - `enabled` (default `true`): show or hide `antigravity-plus` in the provider picker.
  - `processPerSession` (default `true`): pass `--process-per-session` so each thread runs in its own CLI worker process.
  - `sandbox` (default `false`): pass `--sandbox` when starting new threads (when `false`, inherits CLI settings).
  - `autoApprove` (default `false`): automatically answer ACP permission requests in Accept edits mode on new turns.
  - `promptOnSandboxEscape` (default `true`): when `autoApprove` is enabled in Accept edits mode, still surface commands requesting execution outside the CLI sandbox for confirmation.
  - `subagentsDisabled` (default `false`): prevent Antigravity CLI from using its native subagent tools so agents delegate subtasks via BB child threads (`bb thread spawn --parent-self`).
  - `commandDescriptionsEnabled` (default `true`): show Antigravity's `toolSummary` description on command execution cards.
  - `autoOpenSwarmBoard` (default `true`): open the Swarm tab in the thread side panel automatically when an Antigravity swarm starts.

## Capabilities and limits

- **Native system prompts:** BB thread and skill instructions are passed through Antigravity's native `_meta.antigravity.systemPrompt.append` and re-applied on session reload or resume.
- **Tip forking (`fork: "tip"`):** Forks at the latest message through the ACP proxy (or natively if a future `agy` release advertises `sessionCapabilities.fork`). Mid-thread rewind is not supported.
- **Manual compaction:** Runs the CLI's native `/compact` (verified on `agy` 1.5.14+) and reports a failed compaction if the CLI passes `/compact` to the model instead.
- **Profile isolation:** `BB_ANTIGRAVITY_GEMINI_DIR` and `BB_ANTIGRAVITY_APP_DATA_DIR` forward as `--gemini-dir` and `--app-data-dir`.
- **Native skills:** Indexed from workspace `.agents/skills` (ancestors) and `.agent/skills`, and from user `~/.gemini/antigravity-cli/skills`, `~/.gemini/antigravity-cli/builtin/skills` (prefixed `antigravity:`), `~/.gemini/skills`, and `~/.gemini/config/skills`.
- **Native Swarm tab:** Threads running `/swarm` automatically expose a fixed **Swarm** tab in BB's right side panel showing the live roster, optional `plan.json` overview, and board messages, alongside clean timeline cards for `swarm`, `post_message`, `read_board`, and `swarm_wait`.
- **Usage limits:** Exposed via `provider/usage` and BB's `provider-usage.v1` RPC source (`bb settings usage --refresh --json`).

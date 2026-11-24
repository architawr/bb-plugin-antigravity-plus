# Provider capabilities

Verified against Antigravity CLI 1.5.16 on macOS (BB Desktop), 1.5.14 on Linux, and 1.5.1+ on Windows with BB SDK 0.6.157. A terminal CLI feature does not imply that the same feature is exposed through ACP.

| Feature | Current integration |
| --- | --- |
| Streaming, tools, approvals | Shared BB ACP bridge + custom `antigravity-plus` ACP dialect + built-in ACP proxy |
| Native Swarm board tab and pill | Fixed `Swarm` thread side-panel tab (visible only on threads with an active swarm, auto-opened via `autoOpenSwarmBoard`) plus a clickable Swarm context pill above the composer, reading `members.json`, `board.jsonl`, `swarm.json`, and optional `plan.json` read-only over host RPC |
| Swarm timeline cards | Clean tool cards for `swarm` (`title`, `add`, `kill`, `status`, `models`, `model`), `post_message`, `read_board`, and `swarm_wait` |
| Native system prompts | Lifted from `<system_instructions>` into `_meta.antigravity.systemPrompt.append` and re-applied on load and resume |
| Background commands & agents | Live BB `backgroundTask` composer banner and sidebar indicator for backgrounded `run_command`, `schedule`, and `invoke_subagent` tasks, with persisted restart recovery |
| Subagent delegation control | Optional `subagentsDisabled` setting instructs agents to delegate via BB (`bb thread spawn --parent-self`) and denies native subagent tool approvals |
| Command & tool presentation | Displays `toolSummary` descriptions (`commandDescriptionsEnabled`), clean command output and exit codes, destructive **Outside of sandbox** badges (`BypassSandbox`), and native delegation cards |
| Sandbox-escape guard | `acceptEditsApproval` setting (`ask` default, `auto-in-sandbox`, or `auto-all`) lets you auto-approve routine in-sandbox requests in Accept edits mode while still prompting for **Outside of sandbox** commands |
| Model catalog and reasoning | Host-scoped model cache (`models.scope: "host"`); supports `low`, `medium`, `high`, `xhigh`, and `max` depending on model and account |
| Plan/Build | One Mode selector mapped to native Plan/Accept edits with provider-specific `planModeCopy` and no duplicate Plan action |
| Accept edits / Full access | Shared bridge permission policy |
| Per-session worker isolation | Always passes `--process-per-session` to `agy acp` so each thread runs in its own CLI worker process |
| CLI terminal sandbox | Inherits CLI settings; optional `sandbox` flag adds `--sandbox` for new threads |
| Profile, proxy, and compaction env passthrough | Declares `env.passthrough` for `BB_ANTIGRAVITY_GEMINI_DIR`, `BB_ANTIGRAVITY_APP_DATA_DIR`, `BB_AGY_ACP_PROXY`, and `AGY_CLI_AUTO_COMPACT_OVERRIDE` (`agy 1.5.15+`) and forwards profile flags to `agy acp` |
| Auth-aware CLI health, install, and update | Implements `provider/health` (offline version + zero-turn `/usage` auth check guiding to `agy acp --login`), `provider/installation/status` (dynamic latest-version check via `install.sh` platform manifest when `checkUpdates: true`), and `provider/installation/run` (`Install` + `agy update`, minimum `1.5.0`) |
| Native skills in BB picker | Workspace `.agents/skills` (ancestors) and `.agent/skills`; user `.gemini/antigravity-cli/skills`, `.gemini/antigravity-cli/builtin/skills` (prefixed `antigravity:`), `.gemini/skills`, `.gemini/config/skills`, and `.agents/skills` (lowest-precedence cross-agent fallback) |
| Tip fork | Supported (`fork: "tip"`) through the ACP proxy (`VACUUM INTO` + ID swap + `brain/` copy), with automatic pass-through if `agy` advertises native `session/fork` |
| Manual and automatic compaction | Manual `/compact` (`agy 1.5.14+`) with failure detection if `/compact` reaches the model, plus automatic compaction visibility in BB's thread timeline from incremental `transcript.jsonl` `CHECKPOINT` detection |
| Subscription quota/usage | Supported via `agy -p "/usage" --output-format json`, `provider/usage`, and `provider-usage.v1` |
| Session rewind / message edit | Disabled: `agy acp` does not expose `session/rewind` |
| Native `ask_question` UI | Disabled: BB's shared ACP bridge does not map `ask_question` tool calls to interactive question cards |
| Native archive/rename | Disabled: `agy acp` does not expose archive or rename operations |
| BB Auto permission profile | Unsupported by the shared ACP bridge |

Run `node scripts/smoke.mjs --capabilities --features --modes` for a no-prompt protocol check in a temporary workspace. Set `BB_AGY_ACP_PROXY=0` to bypass the ACP proxy for troubleshooting.

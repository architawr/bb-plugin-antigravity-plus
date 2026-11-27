# Security and privacy

This is a full-trust BB provider plugin. Install only from a source you trust.

The plugin registers one provider (`antigravity-plus`), runs a local ACP proxy inside its host module, and exposes a read-only host RPC (`readSwarmBoard`) for its Swarm panel tab. It launches `agy` through BB's shared ACP bridge with fixed arguments and no shell command construction, credential parser, custom network listener, or plugin database. Bare `agy` resolves strictly from the agent host's own `PATH` (or default `agy` install path), ignoring thread workspace directories and session `PATH` overrides; do not place an untrusted `agy` binary earlier on the host `PATH`.

The plugin stores 5 settings in BB settings (`autoOpenSwarmBoard`, `commandDescriptionsEnabled`, `subagentsDisabled`, `acceptEditsApproval`, `sandbox`). Existing credentials remain managed by Antigravity CLI. The plugin does not copy or bundle credentials. Prompts, workspace context, and tool results are processed by Antigravity and its service under Google's policies; BB and the CLI retain their normal local conversation records and diagnostics. Passing `--disable-telemetry` does not disable service processing or those local records.

Antigravity's normal approval checks stay enabled in Accept edits mode by default (`acceptEditsApproval: "ask"`). Setting `acceptEditsApproval` to `"auto-in-sandbox"` answers routine ACP permission requests automatically on new turns while continuing to prompt for commands requesting execution outside the CLI sandbox. Setting `"auto-all"` or selecting Full access allows out-of-sandbox commands to approve automatically. Plan mode is agent behavior, not enforced read-only access. Only open trusted workspaces.

The Swarm tab reads `<appData>/brain/<conversationId>/.system_generated/swarm/` (`members.json`, `board.jsonl`, `swarm.json`, `plan.json`) read-only after validating `<conversationId>` as a strict UUID. It never writes to or deletes Antigravity's swarm files.

When BB checks for provider CLI updates (`provider/installation/status` with `checkUpdates: true`), the plugin makes a read-only HTTPS GET request to Google's official Antigravity CLI installer (`https://antigravity.google/cli/install.sh`) and the platform release manifest URL declared inside it (`<DOWNLOAD_BASE_URL>/manifests/<platform>.json`) to compare your installed `agy` version against the latest published version. No local data, credentials, or identifiers are sent, and network failures degrade silently to an unknown latest version.

Do not post credentials or raw private session logs in public issues. Report a suspected security issue privately through GitHub's private security reporting on [tymshe/bb-plugin-antigravity-plus](https://github.com/tymshe/bb-plugin-antigravity-plus).

## Local runtime state

- Background task tracking saves task/thread identifiers, descriptions, and transcript paths in `~/.bb/plugin-data/bb-plugin-antigravity-plus/background-tasks.json` (or the directory set by `BB_ANTIGRAVITY_TASK_STATE_DIR`). Records expire after three days when state is processed.
- Profile binding stores thread and session identifiers alongside SHA-256 hashes of the resolved profile directories in `~/.bb/plugin-data/bb-plugin-antigravity-plus/profile-bindings.json` (or `BB_ANTIGRAVITY_TASK_STATE_DIR`) so resuming a thread rejects profile drift across restarts. Raw credentials are never stored, and bindings are removed when a thread is discarded.
- The local ACP proxy caches per-session `<system_instructions>` text in the plugin's host data directory (`acp-proxy/instructions/`) so instructions re-apply on session resume and prunes stale files once their conversation database is gone.

Treat these files and CLI transcripts as private runtime data, and do not attach them to public issues without redacting them.

## Public contribution and release checks

Before committing, review `git diff --cached` and `git diff --cached --name-only`. Check for credentials, personal emails, local home paths, logs, account identifiers, and conversation data. Use synthetic fixtures and a clean workspace for screenshots.

Use a GitHub `noreply` commit email if you want email privacy, and verify it with `git var GIT_AUTHOR_IDENT` before committing.

Before releasing, run `npm run check`, `npm test`, `npm run build`, and `npm pack --dry-run --ignore-scripts`, and visually inspect every screenshot. Confirm the package excludes source maps, environment files, runtime state, and private diagnostics.

If a credential is exposed, revoke or rotate it immediately, then remove it and assess Git history cleanup.

## Why not generic ACP

BB's built-in generic ACP lets you chat with `agy`, then drops key pieces during daily work. Thread instructions do not survive session reloads, Fork and manual `/compact` are unavailable, `xhigh` and `max` reasoning are missing, `/swarm` prints a terminal-only `alt+s` hint, and command cards hide descriptions and sandbox-escape flags. Antigravity Provider + closes those gaps using your existing `agy` login with no extra API keys or manual ACP JSON.

## What you get

- **Persistent native system prompts.** Moves BB's `<system_instructions>` block into `_meta.antigravity.systemPrompt.append` and re-applies it on every session load and resume.
- **Live Swarm board inside BB.** Running `/swarm` opens a **Swarm** side-panel tab (`autoOpenSwarmBoard`, on by default) and shows a clickable context pill above the composer. Inspect the coordinator's `plan.json` overview, member roster with per-worker models, agent filters, and Markdown board posts, paired with readable timeline cards for `swarm`, `post_message`, `read_board`, and `swarm_wait`. Works over host RPC on local and remote machines.
- **Tip forking and manual compaction.** Fork any thread at its latest message (`fork: "tip"`), passing through to native `session/fork` if a future CLI release advertises it. Run manual `/compact` (`agy 1.5.14+`) from BB's Compact action with failure detection when the CLI sends `/compact` to the model instead.
- **Full reasoning and host-cached models.** Caches CLI models once per host (`models.scope: "host"`), exposes `low`, `medium`, `high`, `xhigh`, and `max` reasoning per model, and maps Build and Plan onto one mode selector.
- **Tool cards, background banners, and skills.** Shows `toolSummary` command titles, clean output and exit codes, **Outside of sandbox** badges, live background task banners with restart recovery, optional BB-thread delegation (`subagentsDisabled`), `antigravity:`-prefixed builtin skills in BB's picker, and 5-hour / 7-day quota windows (`Gemini`, `Claude/GPT`, `Argon`).
- **Process and profile isolation.** Runs `agy acp --process-per-session` by default, fixes macOS BB Desktop Electron spawns (`ELECTRON_RUN_AS_NODE=1`), and forwards `BB_ANTIGRAVITY_GEMINI_DIR` and `BB_ANTIGRAVITY_APP_DATA_DIR`.

## Permissions and safety

Build and Plan select Antigravity's native work modes. Plan guides agent behavior and does not enforce read-only access. Accept edits runs workspace edits natively and follows your `acceptEditsApproval` policy (`ask` by default, `auto-in-sandbox` to auto-approve routine commands while still asking on sandbox escapes, or `auto-all`). Full access auto-approves every ACP request through BB's shared bridge, including sandbox escapes.

The plugin inherits your CLI sandbox settings unless you enable the optional `--sandbox` toggle. See the [Antigravity sandbox docs](https://antigravity.google/docs/sandbox/?tab=cli).

## Onboarding and requirements

Requires BB 0.50+, Node.js 22+, Antigravity CLI 1.5.0+ (`1.5.14+` recommended for `/compact`) on the target host, and a signed-in Google account. Provider quota and charges apply. Remote hosts need their own CLI install and login.

Built-in health checks verify CLI version and sign-in without spending tokens, guide signed-out users to `agy acp --login`, and wire native **Install** and **Update** (`agy update`) actions in BB. Verified on macOS (BB Desktop), Linux, and Windows.

## Attribution and limits

MIT-licensed community fork of [ols-md/bb-plugin-antigravity](https://github.com/ols-md/bb-plugin-antigravity), building on work by `dionis-d`, `AdzeB`, and `mturilin`. Registers under `antigravity-plus` so it can run alongside existing installs.

Forking works at the latest message only. Mid-thread rewind, message editing, BB Auto permission mode, service tiers, native `ask_question` cards, and native archive/rename sync are not supported.

# Release and CI/CD playbook

This document defines the repeatable validation, release, and marketplace update workflow for **Antigravity Provider +** (`antigravity-plus`). Every check that caught drift during development is automated in `scripts/check-release.mjs` and runs on every PR and push to `main`.

## 1. Automated CI checks (every PR and push)

[`.github/workflows/checks.yml`](../.github/workflows/checks.yml) runs two read-only jobs on Ubuntu with Node 24:

1. **Typecheck, tests, and release gate:**
   - `npm ci --ignore-scripts`
   - `npm run check` (`tsc --noEmit`)
   - `npm test` (unit tests across proxy, fork, dialect, background tasks, subagents, maintenance, usage, Swarm reader, and provider contract)
   - `npm run check:release` (`scripts/check-release.mjs`), which enforces:
     - Runtime setting keys in `server.ts` match `README.md`, `SECURITY.md`, and `skills/antigravity-plus/SKILL.md`, with no retired setting names left behind.
     - Display name, provider ID, version (`package.json` and `scripts/smoke.mjs`), repository URL, `LICENSE` author, and `assets/icon.svg` SHA-256 hash match `docs/marketplace-entry.template.json`.
     - `PLUGIN_OVERVIEW.md` stays at or under 4,000 characters, has no `# ` H1 title, no raw HTML, no tables, no images, HTTPS links only, zero em dashes, and zero banned marketplace buzzwords.
     - Every marketplace screenshot exists in `assets/screenshots/`, is embedded in `README.md`, is at most 2 MiB, and is at least 1200 px wide (with no unreferenced leftover screenshots).
     - Zero local home paths (`/Users/...`, `/home/...`), personal email addresses, or stale upstream references in tracked files.
     - `npm pack --dry-run --ignore-scripts` contains all required entrypoints and excludes `.map`, `.env`, and scratch files.
   - `npm audit --audit-level=low`
   - `npm pack --dry-run --ignore-scripts`
2. **Secret scan:**
   - Pinned Gitleaks binary (`v8.30.1`, SHA-256 verified) scanning full Git history (`--redact`).

## 2. Local pre-release checklist (before tagging `vX.Y.Z`)

Run these steps locally on a machine with BB and a signed-in `agy` CLI:

1. **Sync BB SDK types and bump version (when cutting a new release):**
   ```sh
   bb plugin types .
   ```
   Update `version` in `package.json`, `clientInfo.version` in `scripts/smoke.mjs`, and `range` in `docs/marketplace-entry.template.json` if crossing a major/minor floor.
2. **Run the full local gate:**
   ```sh
   npm run check && npm test && npm run build && npm run check:release && npm run smoke -- --modes
   ```
3. **Install locally into BB and verify live surfaces:**
   ```sh
   bb plugin install --yes .
   bb provider models antigravity-plus --json
   ```
   Verify in BB Desktop:
   - Streaming reply, Build/Plan mode toggle, and reasoning levels (`low` through `max`).
   - Tip fork (`Fork`) and manual `/compact`.
   - `/swarm` run: Swarm side-panel tab auto-opens, composer pill toggles it, and swarm timeline cards render cleanly.
   - Provider maintenance (`health`, `usage`, `installation`) and Settings panel.
4. **Refresh screenshots whenever UI or Settings change:**
   - Capture at `1440x900` with DPR 2 (`2880x1800`, `>= 1200px` wide, `<= 2 MiB` each) in a clean non-private workspace with the sidebar collapsed.
   - Visually inspect every PNG before committing to confirm zero personal emails, local home paths, tokens, or unrelated thread titles.
   - Re-run `npm run check:release` to verify dimensions, file sizes, and `README.md` + `marketplace-entry.template.json` references.
5. **Check commit identity and tag immutably:**
   ```sh
   git var GIT_AUTHOR_IDENT
   git status -s
   git tag -a vX.Y.Z -m "Release vX.Y.Z"
   git push origin main --follow-tags
   ```
   Never move a published tag. Cut a patch version for follow-up fixes.

## 3. Updating the BB Community marketplace

Recheck `README.md`, `schema/marketplace-v2.schema.json`, and `marketplace.base.json` on the default branch of [get-bb/marketplace](https://github.com/get-bb/marketplace) before submitting.

A compatible release inside the existing `range` (such as `0.2.1` under `^0.2.0`) needs no marketplace PR unless you changed the display name, description, overview, icon, screenshots, tags, category, ownership, or version range.

When a marketplace PR is needed, fork `get-bb/marketplace`, create a branch, and sync only these files:

| Plugin checkout | Marketplace fork |
| --- | --- |
| `docs/marketplace-entry.template.json` | `entries/antigravity-plus.json` |
| `assets/icon.svg` | `icons/antigravity-plus-<8-char-sha256>.svg` |
| `PLUGIN_OVERVIEW.md` | `overview/antigravity-plus.md` |
| `assets/screenshots/*.png` | `screenshots/antigravity-plus/*.png` |

Validate inside the marketplace fork before opening the PR:

```sh
npm ci
npm run build
npm test
npm run gate:v1
npm run check
```

Commit only this plugin's entry, icon, overview, and screenshots, push your branch, and open the PR from `tymshe`.

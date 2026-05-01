# AGENTS.md

Work style: Be precise. No fluff. Pure information only.

## Project shape

- Linux-only Waybar status bar module for AI subscription usage tracking.
- Rust workspace with two crates:
  - `crates/openusage-plugin-engine/` — manifest loader, QuickJS runtime, host API.
  - `crates/openusage-waybar/` — CLI binary that emits Waybar JSON.
- `plugins/` — JavaScript plugins, one folder per provider, each with `plugin.json`, entry script, and `icon.svg`.

## Guardrails

- Bugs: add regression test when it fits.
- Keep files <~400 LOC; split/refactor as needed.
- Simplicity first: handle only important cases; no enterprise over-engineering.
- New functionality: small OR absolutely necessary.
- NEVER delete files or folders unless explicitly approved.

## Build / verify

- Build: `cargo build`
- Test: `cargo test`
- Run locally: `cargo run -p openusage-waybar -- <plugin-id>` (uses `./plugins/` in dev).
- List plugins: `cargo run -p openusage-waybar -- --list`

## Git

- Conventional branches (`feat|fix|refactor|build|ci|chore|docs|style|perf|test`).
- Safe by default: `git status/diff/log`. Push only when user asks.
- Destructive ops forbidden unless explicit (`reset --hard`, `clean`, `restore`, `rm`, …).
- Big review: `git --no-pager diff --color=never`.

## Error Handling

- Expected issues: explicit result types (`Result`).
- External systems (network, subprocess): wrap and propagate errors.
- Unexpected issues: fail loud; do not add silent fallbacks.

## Critical Thinking

- Fix root cause (not band-aid).
- Unsure: read more code; if still stuck, ask with short options (A/B/C).
- Conflicts: stop. call out; pick safer path.

## Plugin authoring notes

- In `plugin.json`, set `brandColor` to the provider's real brand color.
- Plugin SVG logos must use `currentColor` so icon theming works correctly.
- On any plugin change, audit plugin-exposed request/response fields against `crates/openusage-plugin-engine/src/host_api.rs` redaction lists and add/update tests for gaps.
- When updating ccusage version, update `CCUSAGE_VERSION` in `crates/openusage-plugin-engine/src/host_api.rs` and `docs/plugins/api.md`.

## Before Creating Pull Request

- Ensure `README.md` is updated when supported plugins change.
- Run `cargo test` and `cargo build`.

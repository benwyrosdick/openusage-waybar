# Contributing to OpenUsage Waybar

Contributions are welcome. Read this document before opening a PR.

## Philosophy

OpenUsage Waybar focuses on a single thing: surfacing AI coding subscription usage in a Linux status bar. Contributions that expand the scope beyond that, or that compromise the UX, will likely be closed.

If you're unsure whether your idea fits, open an issue first.

## Ground Rules

- No feature creep. If it's not about usage tracking in a status bar, it likely doesn't belong here.
- No AI-generated commit messages. Write your own.
- Test your changes locally with Waybar before opening a PR.
- Keep it simple. Don't over-engineer.
- One PR per concern. Don't bundle unrelated changes.

## License Agreement

By submitting a pull request, you agree that your contribution is licensed under the [MIT License](LICENSE) that covers this project.

## How to Contribute

### Fork and PR workflow

1. Fork the repo
2. Create a branch (`feat/my-change`, `fix/some-bug`, etc.)
3. Make your changes
4. Run `cargo build` and `cargo test` to verify nothing is broken
5. Open a PR against `main`

### Add a provider plugin

Each provider is a plugin. See the [Plugin API docs](docs/plugins/api.md) for the full spec.

1. Create a new folder under `plugins/` with your provider name
2. Add `plugin.json` (metadata) and `plugin.js` (implementation)
3. Add documentation in `docs/providers/`
4. Test it locally by running `cargo run -p openusage-waybar -- <plugin-id>` from the repo root
5. Open a PR with sample output showing it working

### Fix a bug

1. Reference the issue number in your PR
2. Describe the root cause and fix
3. Add a regression test if applicable

### Request a feature

Don't open a PR for large features without discussing first.

## Code Standards

- Rust for the engine and CLI (`crates/`)
- JavaScript for plugins (`plugins/`)
- Follow existing patterns in the codebase
- No new dependencies without justification

## Questions?

Open an issue using one of the issue templates.

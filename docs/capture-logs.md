# How to Capture Logs for a Bug Report

Use this when `openusage-waybar` is not working and you need to share debug info.

## 1) Run with verbose logging

Run the binary directly from a terminal with `RUST_LOG=debug`:

```sh
RUST_LOG=debug openusage-waybar <plugin-id> 2> openusage.log
```

The Waybar JSON goes to `stdout`, log lines go to `stderr`. The redirect above captures `stderr` to `openusage.log`.

If you want everything in one file:

```sh
RUST_LOG=debug openusage-waybar <plugin-id> > waybar-output.json 2> openusage.log
```

## 2) Reproduce the issue

Run the command once or twice — enough to capture the failure, but not so much that the log becomes noisy.

## 3) Attach `openusage.log` to your GitHub issue

Drag the file directly into your issue/comment.

## 4) Include this context

```text
What I expected:
What happened instead:
When it happened (local time + timezone):
Which provider was affected (Codex / Claude / Cursor / etc.):
openusage-waybar version (openusage-waybar --help):
Linux distro and Waybar version:
```

## Privacy note

Logs are redacted for common secrets, but review the file before sharing publicly.

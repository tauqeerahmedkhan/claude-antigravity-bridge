# Changelog

## v1.3.0 — 2026-10-09

**Antigravity reports back, and Claude can wait for it.**

- Every task Claude sends carries a Task ID and a required report-back instruction: when the
  agent finishes (or gets blocked), it sends Claude a `result` report covering what it did, files changed,
  build/test results and anything left.
- New `wait_for_antigravity` tool: Claude hands off a task and waits for the result, then carries
  on in the same turn. Ends as `finished`, `needs_reply`, `idle`, `still_running` or `no_activity`.
- Results are linked to their task automatically; the prompt hook labels them `RESULT for task …`.

## v1.2.0 — 2026-10-09

**Claude's messages go straight into the Antigravity agent.**

- Messages from Claude are delivered into the agent chat and submitted automatically, using
  Antigravity's built-in `antigravity.sendPromptToAgentPanel` command. No copy-paste, no Enter.
- Falls back to the clipboard if that command isn't available.
- New setting `agentBridge.autoSendToAgent` (default on).

## v1.1.0 — 2026-10-09

**First public release.**

- One-click Windows installer (`Install.bat`): installs Node.js if needed, removes old installs,
  sets up Claude Code, the Claude desktop app and Antigravity, and restarts both apps.
- Live, step-by-step Antigravity progress for Claude (supports current `antigravity-ide` builds).
- Pre-bundled MCP server, so no `npm install` is needed.

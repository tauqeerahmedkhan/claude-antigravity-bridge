# Changelog

## v1.0.0 — 2026-10-09

**First public release.** Claude Code and Google Antigravity's agent, working as a team.

### Claude ↔ Antigravity
- **Live progress:** Claude sees every step Antigravity's agent runs (command, pass/fail, time),
  via MCP tools and a prompt hook that adds fresh updates to every message you send Claude.
- **Auto-delivered tasks:** Claude's messages go straight into the Antigravity agent chat and are
  submitted automatically, using Antigravity's built-in `antigravity.sendPromptToAgentPanel` command.
  Falls back to the clipboard if that command isn't available.
- **Result reports:** every task carries a Task ID and a required report-back instruction; the agent
  sends Claude a `result` covering what it did, files changed, build/test results and anything left.
- **`wait_for_antigravity`:** Claude can hand off a task, wait for the result and carry on in the
  same turn. Ends as `finished`, `needs_reply`, `idle`, `still_running` or `no_activity`.

### Installer
- One click on Windows (`Install.bat`): installs Node.js if needed, removes older installs, sets up
  Claude Code, the Claude desktop app and Antigravity, installs the extension and restarts both apps.
- Turns on Antigravity auto-save, so the agent's edits are saved without clicking Save.
- Adds short "work alongside the other agent" rules to `CLAUDE.md` and `GEMINI.md`.
- Pre-bundled server, so no `npm install` is needed. Backs up every file it edits.
  Options: `--dry-run`, `--no-restart`, `--no-autosave`, `--uninstall`.
- Supports current (`antigravity-ide`) and older Antigravity builds; Windows, macOS and Linux.

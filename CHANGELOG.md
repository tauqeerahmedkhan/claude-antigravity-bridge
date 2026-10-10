# Changelog

## v1.0.0 — 2026-10-10

**First public release.** Claude Code and Google Antigravity's agent, working as a team.

### Claude → Antigravity
- Claude shows you the full prompt in the chat, then sends it. It lands in Antigravity's agent chat
  and is submitted automatically (via Antigravity's built-in `antigravity.sendPromptToAgentPanel`),
  with a clipboard fallback if that command isn't available.
- Duplicate tasks sent within 5 minutes are skipped, so a task never runs twice.

### Antigravity → Claude
- **Reports via an outbox file:** every task names a report file
  (`~/.agent-bridge/outbox/<TaskID>.md`). Antigravity's agent writes its report there (what it did,
  files changed, test results), and the bridge delivers it to Claude. Writing a file is the agent's
  most reliable action, so this works even when Antigravity's connector tools are unavailable.
  The `send_message` tool still works as an alternative.
- Claude waits for the report in short rounds (the Claude desktop app cancels tool calls after
  ~60 s), gives you a one-line update each round, and shows you the report when it arrives.
- Live step feed of Antigravity's background commands (builds, tests) with pass/fail, plus
  conversation-folder activity, so quiet periods aren't mistaken for a stall.

### Reliability
- The bridge server exits as soon as its client disconnects (a lingering process could hang
  Antigravity's connector reload).
- Every bridge call is logged to `~/.agent-bridge/server.log` for troubleshooting.
- Hand-written or glued log lines are recovered; new messages always start on a fresh line.

### Installer
- One click on Windows (`Install.bat`): installs Node.js if needed, removes older installs, sets up
  Claude Code, the Claude desktop app and Antigravity (including `~/.gemini/config/mcp_config.json`,
  used by current Antigravity builds), installs the extension and restarts both apps.
- Turns on Antigravity auto-save, so the agent's edits are saved without clicking Save.
- Adds short "work alongside the other agent" rules to `CLAUDE.md` and `GEMINI.md`.
- Pre-bundled server (no `npm install`), backs up every file it edits.
  Options: `--dry-run`, `--no-restart`, `--no-autosave`, `--uninstall`.

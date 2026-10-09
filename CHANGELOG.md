# Changelog

## v1.1.0 — 2026-10-09

**Antigravity's reports now come back to Claude automatically, and you see every prompt.**

- **You see what's sent:** Claude shows the full prompt in the chat before sending it, and the tool
  result repeats exactly what was delivered.
- **Send and wait in one step:** `send_message` now waits for Antigravity's report by default.
- **Works within the Claude desktop app's 60-second tool limit:** waits run in short rounds (≤45 s).
  Claude keeps checking with `wait_for_antigravity`, gives you a one-line update each round, and shows
  you Antigravity's report as soon as it arrives.
- Reports are found by task ID from the full log, so one already picked up by the prompt hook is never missed.
- New `not_delivered` status if the task never reached Antigravity (e.g. it was closed).
- An answer to Antigravity's question no longer keeps showing as `needs_reply`.

## v1.0.1 — 2026-10-09

**Fixes: Antigravity's replies never reached Claude, and Claude sometimes had to send twice.**

- Current Antigravity builds load agent connectors from `~/.gemini/config/mcp_config.json`. The
  installer now registers the bridge there, so Antigravity's agent actually gets the bridge tools.
  Without them it had been writing replies into the log by hand.
- Hand-written log lines (several messages joined with a literal `\n`, no final newline) were
  silently dropped, and the next real message got glued onto them and lost too. The bridge now
  recovers glued messages and always starts a new message on a fresh line.
- `reply_to` written by hand is recognised as `replyTo`.
- Task prompts and `GEMINI.md` now tell the agent to use only the bridge tools, and to say so if
  they're missing, instead of editing the files itself.

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

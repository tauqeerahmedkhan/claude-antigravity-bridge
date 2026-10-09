# Claude-Antigravity Agent Bridge
Claude Code ↔ Antigravity: two coding agents, one project. Use Claude's intelligence with Antigravity's affordability.

[![Latest release](https://img.shields.io/github/v/release/tauqeerahmedkhan/claude-antigravity-bridge)](https://github.com/tauqeerahmedkhan/claude-antigravity-bridge/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Windows | macOS | Linux](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

**Let Claude Code and Google Antigravity's agent work on the same project as a team.**

- 👀 **Claude sees Antigravity working, live:** every command it runs, with pass/fail.
- 📨 **Claude hands tasks to Antigravity:** they go straight into the agent's chat and run. No copy-paste, no Enter key.
- ✅ **Antigravity reports back:** when it finishes, Claude gets a summary of what was done, files changed and test results.
- ⏳ **Claude can wait for the result** and carry on by itself once Antigravity is done.

```
You → Claude: "Have Antigravity run the Round 9 checks, wait for the result, then fix whatever failed."

Claude → Antigravity   📨 Task delivered to the agent
Antigravity            🔧 Run round 9 verification finished ✗ (exit 1)
Antigravity → Claude   ✅ RESULT: 40/42 checks passed; 2 failures in agreements API (see log)
Claude                 Fixes the two failures…
```

> Community project, not affiliated with or endorsed by Anthropic or Google.

## Install (Windows, one click)

1. **Download** [`claude-antigravity-bridge.zip`](https://github.com/tauqeerahmedkhan/claude-antigravity-bridge/releases/latest/download/claude-antigravity-bridge.zip) from the latest release.
2. **Extract** it: right-click the zip → **Extract All**.
3. **Double-click `Install.bat`.**

That's it. The installer:

- installs Node.js for you if it's missing (via `winget`)
- removes any older install of the bridge, including a manually installed extension
- connects **Claude Code** (CLI and the Claude desktop app) to the bridge and adds a live-update hook
- connects **Antigravity's agent** to the bridge and installs the Antigravity extension
- turns on **auto-save** in Antigravity, so the agent's code changes are saved (and your app reloads) without you clicking Save
- adds a short "you're working alongside the other agent" note to your global `CLAUDE.md` and `GEMINI.md`
- closes and reopens Antigravity and the Claude desktop app so they load it

Your chats and session history are not affected. After Claude reopens, open the same chat
from the sidebar and carry on.

Everything it changes is backed up first (`<file>.bak-agent-bridge`), and running it again is
safe: use it to repair or upgrade.

**Check it worked:** in Claude Code, run `/mcp`. You should see `agent-bridge`. Or just ask:
*"What is Antigravity doing right now?"*

**Uninstall:** double-click `Uninstall.bat`.

### macOS / Linux

Requires Node.js 18+.

```bash
node setup.js            # install / upgrade
node setup.js --uninstall
```

On macOS and Linux the installer doesn't restart apps; quit and reopen Antigravity and Claude yourself.

### Installer options

| Option | What it does |
|---|---|
| `--no-restart` | Don't close or reopen Antigravity and Claude |
| `--dry-run` | Show what would change without changing anything |
| `--no-autosave` | Don't turn on Antigravity's auto-save |
| `--uninstall` | Remove everything the installer added |

On Windows you can pass these to the batch file, e.g. `Install.bat --no-restart`.

## Working together: two ways

**1. Hand off and keep going (default).** Claude sends a task and carries on with its own work.
Every task ends with a required instruction: *when you finish, send Claude a `result` report:
what you did, files changed, build/test results, anything left.* The report shows up in
Claude's context with your next message (via the prompt hook), labelled `RESULT for task …`.

**2. Hand off and wait.** Ask Claude to wait, e.g. *"Have Antigravity run the Round 9 checks and
wait for the result, then fix anything that failed."* Claude calls `wait_for_antigravity`, which
returns as soon as the agent reports. Claude then reviews the result and continues in the same turn.

| `wait_for_antigravity` returns | Meaning |
|---|---|
| `finished` | The agent sent its result report |
| `needs_reply` | The agent asked Claude a question; Claude answers and waits again |
| `idle` | The agent went quiet without reporting (default 3 min), so it has probably finished. Claude checks the steps |
| `still_running` | Wait limit reached (default 5 min) while the agent was still working; Claude can wait again |
| `no_activity` | Nothing happened; Antigravity may be closed |

Each return also includes the steps the agent ran while Claude waited (title, command, exit code).

## How it works

```
   Claude Code ───MCP──┐                         ┌──MCP─── Antigravity agent
  (+ prompt hook)      │                         │
                       ├──►  ~/.agent-bridge/  ◄─┤
                       │     messages.jsonl      │
                       │                         └──── Antigravity extension
                       └── reads Antigravity's         (watches agent steps,
                           agent folder directly        shows Claude's messages)
```

There's no daemon, no port and no network. Everything goes through one append-only file in your user folder.

**Claude Code gets:**

| Tool | Purpose |
|---|---|
| `get_antigravity_progress` | Antigravity's latest steps (title, command, exit code, time) and task list, plus `lastActivity` so Claude can tell if it's current |
| `list_antigravity_conversations` | Recent Antigravity conversations, newest first |
| `read_antigravity_artifact` | Read a plan/task/walkthrough artifact |
| `send_message` | Send Antigravity a task (runs immediately) and get a `task_id` |
| `wait_for_antigravity` | Wait for the agent's result for a `task_id` (see above) |
| `read_messages` | Read messages/results from Antigravity |

It also gets a **prompt hook**: every message you send to Claude automatically includes new
Antigravity messages and its last step, so Claude stays current without having to ask.

**Antigravity's agent gets** `send_message` (with `type: "result"` and `reply_to` for task
reports; `reply_to` defaults to Claude's latest task) and `read_messages`.

**The Antigravity extension:**
- posts each finished agent step to Claude as it happens
- **delivers Claude's messages straight into the agent chat and submits them.** It uses
  Antigravity's built-in `antigravity.sendPromptToAgentPanel` command, the same one
  Antigravity's own previews use to prompt the agent. Each task arrives as
  `[Task from Claude Code via agent-bridge] Task ID: …`, followed by the required report-back
  instruction, and Claude gets a `📨 Delivered` confirmation. Several messages are sent one at a
  time, in order.
- if that command isn't available (e.g. a future Antigravity version renames it), it puts the
  message on your clipboard and tells you to paste it with `Ctrl+V`
- adds a status-bar item: click it to message Claude
- adds commands (`Ctrl+Shift+P`): *Agent Bridge: Send message to Claude Code*, *Send last Claude message to the agent*, *Copy last Claude message*, *Show log*, *Ping Claude Code*

**Extension settings** (Antigravity → Settings → search "Agent Bridge"):

| Setting | Default | |
|---|---|---|
| `agentBridge.autoSendToAgent` | `true` | Send Claude's messages straight into the agent chat. Turn off to get a popup with a **Send to agent** button instead |
| `agentBridge.autoReportProgress` | `true` | Post each finished agent step to Claude |
| `agentBridge.notifications` | `true` | Show bridge notifications |

### Where Antigravity keeps its data

| Antigravity version | Agent data | Extensions |
|---|---|---|
| Current (2026) | `~/.gemini/antigravity-ide/` (connectors: `~/.gemini/config/mcp_config.json`) | `~/.antigravity-ide/extensions/` |
| Older | `~/.gemini/antigravity/` | `~/.antigravity/extensions/` |

The bridge reads both and always uses the most recently active conversation. Current builds
write each finished agent step to `brain/<conversation>/.system_generated/messages/*.json`;
older builds kept a `task.md` checklist. Both are supported. If Antigravity moves its data in
a future update, set the `ANTIGRAVITY_BRAIN_DIR` environment variable to the new `brain` folder.

## Limits

- **Antigravity → Claude is near-live.** Claude sees updates on your next prompt (via the hook),
  when it calls a bridge tool, or while it waits with `wait_for_antigravity`. Nothing can start a
  new Claude turn by itself, so for long tasks you either let Claude wait or nudge it later.
- **Result reports depend on the agent following the instruction.** It's told firmly, in every
  task and in `GEMINI.md`. If it doesn't send one, `wait_for_antigravity` ends as `idle` and Claude
  gets the step list instead.
- **Claude → Antigravity is instant and runs on its own.** Claude's messages go straight into
  the agent's chat and are acted on without your approval. Turn off `agentBridge.autoSendToAgent`
  if you'd rather review each one first. If the agent is in the middle of a task, Antigravity
  decides whether the new message waits or interrupts it.
- The bridge relies on Antigravity's local files and an internal command, and neither is a documented
  API. A future Antigravity update could change them; the bridge then falls back to the clipboard.

## Troubleshooting

| Problem | Fix |
|---|---|
| Antigravity says it replied, but Claude never gets it | Antigravity's agent doesn't have the bridge tools. Run `Install.bat` again (it registers them in `~/.gemini/config/mcp_config.json`), restart Antigravity, and check **Agent panel → … → MCP Servers** lists `agent-bridge` |
| `agent-bridge` not in `/mcp` | Run `Install.bat` again, then fully quit Claude (tray icon → Quit) and reopen it |
| Claude sees old Antigravity data | Check `lastActivity` in `get_antigravity_progress`; if it's stale, run `Install.bat` again to update the bridge |
| Agent's edits wait for you to click **Save** | Auto-save is off. Run `Install.bat` again, or in Antigravity set **File → Auto Save** on. The installer leaves your own auto-save choice alone if you'd already picked one |
| "Antigravity didn't close" | Save your files, close Antigravity, run `Install.bat` again |
| Claude's message didn't appear in the agent chat | Run *Agent Bridge: Show log* in Antigravity. If it says auto-send is unavailable, your Antigravity version doesn't have the send command; paste from the clipboard instead |
| Extension not showing in Antigravity | Restart Antigravity. Manual fallback: build the `.vsix` (below), then Extensions → `…` → **Install from VSIX** |
| Something else | Run `Install.bat --dry-run` and [open an issue](https://github.com/tauqeerahmedkhan/claude-antigravity-bridge/issues) with the output |

## Development

```bash
npm run build          # bundle the MCP server into server/dist (commit the result)
npm test               # end-to-end test: two agents over stdio + hook output
npm run package:vsix   # optional: build extension/*.vsix for manual installs
```

| Path | What |
|---|---|
| `setup.js` | Installer / uninstaller (no dependencies) |
| `Install.bat`, `Uninstall.bat` | Windows one-click wrappers |
| `server/src/` | MCP server, message store, Claude prompt hook, tests |
| `server/dist/` | Bundled server; **committed** so users never need `npm install` |
| `extension/` | Antigravity extension (plain JS, no dependencies) |

Message format (`~/.agent-bridge/messages.jsonl`, one JSON object per line):

```json
{"id":"…","ts":"2026-10-09T05:16:31Z","from":"antigravity","to":"claude","type":"progress","text":"🔧 Run frontend build finished ✓"}
```

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT. Claude and Claude Code are trademarks of Anthropic; Antigravity and Gemini are trademarks of Google.

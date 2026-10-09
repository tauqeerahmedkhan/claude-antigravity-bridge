# Agent Bridge — Claude Code ↔ Google Antigravity

Let **Claude Code** and **Google Antigravity's agent** work on the same machine without stepping on
each other. Each can message the other, and Claude sees what Antigravity's agent is doing,
step by step, as it happens.

```
🔧 Run frontend build finished ✓
🔧 Run Round 8 live verification script finished ✓
🔧 Run tests finished ✗ (exit 1)
```

## Install (Windows, one click)

1. **Download** this repo: green **Code** button → **Download ZIP**, or grab the zip from Releases.
2. **Extract** it: right-click the zip → **Extract All**.
3. **Double-click `Install.bat`.**

That's it. The installer:

- installs Node.js for you if it's missing (via `winget`)
- removes any older Agent Bridge install, including a manually installed extension
- connects **Claude Code** (CLI and the Claude desktop app) to the bridge and adds a live-update hook
- connects **Antigravity's agent** to the bridge and installs the Antigravity extension
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
| `--uninstall` | Remove everything the installer added |

On Windows you can pass these to the batch file, e.g. `Install.bat --no-restart`.

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
| `send_message` / `read_messages` | Talk to Antigravity |

It also gets a **prompt hook**: every message you send to Claude automatically includes new
Antigravity messages and its last step, so Claude stays current without having to ask.

**Antigravity's agent gets** the same `send_message` / `read_messages` tools.

**The Antigravity extension:**
- posts each finished agent step to Claude as it happens
- pops up Claude's messages, with **Copy for agent** (paste into the agent) and **Reply** buttons
- adds a status-bar item: click it to message Claude
- adds commands (`Ctrl+Shift+P`): *Agent Bridge: Send message to Claude Code*, *Copy last Claude message*, *Show log*, *Ping Claude Code*
- adds settings: `agentBridge.autoReportProgress`, `agentBridge.notifications`

### Where Antigravity keeps its data

| Antigravity version | Agent data | Extensions |
|---|---|---|
| Current (2026) | `~/.gemini/antigravity-ide/` | `~/.antigravity-ide/extensions/` |
| Older | `~/.gemini/antigravity/` | `~/.antigravity/extensions/` |

The bridge reads both and always uses the most recently active conversation. Current builds
write each finished agent step to `brain/<conversation>/.system_generated/messages/*.json`;
older builds kept a `task.md` checklist. Both are supported. If Antigravity moves its data in
a future update, set the `ANTIGRAVITY_BRAIN_DIR` environment variable to the new `brain` folder.

## Limits

- **Antigravity → Claude is near-live.** Claude sees updates on your next prompt (via the hook) or
  when it calls a bridge tool. A reply Claude is already writing isn't interrupted.
- **Claude → Antigravity:** the popup appears immediately, but Antigravity's agent reads the
  message only when it calls `read_messages` or you paste it in. Antigravity has no public API
  for injecting a prompt into a running agent.
- The bridge reads Antigravity's local files, whose layout isn't a documented API. A future
  Antigravity update could change it.

## Troubleshooting

| Problem | Fix |
|---|---|
| `agent-bridge` not in `/mcp` | Run `Install.bat` again, then fully quit Claude (tray icon → Quit) and reopen it |
| Claude sees old Antigravity data | Check `lastActivity` in `get_antigravity_progress`; if it's stale, run `Install.bat` again to update the bridge |
| "Antigravity didn't close" | Save your files, close Antigravity, run `Install.bat` again |
| Extension not showing in Antigravity | Restart Antigravity. Manual fallback: build the `.vsix` (below), then Extensions → `…` → **Install from VSIX** |
| Something else | Run `Install.bat --dry-run` and open an issue with the output |

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

## License

MIT

// Agent Bridge for Antigravity
//  - watches Antigravity's agent artifacts (~/.gemini/antigravity/brain/*/task.md etc.)
//    and posts live progress to Claude Code over the shared bus
//  - pops up messages Claude sends to Antigravity
//  - lets you send a message to Claude from the command palette / status bar
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const BRIDGE_DIR = process.env.AGENT_BRIDGE_DIR || path.join(os.homedir(), ".agent-bridge");
const LOG_FILE = path.join(BRIDGE_DIR, "messages.jsonl");
// Newer Antigravity builds use ~/.gemini/antigravity-ide, older ones ~/.gemini/antigravity
const BRAIN_DIRS = process.env.ANTIGRAVITY_BRAIN_DIR
  ? process.env.ANTIGRAVITY_BRAIN_DIR.split(path.delimiter)
  : ["antigravity-ide", "antigravity"].map((d) => path.join(os.homedir(), ".gemini", d, "brain"));
const UI_CURSOR = path.join(BRIDGE_DIR, "cursor-antigravity-ui.json");
const ME = "antigravity";

// ---------- bus (same file format as bridge-mcp/store.js) ----------
function post(text, type = "progress", meta) {
  fs.mkdirSync(BRIDGE_DIR, { recursive: true });
  const msg = { id: crypto.randomUUID(), ts: new Date().toISOString(), from: ME, to: "claude", type, text };
  if (meta) msg.meta = meta;
  fs.appendFileSync(LOG_FILE, JSON.stringify(msg) + "\n", "utf8");
  return msg;
}
function readAll() {
  try {
    return fs.readFileSync(LOG_FILE, "utf8").split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function readCursor() {
  try { return JSON.parse(fs.readFileSync(UI_CURSOR, "utf8")).index; } catch { return undefined; }
}
function writeCursor(index) {
  fs.mkdirSync(BRIDGE_DIR, { recursive: true });
  fs.writeFileSync(UI_CURSOR, JSON.stringify({ index }));
}

// ---------- task.md diffing ----------
function parseTasks(md) {
  const items = new Map();
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(/^\s*[-*]\s*\[( |x|X|\/)\]\s+(.*\S)\s*$/);
    if (m) items.set(m[2], m[1] === " " ? "todo" : m[1] === "/" ? "doing" : "done");
  }
  return items;
}

function activate(context) {
  const cfg = () => vscode.workspace.getConfiguration("agentBridge");
  const out = vscode.window.createOutputChannel("Agent Bridge");
  const log = (s) => out.appendLine(`[${new Date().toLocaleTimeString()}] ${s}`);
  context.subscriptions.push(out);

  // Status bar
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  bar.command = "agentBridge.sendToClaude";
  let unreadCount = 0;
  let lastClaude = null;
  const renderBar = () => {
    bar.text = unreadCount ? `$(comment-discussion) Claude: ${unreadCount}` : "$(radio-tower) Bridge";
    bar.tooltip = unreadCount ? `Last from Claude: ${lastClaude?.text}\nClick to reply` : "Agent Bridge: click to message Claude";
  };
  renderBar();
  bar.show();
  context.subscriptions.push(bar);

  // ----- watch Antigravity artifacts -----
  const snapshots = new Map(); // file path -> Map(task -> state) | mtime for other artifacts
  const timers = new Map();

  function report(file, { seed = false } = {}) {
    if (!cfg().get("autoReportProgress", true) && !seed) return;
    let content;
    try { content = fs.readFileSync(file, "utf8"); } catch { return; }
    const conv = path.basename(path.dirname(file));
    const name = path.basename(file);

    if (name.toLowerCase() === "task.md") {
      const now = parseTasks(content);
      const before = snapshots.get(file);
      snapshots.set(file, now);
      if (seed || !before) return;
      const changes = [];
      for (const [task, state] of now) {
        const was = before.get(task);
        if (was === state) continue;
        if (!was) changes.push(`➕ added: ${task}`);
        else if (state === "doing") changes.push(`▶ started: ${task}`);
        else if (state === "done") changes.push(`✅ done: ${task}`);
        else changes.push(`↩ reopened: ${task}`);
      }
      if (!changes.length) return;
      const counts = [...now.values()];
      const tally = `(${counts.filter((s) => s === "done").length}/${counts.length} done)`;
      const shown = changes.length > 6 ? [...changes.slice(0, 6), `…and ${changes.length - 6} more`] : changes;
      const msg = `${shown.join("; ")} ${tally}`;
      post(msg, "progress", { conversationId: conv, artifact: name });
      log(`→ Claude: ${msg}`);
    } else {
      const mtime = fs.statSync(file).mtimeMs;
      const before = snapshots.get(file);
      snapshots.set(file, mtime);
      if (seed || before === mtime) return;
      const msg = `📝 ${before ? "updated" : "created"} ${name}`;
      post(msg, "progress", { conversationId: conv, artifact: name });
      log(`→ Claude: ${msg}`);
    }
  }

  // New Antigravity: one JSON per finished agent step in <conv>/.system_generated/messages
  const seenSteps = new Set();
  function reportStep(file, { seed = false } = {}) {
    if (seenSteps.has(file)) return;
    let j;
    try { j = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return; } // half-written; retried on next event
    seenSteps.add(file);
    if (seed || !cfg().get("autoReportProgress", true)) return;
    let args = {};
    try { args = JSON.parse(j?.sourceMetadata?.tool?.toolCall?.argumentsJson || "{}"); } catch {}
    const title = j?.renderDetails?.messageTitle || args.toolSummary || "agent step";
    const exit = String(j.content || "").match(/exited with code (-?\d+)/);
    const conv = path.basename(path.dirname(path.dirname(path.dirname(file))));
    const msg = `🔧 ${title}${exit ? (exit[1] === "0" ? " ✓" : ` ✗ (exit ${exit[1]})`) : ""}`;
    post(msg, "progress", { conversationId: conv, command: args.CommandLine });
    log(`→ Claude: ${msg}`);
  }
  const isStep = (f) => /[\\/]\.system_generated[\\/]messages[\\/][^\\/]+\.json$/.test(f) && !f.endsWith("read.json");

  function onArtifact(file) {
    if (isStep(file)) {
      clearTimeout(timers.get(file));
      timers.set(file, setTimeout(() => reportStep(file), 500));
      return;
    }
    if (!file.endsWith(".md") || /[\\/](browser|scratch)[\\/]/.test(file)) return;
    clearTimeout(timers.get(file));
    // Debounce: the agent rewrites files in bursts
    timers.set(file, setTimeout(() => report(file), 1500));
  }

  function seedAll() {
    for (const base of BRAIN_DIRS) {
      let convs = [];
      try { convs = fs.readdirSync(base); } catch { continue; }
      for (const d of convs) {
        const dir = path.join(base, d);
        try { for (const f of fs.readdirSync(dir)) if (f.endsWith(".md")) report(path.join(dir, f), { seed: true }); } catch {}
        const mdir = path.join(dir, ".system_generated", "messages");
        try { for (const f of fs.readdirSync(mdir)) if (f.endsWith(".json") && f !== "read.json") reportStep(path.join(mdir, f), { seed: true }); } catch {}
      }
    }
  }

  const watching = new Set();
  function startBrainWatch() {
    const existing = BRAIN_DIRS.filter((d) => fs.existsSync(d) && !watching.has(d));
    if (!existing.length && !watching.size) {
      log(`Waiting for Antigravity agent folders (${BRAIN_DIRS.join(", ")})…`);
      const t = setInterval(() => { if (BRAIN_DIRS.some((d) => fs.existsSync(d))) { clearInterval(t); startBrainWatch(); } }, 10000);
      context.subscriptions.push({ dispose: () => clearInterval(t) });
      return;
    }
    seedAll();
    for (const dir of existing) {
      // Recursive fs.watch is supported on Windows and macOS
      const w = fs.watch(dir, { recursive: true }, (_evt, rel) => {
        if (rel) onArtifact(path.join(dir, rel.toString()));
      });
      w.on("error", (e) => log(`watch error: ${e.message}`));
      context.subscriptions.push({ dispose: () => w.close() });
      watching.add(dir);
      log(`Watching Antigravity agent activity in ${dir}`);
    }
  }
  startBrainWatch();

  // ----- watch messages from Claude -----
  if (readCursor() === undefined) writeCursor(readAll().length); // don't replay history on first run
  function checkInbox() {
    const msgs = readAll();
    let idx = readCursor() || 0;
    if (idx > msgs.length) idx = 0;
    const fresh = msgs.slice(idx).filter((m) => m.from !== ME && (m.to === ME || m.to === "all"));
    writeCursor(msgs.length);
    for (const m of fresh) {
      lastClaude = m;
      log(`← ${m.from}: ${m.text}`);
      if (m.type === "progress") continue; // log only, no popup
      unreadCount++;
      if (cfg().get("notifications", true)) {
        vscode.window
          .showInformationMessage(`Claude: ${m.text}`, "Copy for agent", "Reply")
          .then((choice) => {
            if (choice === "Copy for agent") {
              vscode.env.clipboard.writeText(`Message from Claude Code: ${m.text}`);
              vscode.window.setStatusBarMessage("Copied — paste it into the Antigravity agent", 4000);
            } else if (choice === "Reply") {
              vscode.commands.executeCommand("agentBridge.sendToClaude");
            }
          });
      }
    }
    if (fresh.length) renderBar();
  }
  fs.mkdirSync(BRIDGE_DIR, { recursive: true });
  if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, "");
  fs.watchFile(LOG_FILE, { interval: 1000 }, checkInbox);
  context.subscriptions.push({ dispose: () => fs.unwatchFile(LOG_FILE) });

  // ----- commands -----
  context.subscriptions.push(
    vscode.commands.registerCommand("agentBridge.sendToClaude", async () => {
      unreadCount = 0;
      renderBar();
      const text = await vscode.window.showInputBox({
        prompt: "Message to Claude Code",
        placeHolder: "e.g. I've finished the API layer, you can start the UI",
      });
      if (!text) return;
      post(text, "message");
      log(`→ Claude (you): ${text}`);
      vscode.window.setStatusBarMessage("Sent to Claude Code", 3000);
    }),
    vscode.commands.registerCommand("agentBridge.showLog", () => {
      unreadCount = 0;
      renderBar();
      out.show(true);
    }),
    vscode.commands.registerCommand("agentBridge.copyLastFromClaude", () => {
      if (!lastClaude) return vscode.window.showInformationMessage("No messages from Claude yet.");
      vscode.env.clipboard.writeText(`Message from Claude Code: ${lastClaude.text}`);
      unreadCount = 0;
      renderBar();
      vscode.window.setStatusBarMessage("Copied — paste it into the Antigravity agent", 4000);
    }),
    vscode.commands.registerCommand("agentBridge.reportNow", () => {
      seedAll();
      post("Antigravity bridge is online and watching agent artifacts.", "progress");
      vscode.window.setStatusBarMessage("Pinged Claude Code", 3000);
    })
  );
}

function deactivate() {}
module.exports = { activate, deactivate, parseTasks };

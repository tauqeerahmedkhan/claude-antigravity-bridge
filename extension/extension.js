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
// Antigravity stores each conversation as conversations/<id>.db next to brain/; the file is
// written the moment a message is added, which lets us confirm a prompt really arrived.
const CONV_DIRS = process.env.ANTIGRAVITY_CONV_DIR
  ? process.env.ANTIGRAVITY_CONV_DIR.split(path.delimiter)
  : BRAIN_DIRS.map((b) => path.join(path.dirname(b), "conversations"));
function conversationStamp() {
  let newest = 0, count = 0;
  for (const d of CONV_DIRS) {
    let names = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (n.startsWith(".")) continue;
      try { const t = fs.statSync(path.join(d, n)).mtimeMs; count++; if (t > newest) newest = t; } catch {}
    }
  }
  return { newest, count };
}
function diag(line) {
  try { fs.appendFileSync(path.join(BRIDGE_DIR, "server.log"), `${new Date().toISOString()} [ext ${process.pid}] ${line}\n`); } catch {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Keyboard delivery (Windows): bring this Antigravity window to the front, and only if it is
// confirmed to be the foreground window, paste (Ctrl+V) and press Enter in the focused agent
// chat box. Never types into any other app.
const PS_PASTE = String.raw`
param([string]$TitleHint)
# Paste the prompt (already on the clipboard) into Antigravity's agent chat box and click Send.
# Every step is verified through Windows UI Automation; nothing is typed unless the agent's
# "Message input" box itself has keyboard focus, so keys can never land in a code file or another app.
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
Add-Type @"
using System; using System.Runtime.InteropServices;
public class AbW {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
"@
$A = [System.Windows.Automation.AutomationElement]
$wins = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -like '*Antigravity*' }
$win = $wins | Where-Object { $TitleHint -and $_.MainWindowTitle -like "*$TitleHint*" } | Select-Object -First 1
if (-not $win) { $win = $wins | Select-Object -First 1 }
if (-not $win) { 'NOWINDOW'; exit }
$h = $win.MainWindowHandle
if ([AbW]::IsIconic($h)) { [AbW]::ShowWindow($h, 9) | Out-Null }
[AbW]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [AbW]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
[AbW]::SetForegroundWindow($h) | Out-Null
(New-Object -ComObject WScript.Shell).AppActivate($win.Id) | Out-Null
Start-Sleep -Milliseconds 400
$root = $A::FromHandle($h)
$byName = { param($n) $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, $n))) }
$box = & $byName 'Message input'
if (-not $box) { 'NOINPUT'; exit }
try { $box.SetFocus() } catch { "FOCUSERROR:$($_.Exception.Message)"; exit }
Start-Sleep -Milliseconds 300
$f = $A::FocusedElement
if (-not $f -or $f.Current.Name -ne 'Message input') { "NOTFOCUSED:$($f.Current.Name)"; exit }
[System.Windows.Forms.SendKeys]::SendWait('^v')
# wait for the Send button to become enabled (it's disabled while the box is empty)
$btn = $null
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 150
  $btn = & $byName 'Send message'
  if ($btn -and $btn.Current.IsEnabled) { break }
}
if ($btn -and $btn.Current.IsEnabled) {
  $ip = $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $ip.Invoke(); 'SENT:button'
} else {
  $f = $A::FocusedElement
  if ($f -and $f.Current.Name -eq 'Message input') { [System.Windows.Forms.SendKeys]::SendWait('{ENTER}'); 'SENT:enter' } else { 'PASTED_NOT_SENT' }
}
`;
// Wake Claude: paste a short note into the Claude desktop app's chat box and press Enter, but only
// if (1) the open chat is the one that sent the task, (2) Claude isn't mid-reply, (3) the box is
// empty (never overwrite the user's draft) and (4) the box itself has keyboard focus.
// The user's clipboard is restored afterwards.
const PS_WAKE = String.raw`
param([string]$Title, [string]$MsgFile)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
Add-Type @"
using System; using System.Runtime.InteropServices;
public class AbC {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
"@
$A = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]::Descendants
$p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -eq 'claude' } | Select-Object -First 1
if (-not $p) { 'NOCLAUDE'; exit }
$h = $p.MainWindowHandle
$root = $A::FromHandle($h)
$docCond = New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)
$current = ($root.FindAll($TS, $docCond) | Where-Object { $_.Current.Name -like '* - Claude*' } | Select-Object -First 1).Current.Name
if ($current -ne $Title) { "WRONGCHAT:$current"; exit }
$btnCond = New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
$busy = $root.FindAll($TS, $btnCond) | Where-Object { $_.Current.Name -match '^(Stop|Interrupt|Cancel response)' } | Select-Object -First 1
if ($busy) { 'BUSY'; exit }
$box = $root.FindFirst($TS, (New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, 'Prompt')))
if (-not $box) { 'NOPROMPT'; exit }
$tp = $null
if ($box.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) {
  if ($tp.DocumentRange.GetText(-1).Trim().Length -gt 0) { 'DRAFT'; exit }
}
if ([AbC]::IsIconic($h)) { [AbC]::ShowWindow($h, 9) | Out-Null }
[AbC]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [AbC]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
[AbC]::SetForegroundWindow($h) | Out-Null
(New-Object -ComObject WScript.Shell).AppActivate($p.Id) | Out-Null
Start-Sleep -Milliseconds 400
try { $box.SetFocus() } catch { "FOCUSERROR:$($_.Exception.Message)"; exit }
Start-Sleep -Milliseconds 300
$f = $A::FocusedElement
if (-not $f -or $f.Current.Name -ne 'Prompt') { "NOTFOCUSED:$($f.Current.Name)"; exit }
$old = $null; try { $old = Get-Clipboard -Raw } catch {}
Set-Clipboard -Value (Get-Content -Raw -LiteralPath $MsgFile)
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 500
$f = $A::FocusedElement
if (-not $f -or $f.Current.Name -ne 'Prompt') { if ($old) { Set-Clipboard -Value $old }; 'PASTED_NOT_SENT'; exit }
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Start-Sleep -Milliseconds 300
if ($old) { Set-Clipboard -Value $old }
'SENT'
`;

function runPowerShell(script, args) {
  return new Promise((resolve) => {
    const { execFile } = require("child_process");
    const file = path.join(BRIDGE_DIR, script === PS_WAKE ? "wake-claude.ps1" : "paste-to-agent.ps1");
    try { fs.writeFileSync(file, script, "utf8"); } catch (e) { return resolve(`ERR ${e.message}`); }
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file, ...args],
      { timeout: 20000, windowsHide: true }, (err, stdout, stderr) => {
        resolve(((stdout || "") + (err ? ` ERR ${err.message}` : "")).trim());
      });
  });
}
const ME = "antigravity";

// ---------- bus (same file format as bridge-mcp/store.js) ----------
function post(text, type = "progress", meta) {
  fs.mkdirSync(BRIDGE_DIR, { recursive: true });
  let lead = "";
  try {
    const st = fs.statSync(LOG_FILE);
    if (st.size > 0) {
      const fd = fs.openSync(LOG_FILE, "r"), b = Buffer.alloc(1);
      fs.readSync(fd, b, 0, 1, st.size - 1); fs.closeSync(fd);
      if (b[0] !== 0x0a) lead = "\n";
    }
  } catch {}
  const msg = { id: crypto.randomUUID(), ts: new Date().toISOString(), from: ME, to: "claude", type, text };
  if (meta) msg.meta = meta;
  fs.appendFileSync(LOG_FILE, lead + JSON.stringify(msg) + "\n", "utf8");
  return msg;
}
function readAll() {
  let raw;
  try { raw = fs.readFileSync(LOG_FILE, "utf8"); } catch { return []; }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); continue; } catch {}
    // recover several objects glued onto one line
    let depth = 0, start = -1, inStr = false, esc = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === "{") { if (depth++ === 0) start = i; }
      else if (c === "}" && depth > 0 && --depth === 0) { try { out.push(JSON.parse(s.slice(start, i + 1))); } catch {} }
    }
  }
  return out.filter((m) => m && m.from);
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

  // Status bar (click: message Claude)
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  bar.command = "agentBridge.sendToClaude";
  let unreadCount = 0;
  let lastClaude = null;

  // ----- live status: receiving ⬇ (blue, blinking) → working ⟳ (amber, spinning)
  //       → reporting ⬆ (green, blinking) → ✓ reported; ⚠ red if delivery failed -----
  const STATES = {
    idle:      { icon: "$(radio-tower)", label: "Bridge" },
    receiving: { icon: "$(arrow-down)",  label: "Receiving task from Claude", color: "#3794ff", blink: true },
    working:   { icon: "$(sync~spin)",   label: "Agent working",              color: "#e2b93d" },
    sending:   { icon: "$(arrow-up)",    label: "Reporting to Claude",        color: "#73c991", blink: true },
    done:      { icon: "$(check)",       label: "Reported to Claude",         color: "#73c991" },
    failed:    { icon: "$(warning)",     label: "Task not delivered",         color: "#f14c4c" },
  };
  let state = "idle", stateDetail = "", stateSince = Date.now(), blinkOn = true;
  let blinkTimer = null, stateTimer = null, lastAgentActivity = 0, activeTask = null;
  const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? `${s}s` : `${Math.round(s / 60)} min`; };
  function setState(name, detail = "", holdMs = 0, next = "idle") {
    state = name; stateDetail = detail; stateSince = Date.now(); blinkOn = true;
    clearInterval(blinkTimer); blinkTimer = null;
    clearTimeout(stateTimer); stateTimer = null;
    if (STATES[name].blink) blinkTimer = setInterval(() => { blinkOn = !blinkOn; renderBar(); }, 550);
    if (holdMs) stateTimer = setTimeout(() => setState(next), holdMs);
    renderBar();
  }
  const renderBar = () => {
    const st = STATES[state];
    if (state === "idle" && unreadCount) {
      bar.color = undefined;
      bar.text = `$(comment-discussion) Claude: ${unreadCount}`;
      bar.tooltip = `Last from Claude: ${lastClaude?.text}\nClick to reply`;
      return;
    }
    const icon = st.blink && !blinkOn ? "$(blank)" : st.icon;
    bar.color = st.color;
    bar.text = `${icon} ${st.label}`;
    bar.tooltip = state === "idle"
      ? "Agent Bridge: click to message Claude"
      : `${st.label} (${ago(stateSince)})${stateDetail ? `\n${stateDetail}` : ""}\nClick to message Claude`;
  };
  // working watchdog: stop spinning if the agent has gone silent for a long time
  const watchdog = setInterval(() => {
    if (state === "working") {
      renderBar(); // refresh elapsed time in tooltip
      const quietFor = Date.now() - Math.max(lastAgentActivity, stateSince);
      if (quietFor > (activeTask ? 60 : 10) * 60000) { activeTask = null; setState("idle"); }
    }
  }, 15000);
  context.subscriptions.push({ dispose: () => { clearInterval(watchdog); clearInterval(blinkTimer); clearTimeout(stateTimer); } });
  function agentActivity() {
    lastAgentActivity = Date.now();
    if (state === "idle" || state === "done") setState("working", "Antigravity agent is running steps");
  }
  function reportSeen(what, taskId, kind = "report") {
    activeTask = null;
    setState("sending", what, 5000, "done");
    setTimeout(() => { if (state === "done") setState("done", what, 8000); }, 5100);
    if (taskId) scheduleWake(taskId, kind);
  }

  // ----- wake Claude when a report is ready and Claude hasn't picked it up -----
  const wakeScheduled = new Set();
  function claudeHasRead(taskId) {
    // report files are moved to outbox/delivered the moment Claude reads the bridge
    try { if (fs.readdirSync(path.join(BRIDGE_DIR, "outbox")).some((n) => n.startsWith(taskId))) return false; } catch {}
    try { if (fs.readdirSync(path.join(BRIDGE_DIR, "outbox", "delivered")).some((n) => n.includes(taskId))) return true; } catch {}
    const msgs = readAll();
    let cur = 0;
    try { cur = JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, "cursor-claude.json"), "utf8")).index || 0; } catch {}
    const i = msgs.findIndex((m) => m.from === ME && (m.type === "result" || m.type === "message") && m.replyTo === taskId);
    return i !== -1 && i < cur;
  }
  function scheduleWake(taskId, kind) {
    if (!cfg().get("wakeClaude", true) || wakeScheduled.has(taskId)) return;
    wakeScheduled.add(taskId);
    setTimeout(() => wakeClaude(taskId, kind).catch((e) => diag(`wake error: ${e?.message || e}`)), 25000);
  }
  async function wakeClaude(taskId, kind) {
    if (claudeHasRead(taskId)) { diag(`wake ${taskId}: Claude already read it`); return; }
    const task = readAll().find((m) => m.id === taskId);
    const title = task?.meta?.claudeChat;
    const id8 = taskId.slice(0, 8);
    const note = kind === "question"
      ? `[agent-bridge] Antigravity has a question about task ${id8}. Call wait_for_antigravity with task_id ${taskId}, answer it, and continue.`
      : `[agent-bridge] Antigravity finished task ${id8} and its report is ready. Call wait_for_antigravity with task_id ${taskId}, show me the report, and continue.`;
    let r = "NOTITLE";
    if (process.platform === "win32" && title) {
      const msgFile = path.join(BRIDGE_DIR, "wake-message.txt");
      fs.writeFileSync(msgFile, note, "utf8");
      r = await runPowerShell(PS_WAKE, [title, msgFile]);
    }
    diag(`wake ${taskId}: ${r}`);
    if (!r.startsWith("SENT")) {
      const why = { NOTITLE: "", BUSY: " (Claude is busy replying)", DRAFT: " (you have a draft in Claude's box)" }[r.split(":")[0]]
        ?? (r.startsWith("WRONGCHAT") ? ` (a different Claude chat is open: expected "${title}")` : "");
      vscode.window.showInformationMessage(
        `Antigravity's ${kind} for task ${id8} is ready. Tell Claude to check the bridge${why}.`, "Copy note for Claude"
      ).then((c) => { if (c) vscode.env.clipboard.writeText(note); });
    }
  }
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
    agentActivity();
  }
  const isStep = (f) => /[\\/]\.system_generated[\\/]messages[\\/][^\\/]+\.json$/.test(f) && !f.endsWith("read.json");

  function onArtifact(file) {
    if (activeTask || state === "working") lastAgentActivity = Date.now(); // any agent file change counts
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

  // ----- deliver Claude's messages straight into the Antigravity agent chat -----
  // Antigravity's own (hidden) command: opens the agent panel and sends the text as a chat
  // message — same path its interactive previews use to prompt the agent.
  const SEND_CMD = "antigravity.sendPromptToAgentPanel";
  let sendCmdAvailable;
  async function hasSendCommand() {
    if (sendCmdAvailable === undefined) {
      try { sendCmdAvailable = (await vscode.commands.getCommands(false)).includes(SEND_CMD); }
      catch { sendCmdAvailable = false; }
      log(sendCmdAvailable ? "Agent auto-send available" : `Agent auto-send unavailable (${SEND_CMD} not found); falling back to clipboard`);
    }
    return sendCmdAvailable;
  }
  // Every task ends with a firm report-back requirement so Claude always gets a result.
  function buildPrompt(text, taskId) {
    const reportFile = path.join(BRIDGE_DIR, "outbox", `${taskId || "report-" + Date.now()}.md`);
    try { fs.mkdirSync(path.dirname(reportFile), { recursive: true }); } catch {}
    return [
      "[Task from Claude Code via agent-bridge]" + (taskId ? `  Task ID: ${taskId}` : ""),
      "",
      text,
      "",
      "---",
      "REQUIRED when you finish (or if you get blocked or need a decision): write your report as a",
      "plain text / markdown file at exactly this path (create it with your file tool or a command):",
      `  ${reportFile}`,
      "Include: what you did, files changed, build/test results, anything left or blocked.",
      "Claude Code is waiting for this file, so always write it, even if the task failed.",
      "Write ONLY that file; never edit messages.jsonl or other files in .agent-bridge.",
    ].join("\n");
  }
  const queue = [];
  let sending = false;
  const recentlySent = new Map(); // text -> time, to avoid running the same task twice
  function enqueueForAgent(text, taskId) {
    const now = Date.now();
    for (const [t, at] of recentlySent) if (now - at > 5 * 60000) recentlySent.delete(t);
    if (recentlySent.has(text)) {
      log(`skipped duplicate task (same text sent ${Math.round((now - recentlySent.get(text)) / 1000)}s ago)`);
      post(`⏭ Skipped a duplicate of a task delivered moments ago (not run twice)`, "progress");
      return;
    }
    recentlySent.set(text, now);
    queue.push({ text, taskId });
    if (!sending) drainQueue();
  }
  async function drainQueue() {
    sending = true;
    while (queue.length) {
      const { text, taskId } = queue.shift();
      const prompt = buildPrompt(text, taskId);
      const short = text.length > 80 ? text.slice(0, 77) + "…" : text;
      setState("receiving", short);
      let delivered = false;
      if (await hasSendCommand()) {
        // The agent panel only receives the message if it is open and mounted, so open it,
        // give it time to load, send, and confirm by watching the conversation files.
        // Second attempt waits longer for a slow panel.
        const kb = process.platform === "win32" && cfg().get("keyboardDelivery", true);
        const attempts = kb ? [[1, 1200]] : [[1, 1200], [2, 3500]]; // keyboard path follows on Windows
        for (const [attempt, settleMs] of attempts) {
          const before = conversationStamp();
          // Focus the editor first: toggleChatFocus *closes* the panel if the chat already has focus.
          try { await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup"); } catch {}
          await sleep(200);
          try { await vscode.commands.executeCommand("antigravity.toggleChatFocus"); } catch (e) { diag(`toggleChatFocus failed: ${e?.message || e}`); }
          await sleep(settleMs);
          try {
            await vscode.commands.executeCommand(SEND_CMD, prompt);
          } catch (e) {
            diag(`send attempt ${attempt} threw: ${e?.message || e}`);
            continue;
          }
          for (let i = 0; i < 20 && !delivered; i++) {
            await sleep(500);
            const now = conversationStamp();
            if (now.newest > before.newest || now.count > before.count) delivered = true;
          }
          diag(`send attempt ${attempt} for task ${taskId}: ${delivered ? "confirmed" : "not confirmed"}`);
          if (delivered) break;
        }
      }
      // Antigravity 1.107+: the send command no longer reaches the agent panel, so paste it
      // into the agent chat box the way a person would.
      if (!delivered && process.platform === "win32" && cfg().get("keyboardDelivery", true)) {
        const before = conversationStamp();
        await vscode.env.clipboard.writeText(prompt);
        try { await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup"); } catch {}
        await sleep(300);
        try { await vscode.commands.executeCommand("antigravity.toggleChatFocus"); } catch {}
        await sleep(1200);
        const r = await runPowerShell(PS_PASTE, [vscode.workspace.name || ""]);
        diag(`keyboard delivery for task ${taskId}: ${r}`);
        if (r.startsWith("SENT")) {
          for (let i = 0; i < 24 && !delivered; i++) {
            await sleep(500);
            const now = conversationStamp();
            if (now.newest > before.newest || now.count > before.count) delivered = true;
          }
          diag(`keyboard delivery for task ${taskId}: ${delivered ? "confirmed" : "not confirmed"}`);
        }
      }
      if (delivered) {
        log(`→ agent: ${short}`);
        post(`📨 Delivered to the Antigravity agent (confirmed): "${short}"`, "progress");
        activeTask = taskId; lastAgentActivity = Date.now();
        setState("working", short);
        if (cfg().get("notifications", true)) {
          vscode.window.setStatusBarMessage(`$(comment-discussion) Sent Claude's message to the agent`, 5000);
        }
      } else {
        post(`⚠️ Could NOT deliver this task to the Antigravity agent automatically. It's on the clipboard in Antigravity; ask the user to paste it into the agent chat (Ctrl+V): "${short}"`, "progress");
        await vscode.env.clipboard.writeText(prompt);
        unreadCount++;
        setState("failed", `${short}\nOn your clipboard: paste into the agent chat (Ctrl+V)`, 60000);
        vscode.window.showWarningMessage(
          `Couldn't send Claude's message to the agent automatically, so it's on your clipboard — paste it into the agent chat (Ctrl+V). "${short}"`,
          "Open agent chat"
        ).then((c) => { if (c) vscode.commands.executeCommand("antigravity.toggleChatFocus"); });
      }
      await new Promise((r) => setTimeout(r, 1500)); // let the panel settle between messages
    }
    sending = false;
  }

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
      if (cfg().get("autoSendToAgent", true)) {
        enqueueForAgent(m.text, m.id);
        continue;
      }
      unreadCount++;
      if (cfg().get("notifications", true)) {
        vscode.window
          .showInformationMessage(`Claude: ${m.text}`, "Send to agent", "Reply")
          .then((choice) => {
            if (choice === "Send to agent") enqueueForAgent(m.text, m.id);
            else if (choice === "Reply") vscode.commands.executeCommand("agentBridge.sendToClaude");
          });
      }
    }
    if (fresh.length) renderBar();
  }
  fs.mkdirSync(BRIDGE_DIR, { recursive: true });
  // Agent writing its report file -> "Reporting to Claude"
  const OUTBOX = path.join(BRIDGE_DIR, "outbox");
  try { fs.mkdirSync(OUTBOX, { recursive: true }); } catch {}
  try {
    const ow = fs.watch(OUTBOX, (_e, name) => {
      if (name && /\.(md|txt)$/i.test(String(name)) && fs.existsSync(path.join(OUTBOX, String(name)))) {
        reportSeen(`Report: ${name}`, String(name).replace(/\.(md|txt)$/i, ""));
      }
    });
    context.subscriptions.push({ dispose: () => ow.close() });
  } catch (e) { log(`outbox watch failed: ${e.message}`); }
  let scanned = readAll().length;
  function scanAgentPosts() {
    const msgs = readAll();
    if (scanned > msgs.length) scanned = 0;
    for (const m of msgs.slice(scanned)) {
      if (m.from === ME && (m.type === "result" || (m.type === "message" && !/^[🔧📨⚠⏭📝]/u.test(m.text)))) {
        reportSeen(m.text.slice(0, 80), m.replyTo || null, m.type === "message" ? "question" : "report");
      }
    }
    scanned = msgs.length;
  }
  if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, "");
  fs.watchFile(LOG_FILE, { interval: 1000 }, () => { checkInbox(); scanAgentPosts(); });
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
    vscode.commands.registerCommand("agentBridge.sendLastToAgent", () => {
      if (!lastClaude) return vscode.window.showInformationMessage("No messages from Claude yet.");
      unreadCount = 0;
      renderBar();
      enqueueForAgent(lastClaude.text, lastClaude.id);
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

#!/usr/bin/env node
/*
 * Agent Bridge installer — Claude Code <-> Google Antigravity
 *
 *   node setup.js                 install, or upgrade any older install
 *   node setup.js --uninstall     remove everything
 *   node setup.js --no-restart    don't close/reopen Antigravity and Claude
 *   node setup.js --dry-run       show what would change, change nothing
 *   node setup.js --no-autosave   leave Antigravity's auto-save setting alone
 *
 * No npm install needed: the server ships pre-bundled in server/dist.
 * Every config file is backed up once as <file>.bak-agent-bridge before the first edit.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const args = new Set(process.argv.slice(2));
const UNINSTALL = args.has("--uninstall");
const DRY = args.has("--dry-run");
const RESTART = !args.has("--no-restart") && !DRY;
const AUTOSAVE = !args.has("--no-autosave");
const WIN = process.platform === "win32";
const MAC = process.platform === "darwin";

const HOME = os.homedir();
const ROOT = __dirname;
const BUS = path.join(HOME, ".agent-bridge");
const APP = path.join(BUS, "app");
const SERVER = path.join(APP, "server.mjs");
const HOOK = path.join(APP, "claude-hook.mjs");
const NODE = process.execPath; // absolute: GUI apps often don't share the terminal's PATH
const EXT_SRC = path.join(ROOT, "extension");
const EXT_PKG = JSON.parse(fs.readFileSync(path.join(EXT_SRC, "package.json"), "utf8"));
const EXT_ID = `${EXT_PKG.publisher}.${EXT_PKG.name}`.toLowerCase();
const EXT_DIRNAME = `${EXT_ID}-${EXT_PKG.version}`;
const MARK_START = "<!-- agent-bridge:start -->";
const MARK_END = "<!-- agent-bridge:end -->";

// ---------------------------------------------------------------- output
const C = !process.stdout.isTTY ? { g: "", y: "", r: "", d: "", x: "" }
  : { g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", d: "\x1b[2m", x: "\x1b[0m" };
const ok = (s) => console.log(`  ${C.g}\u2714${C.x} ${s}`);
const info = (s) => console.log(`  ${C.d}\u2022 ${s}${C.x}`);
const warn = (s) => console.log(`  ${C.y}!${C.x} ${s}`);
const step = (s) => console.log(`\n${s}`);
const short = (p) => p.replace(HOME, "~");

// ---------------------------------------------------------------- helpers
const q = (a) => (WIN && /[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
function run(cmd, argv, opts = {}) {
  return spawnSync(q(cmd), argv.map(q), { stdio: "pipe", shell: WIN, encoding: "utf8", timeout: 60000, ...opts });
}
function ps(script) {
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", timeout: 60000 });
}

/** JSON with // and /* comments and trailing commas tolerated (VS Code-style files). */
function readJson(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch {}
  const stripped = raw
    .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str || "")
    .replace(/,(\s*[}\]])/g, "$1");
  try { return JSON.parse(stripped); }
  catch { throw new Error(`${file} is not valid JSON. Fix it (or rename it) and run the installer again.`); }
}
function backup(file) {
  if (fs.existsSync(file) && !fs.existsSync(file + ".bak-agent-bridge")) fs.copyFileSync(file, file + ".bak-agent-bridge");
}
function writeFile(file, text) {
  if (DRY) return info(`(dry run) would write ${short(file)}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  backup(file);
  fs.writeFileSync(file, text);
}
const writeJson = (file, obj) => writeFile(file, JSON.stringify(obj, null, 2) + "\n");
function rm(p) { if (!DRY) fs.rmSync(p, { recursive: true, force: true }); }
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.endsWith(".vsix")) continue;
    const a = path.join(from, e.name), b = path.join(to, e.name);
    e.isDirectory() ? copyDir(a, b) : fs.copyFileSync(a, b);
  }
}
/** Set or remove mcpServers["agent-bridge"] in a JSON config. */
function setMcp(file, entry) {
  const j = readJson(file);
  const had = !!j.mcpServers?.["agent-bridge"];
  if (!entry && !had) return false;
  j.mcpServers = j.mcpServers || {};
  if (entry) j.mcpServers["agent-bridge"] = entry;
  else delete j.mcpServers["agent-bridge"];
  writeJson(file, j);
  return true;
}
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };

// ---------------------------------------------------------------- where things live
const appData = process.env.APPDATA || path.join(HOME, "AppData", "Roaming");
const localAppData = process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local");

/** Antigravity profiles: newer builds use "-ide" folders, older ones don't. */
function antigravityProfiles() {
  const out = [];
  for (const suffix of ["-ide", ""]) {
    const dataDir = path.join(HOME, ".gemini", `antigravity${suffix}`);   // agent data + mcp_config.json
    const extDir = path.join(HOME, `.antigravity${suffix}`, "extensions"); // editor extensions
    if (exists(dataDir) || exists(extDir)) out.push({ name: `antigravity${suffix}`, dataDir, extDir });
  }
  return out;
}

function claudeDesktopConfigs() {
  const dirs = [];
  if (WIN) {
    dirs.push(path.join(appData, "Claude"));
    // Microsoft Store (MSIX) installs keep a virtualised copy of AppData
    const pk = path.join(localAppData, "Packages");
    try {
      for (const d of fs.readdirSync(pk)) {
        if (/^(Anthropic|Claude)/i.test(d)) dirs.push(path.join(pk, d, "LocalCache", "Roaming", "Claude"));
      }
    } catch {}
  } else if (MAC) {
    dirs.push(path.join(HOME, "Library", "Application Support", "Claude"));
  } else {
    dirs.push(path.join(HOME, ".config", "Claude"));
  }
  // only where Claude desktop actually keeps its data
  return dirs.filter(exists).map((d) => path.join(d, "claude_desktop_config.json"));
}

// ---------------------------------------------------------------- steps
function checkFiles() {
  for (const f of ["server/dist/server.mjs", "server/dist/claude-hook.mjs", "extension/extension.js"]) {
    if (!exists(path.join(ROOT, f))) {
      throw new Error(`Missing ${f}. Extract the whole zip first (right-click > Extract All), then run Install.bat from the extracted folder.`);
    }
  }
}

function installServer() {
  step("Bridge server");
  if (UNINSTALL) {
    rm(APP);
    return ok(`Removed ${short(APP)} (messages kept in ${short(BUS)})`);
  }
  rm(APP); // also clears node_modules etc. from older installs
  if (!DRY) {
    fs.mkdirSync(APP, { recursive: true });
    for (const f of ["server.mjs", "claude-hook.mjs"]) fs.copyFileSync(path.join(ROOT, "server", "dist", f), path.join(APP, f));
    fs.writeFileSync(path.join(APP, "VERSION"), EXT_PKG.version + "\n");
    // sanity check: the server must start and answer an MCP initialize
    const r = spawnSync(NODE, [SERVER], {
      input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "setup", version: "0" } } }) + "\n",
      encoding: "utf8", timeout: 15000, env: { ...process.env, BRIDGE_AGENT: "claude" },
    });
    if (!/"serverInfo"/.test(r.stdout || "")) throw new Error("Bridge server failed to start:\n" + (r.stderr || r.stdout || r.error));
  }
  ok(`Installed to ${short(APP)} and verified it starts`);
}

function claudeCode() {
  step("Claude Code");
  // 1) user-scope MCP server (CLI and the desktop app's Code tab read ~/.claude.json)
  const entry = UNINSTALL ? null : { type: "stdio", command: NODE, args: [SERVER], env: { BRIDGE_AGENT: "claude" } };
  const cj = path.join(HOME, ".claude.json");
  if (UNINSTALL && !exists(cj)) { /* nothing */ }
  else if (setMcp(cj, entry)) ok(`${UNINSTALL ? "Removed MCP server from" : "Registered MCP server in"} ${short(cj)}`);

  // 2) prompt hook in ~/.claude/settings.json
  const sf = path.join(HOME, ".claude", "settings.json");
  if (UNINSTALL && !exists(sf)) return;
  const s = readJson(sf);
  const isOurs = (h) => /claude-hook\.(m?js)/.test(String(h?.command || "")) && /agent-bridge/.test(String(h?.command || ""));
  const before = JSON.stringify(s.hooks?.UserPromptSubmit || []);
  const groups = (s.hooks?.UserPromptSubmit || [])
    .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) }))
    .filter((g) => g.hooks.length);
  if (!UNINSTALL) groups.push({ hooks: [{ type: "command", command: `"${NODE}" "${HOOK}"`, timeout: 10 }] });
  if (JSON.stringify(groups) === before) return;
  s.hooks = s.hooks || {};
  if (groups.length) s.hooks.UserPromptSubmit = groups; else delete s.hooks.UserPromptSubmit;
  if (!Object.keys(s.hooks).length) delete s.hooks;
  writeJson(sf, s);
  ok(`${UNINSTALL ? "Removed" : "Added"} live-update hook in ${short(sf)}`);
}

function claudeDesktop() {
  const files = claudeDesktopConfigs();
  if (!files.length) return;
  step("Claude desktop app");
  const entry = UNINSTALL ? null : { command: NODE, args: [SERVER], env: { BRIDGE_AGENT: "claude" } };
  for (const f of files) if (setMcp(f, entry)) ok(`${UNINSTALL ? "Removed from" : "Added to"} ${short(f)}`);
}

function antigravity() {
  const profiles = antigravityProfiles();
  step("Antigravity");
  if (!profiles.length) return warn("Antigravity not found (no ~/.gemini/antigravity* folder). Skipped — run again after installing it.");
  // Current Antigravity builds load agent connectors from ~/.gemini/config/mcp_config.json
  const sharedCfgDir = path.join(HOME, ".gemini", "config");
  if (exists(sharedCfgDir)) {
    const mf = path.join(sharedCfgDir, "mcp_config.json");
    const entry = UNINSTALL ? null : { command: NODE, args: [SERVER], env: { BRIDGE_AGENT: "antigravity" } };
    if ((exists(mf) || !UNINSTALL) && setMcp(mf, entry)) ok(`${UNINSTALL ? "Removed MCP server from" : "Registered MCP server in"} ${short(mf)}`);
  }
  for (const p of profiles) {
    // MCP server for Antigravity's agent (older builds read it from the profile folder)
    if (exists(p.dataDir) || !UNINSTALL) {
      const mf = path.join(p.dataDir, "mcp_config.json");
      const entry = UNINSTALL ? null : { command: NODE, args: [SERVER], env: { BRIDGE_AGENT: "antigravity" } };
      if ((exists(p.dataDir) || exists(p.extDir)) && setMcp(mf, entry)) ok(`${UNINSTALL ? "Removed MCP server from" : "Registered MCP server in"} ${short(mf)}`);
    }
  }
  // Extension goes into the newest profile only (two copies would report every step twice);
  // any copy left in an older profile is removed.
  const withExt = profiles.filter((p) => exists(p.extDir));
  withExt.forEach((p, i) => installExtension(p.extDir, UNINSTALL || i > 0));
}

/** Install the extension by copying it into the extensions folder and registering it,
 *  exactly like "Install from VSIX" does — no Antigravity CLI needed. */
function installExtension(extDir, removeOnly = false) {
  const reg = path.join(extDir, "extensions.json");
  let list = [];
  if (exists(reg)) {
    const j = readJson(reg);
    list = Array.isArray(j) ? j : [];
  }
  const mine = (e) => String(e?.identifier?.id || "").toLowerCase() === EXT_ID;
  // remove every older/other copy of this extension
  const removed = [];
  for (const e of list.filter(mine)) if (e.relativeLocation) removed.push(e.relativeLocation);
  try {
    for (const d of fs.readdirSync(extDir)) if (d.toLowerCase().startsWith(EXT_ID + "-")) removed.push(d);
  } catch {}
  for (const d of new Set(removed)) rm(path.join(extDir, d));
  list = list.filter((e) => !mine(e));

  if (!removeOnly) {
    const target = path.join(extDir, EXT_DIRNAME);
    if (!DRY) copyDir(EXT_SRC, target);
    let p = target.replace(/\\/g, "/");
    if (/^[A-Za-z]:/.test(p)) p = "/" + p[0].toLowerCase() + p.slice(1);
    list.push({
      identifier: { id: EXT_ID },
      version: EXT_PKG.version,
      location: { $mid: 1, path: p, scheme: "file" },
      relativeLocation: EXT_DIRNAME,
      metadata: { installedTimestamp: Date.now(), pinned: true, source: "vsix" },
    });
  }
  if (removeOnly && !removed.length) return;
  if (exists(reg) || !removeOnly) writeJson(reg, list);

  // un-mark our folder if the editor had flagged it obsolete
  const obs = path.join(extDir, ".obsolete");
  if (exists(obs)) {
    const o = readJson(obs);
    let changed = false;
    for (const k of Object.keys(o)) if (k.toLowerCase().startsWith(EXT_ID + "-")) { delete o[k]; changed = true; }
    if (changed) writeJson(obs, o);
  }
  const old = [...new Set(removed)].filter((d) => d !== EXT_DIRNAME);
  if (removeOnly) ok(`Removed extension from ${short(extDir)}`);
  else ok(`Installed extension v${EXT_PKG.version} in ${short(extDir)}${old.length ? ` (replaced ${old.join(", ")})` : ""}`);
}

function agentRules() {
  step("Agent instructions");
  const rules = {
    [path.join(HOME, ".claude", "CLAUDE.md")]:
`## Working alongside Antigravity (agent-bridge)
Google Antigravity's agent may be working on this machine at the same time. You are connected to it through the agent-bridge MCP tools.
- Antigravity updates arrive in <antigravity_bridge> blocks; take them into account.
- Before editing files outside your current task, call get_antigravity_progress and check lastActivity to see whether it is current.
- To hand work to Antigravity, call send_message (it runs in Antigravity's agent right away). To wait for the outcome, call wait_for_antigravity with the returned task_id.
- When you start or finish a chunk of work, or claim a file, tell Antigravity with send_message type "progress".`,
    [path.join(HOME, ".gemini", "GEMINI.md")]:
`## Working alongside Claude Code (agent-bridge)
Claude Code may be working on this machine at the same time. You are connected to it through the agent-bridge MCP tools.
- At the start of each task and before editing shared files, call read_messages.
- Use ONLY the agent-bridge MCP tools to talk to Claude. Never read or write the ~/.agent-bridge files directly; if the tools aren't available, tell the user.
- Tasks from Claude arrive as "[Task from Claude Code via agent-bridge] Task ID: …". When you finish one (or get blocked), ALWAYS call send_message with type "result", reply_to set to that Task ID, and a short report: what you did, files changed, build/test results, anything left.
- When you need Claude to do something, call send_message with type "message".`,
  };
  for (const [file, body] of Object.entries(rules)) {
    if (!exists(path.dirname(file)) && !UNINSTALL) continue; // that app isn't installed
    let text = exists(file) ? fs.readFileSync(file, "utf8") : "";
    const i = text.indexOf(MARK_START), j = text.indexOf(MARK_END);
    const had = i !== -1 && j !== -1;
    if (had) text = (text.slice(0, i) + text.slice(j + MARK_END.length)).replace(/\n{3,}/g, "\n\n").trimEnd();
    if (UNINSTALL && !had) continue;
    if (!UNINSTALL) text = (text.trim() ? text.trimEnd() + "\n\n" : "") + `${MARK_START}\n${body}\n${MARK_END}`;
    writeFile(file, text ? text + "\n" : "");
    ok(`${UNINSTALL ? "Removed" : had ? "Updated" : "Added"} instructions in ${short(file)}`);
  }
}


/** Antigravity's editor settings.json files (one per installed edition). */
function antigravityUserSettings() {
  const bases = WIN ? [appData] : MAC ? [path.join(HOME, "Library", "Application Support")] : [path.join(HOME, ".config")];
  const out = [];
  for (const b of bases) for (const name of ["Antigravity IDE", "Antigravity"]) {
    const dir = path.join(b, name, "User");
    if (exists(dir)) out.push(path.join(dir, "settings.json"));
  }
  return out;
}

/** Agent edits land in open editor tabs; without auto-save they wait for a manual Save.
 *  Turn on auto-save (1s) unless the user already chose a mode. Remembered so uninstall can undo it. */
function autoSave() {
  if (!AUTOSAVE && !UNINSTALL) return;
  const files = antigravityUserSettings();
  if (!files.length) return;
  const stateFile = path.join(BUS, "installer-state.json");
  const state = readJson(stateFile);
  state.autoSaveSetBy = state.autoSaveSetBy || [];
  step("Antigravity auto-save");
  for (const f of files) {
    const j = readJson(f);
    if (UNINSTALL) {
      if (state.autoSaveSetBy.includes(f) && j["files.autoSave"] === "afterDelay") {
        delete j["files.autoSave"];
        delete j["files.autoSaveDelay"];
        writeJson(f, j);
        ok(`Turned auto-save back off in ${short(f)}`);
      }
      continue;
    }
    const cur = j["files.autoSave"];
    if (cur && cur !== "off") { info(`Auto-save already "${cur}" in ${short(f)}; left as is`); continue; }
    j["files.autoSave"] = "afterDelay";
    if (j["files.autoSaveDelay"] === undefined) j["files.autoSaveDelay"] = 1000;
    writeJson(f, j);
    if (!state.autoSaveSetBy.includes(f)) state.autoSaveSetBy.push(f);
    ok(`Turned on auto-save in ${short(f)} so agent edits are saved without clicking Save`);
  }
  if (UNINSTALL) state.autoSaveSetBy = [];
  if (!DRY && exists(BUS)) fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
}

// ---------------------------------------------------------------- restart apps (Windows)
const PS_FIND = {
  antigravity: `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -match '\\\\Antigravity[^\\\\]*\\\\[^\\\\]*antigravity[^\\\\]*\\.exe$' } | Select-Object -ExpandProperty ExecutablePath -Unique`,
  claude: `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -match '\\\\(AnthropicClaude|Claude[^\\\\]*)\\\\(app[^\\\\]*\\\\)?claude\\.exe$' -and $_.ExecutablePath -notmatch '\\\\(extensions|\\.local|node_modules|npm|\\.claude)\\\\' } | Select-Object -ExpandProperty ExecutablePath -Unique`,
};
function findRunning(app) {
  if (!WIN) return [];
  const r = ps(PS_FIND[app]);
  return (r.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}
function closeApp(exePath, force) {
  const esc = exePath.replace(/'/g, "''");
  ps(`$p = Get-Process | Where-Object { $_.Path -eq '${esc}' };` +
     (force ? `$p | Stop-Process -Force` : `$p | ForEach-Object { [void]$_.CloseMainWindow() }`));
  for (let i = 0; i < 20; i++) {
    const r = ps(`@(Get-Process | Where-Object { $_.Path -eq '${esc}' }).Count`);
    if ((r.stdout || "").trim() === "0") return true;
    spawnSync(NODE, ["-e", "setTimeout(()=>{},500)"]);
  }
  return false;
}
function launch(exePath, appName) {
  const esc = exePath.replace(/'/g, "''");
  if (/\\WindowsApps\\/i.test(exePath)) {
    // Store apps can't be started from their exe; go through the Start menu entry
    ps(`$a = Get-StartApps | Where-Object { $_.Name -eq '${appName}' } | Select-Object -First 1; if ($a) { Start-Process ('shell:AppsFolder\\' + $a.AppID) }`);
  } else {
    ps(`Start-Process -FilePath '${esc}'`);
  }
}
const running = { antigravity: [], claude: [] };
function detectRunning() {
  if (!WIN || !RESTART) return;
  running.antigravity = findRunning("antigravity");
  running.claude = findRunning("claude");
  if (running.antigravity.length) {
    step("Closing Antigravity (it rewrites its extension list on exit)");
    for (const exe of running.antigravity) {
      if (closeApp(exe, false)) ok("Antigravity closed");
      else warn("Antigravity didn't close (unsaved files?). Close it yourself, then run the installer again.");
    }
  }
}
function restartApps() {
  if (!WIN || !RESTART) return;
  step("Restarting apps");
  for (const exe of running.antigravity) { launch(exe, "Antigravity"); ok("Reopened Antigravity"); }
  for (const exe of running.claude) {
    // Claude minimises to the tray on close, so it has to be ended; chats are saved server-side
    closeApp(exe, true);
    launch(exe, "Claude");
    ok("Restarted Claude desktop app — open your chat from the sidebar, history is kept");
  }
  if (!running.antigravity.length && !running.claude.length) info("Neither app was running; they'll pick the bridge up next time you open them.");
}

// ---------------------------------------------------------------- main
(function main() {
  console.log(`\nClaude-Antigravity Agent Bridge v${EXT_PKG.version} — ${UNINSTALL ? "uninstall" : "install"}${DRY ? " (dry run)" : ""}`);
  try {
    const major = +process.versions.node.split(".")[0];
    if (major < 18) throw new Error(`Node.js 18 or newer is required (found ${process.version}).`);
    checkFiles();
    detectRunning();
    installServer();
    claudeCode();
    claudeDesktop();
    antigravity();
    autoSave();
    agentRules();
    restartApps();
    console.log(UNINSTALL
      ? `\n${C.g}Agent Bridge removed.${C.x} Message history is still in ${short(BUS)} — delete that folder to wipe it.\n`
      : `\n${C.g}All done.${C.x} In Claude, run /mcp to see "agent-bridge", or ask: "What is Antigravity doing right now?"\n`);
  } catch (e) {
    console.error(`\n${C.r}\u2716 ${e.message}${C.x}\n`);
    if (WIN && RESTART) for (const exe of running.antigravity) launch(exe, "Antigravity");
    process.exit(1);
  }
})();

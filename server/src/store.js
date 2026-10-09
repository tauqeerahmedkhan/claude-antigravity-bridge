// Shared message bus + Antigravity artifact reader.
// Everything lives in plain files so Claude Code, Antigravity's agent and the
// Antigravity extension can all talk without a running daemon.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export const BRIDGE_DIR =
  process.env.AGENT_BRIDGE_DIR || path.join(os.homedir(), ".agent-bridge");
export const LOG_FILE = path.join(BRIDGE_DIR, "messages.jsonl");
// Newer Antigravity builds use ~/.gemini/antigravity-ide, older ones ~/.gemini/antigravity.
export const BRAIN_DIRS = process.env.ANTIGRAVITY_BRAIN_DIR
  ? process.env.ANTIGRAVITY_BRAIN_DIR.split(path.delimiter)
  : ["antigravity-ide", "antigravity"].map((d) => path.join(os.homedir(), ".gemini", d, "brain"));
export const BRAIN_DIR = BRAIN_DIRS[0];

function ensureDir() {
  fs.mkdirSync(BRIDGE_DIR, { recursive: true });
}

/** Append one message. type: "message" | "progress" */
export function post({ from, to = "all", type = "message", text, meta }) {
  if (!text || !String(text).trim()) throw new Error("text is required");
  ensureDir();
  const msg = {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    from,
    to,
    type,
    text: String(text),
    ...(meta ? { meta } : {}),
  };
  fs.appendFileSync(LOG_FILE, JSON.stringify(msg) + "\n", "utf8");
  return msg;
}

export function readAll() {
  let raw;
  try {
    raw = fs.readFileSync(LOG_FILE, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip a half-written line */
    }
  }
  return out;
}

function cursorFile(name) {
  return path.join(BRIDGE_DIR, `cursor-${name}.json`);
}

/**
 * Messages addressed to `agent` (or "all", excluding its own) that this cursor
 * hasn't seen. Each reader keeps its own cursor, so the extension's popups
 * never "steal" messages from the agent itself.
 */
export function unread(agent, { cursor = agent, markRead = true } = {}) {
  const msgs = readAll();
  let index = 0;
  try {
    index = JSON.parse(fs.readFileSync(cursorFile(cursor), "utf8")).index || 0;
  } catch {
    /* first read */
  }
  if (index > msgs.length) index = 0; // log was cleared
  const fresh = msgs
    .slice(index)
    .filter((m) => m.from !== agent && (m.to === agent || m.to === "all"));
  if (markRead) {
    ensureDir();
    fs.writeFileSync(cursorFile(cursor), JSON.stringify({ index: msgs.length }));
  }
  return fresh;
}

export function recent(limit = 20) {
  return readAll().slice(-limit);
}

export function clearLog() {
  ensureDir();
  fs.writeFileSync(LOG_FILE, "");
  for (const f of fs.readdirSync(BRIDGE_DIR)) {
    if (f.startsWith("cursor-")) fs.rmSync(path.join(BRIDGE_DIR, f));
  }
}

// ---------- Antigravity artifacts ----------

const MSG_SUBDIR = path.join(".system_generated", "messages");

function newestMtime(dir) {
  let newest = 0;
  for (const sub of [dir, path.join(dir, MSG_SUBDIR)]) {
    let names = [];
    try { names = fs.readdirSync(sub); } catch { continue; }
    for (const f of names) {
      try {
        const s = fs.statSync(path.join(sub, f));
        if (s.isFile() && s.mtimeMs > newest) newest = s.mtimeMs;
      } catch {}
    }
  }
  return newest;
}

function convDir(id) {
  const safe = path.basename(id); // basename blocks ../
  for (const b of BRAIN_DIRS) {
    const d = path.join(b, safe);
    if (fs.existsSync(d)) return d;
  }
  return null;
}

/** Antigravity conversations across all known brain dirs, newest activity first. */
export function listConversations(limit = 10) {
  const out = [];
  for (const base of BRAIN_DIRS) {
    let entries = [];
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const d of entries) {
      if (!d.isDirectory() || d.name.startsWith(".") || d.name === "tempmediaStorage") continue;
      const dir = path.join(base, d.name);
      const artifacts = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
      let steps = 0;
      try { steps = fs.readdirSync(path.join(dir, MSG_SUBDIR)).filter((f) => f.endsWith(".json") && f !== "read.json").length; } catch {}
      if (!artifacts.length && !steps) continue;
      out.push({ id: d.name, updated: newestMtime(dir), artifacts, recent_steps: steps, source: path.basename(path.dirname(base)) });
    }
  }
  return out
    .sort((a, b) => b.updated - a.updated)
    .slice(0, limit)
    .map((c) => ({ ...c, updated: new Date(c.updated).toISOString() }));
}

export function readArtifacts(conversationId) {
  const id = conversationId || listConversations(1)[0]?.id;
  if (!id) return null;
  const dir = convDir(id);
  if (!dir) return null;
  const artifacts = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({
      name: f,
      updated: new Date(fs.statSync(path.join(dir, f)).mtimeMs).toISOString(),
      content: fs.readFileSync(path.join(dir, f), "utf8"),
    }));
  return { id, artifacts };
}

/** Turn one .system_generated/messages/*.json file into a compact step. */
export function parseStep(json) {
  const tool = json?.sourceMetadata?.tool || {};
  let args = {};
  try { args = JSON.parse(tool.toolCall?.argumentsJson || "{}"); } catch {}
  const content = String(json.content || "");
  const exit = content.match(/exited with code (-?\d+)/);
  return {
    ts: json.timestamp,
    title: json.renderDetails?.messageTitle || args.toolSummary || tool.toolCall?.name || "step",
    tool: tool.toolCall?.name,
    command: args.CommandLine,
    cwd: args.Cwd,
    exitCode: exit ? Number(exit[1]) : undefined,
    step: tool.stepIndex,
  };
}

/** Most recent agent steps (newest last) for a conversation. */
export function recentSteps(conversationId, limit = 10) {
  const id = conversationId || listConversations(1)[0]?.id;
  const dir = id && convDir(id);
  if (!dir) return [];
  const mdir = path.join(dir, MSG_SUBDIR);
  let files = [];
  try { files = fs.readdirSync(mdir).filter((f) => f.endsWith(".json") && f !== "read.json"); } catch { return []; }
  const steps = [];
  for (const f of files) {
    try { steps.push(parseStep(JSON.parse(fs.readFileSync(path.join(mdir, f), "utf8")))); } catch {}
  }
  return steps.sort((a, b) => String(a.ts).localeCompare(String(b.ts))).slice(-limit);
}

/** Checkbox items from a task.md: [ ] todo, [/] in progress, [x] done. */
export function parseTasks(md) {
  const items = [];
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(/^\s*[-*]\s*\[( |x|X|\/)\]\s+(.*\S)\s*$/);
    if (m) {
      const state = m[1] === " " ? "todo" : m[1] === "/" ? "doing" : "done";
      items.push({ state, text: m[2] });
    }
  }
  return items;
}

export function summarizeProgress(conversationId) {
  const conv = readArtifacts(conversationId);
  if (!conv) return null;
  const task = conv.artifacts.find((a) => a.name.toLowerCase() === "task.md");
  const items = task ? parseTasks(task.content) : [];
  const count = (s) => items.filter((i) => i.state === s).length;
  const steps = recentSteps(conv.id, 8);
  const last = steps[steps.length - 1];
  return {
    conversationId: conv.id,
    lastActivity: last?.ts || null,
    minutesSinceLastActivity: last ? Math.round((Date.now() - Date.parse(last.ts)) / 60000) : null,
    recentSteps: steps.map((s) => ({
      ts: s.ts,
      title: s.title,
      ...(s.command ? { command: s.command } : {}),
      ...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}),
    })),
    taskList: items.length
      ? { done: count("done"), doing: count("doing"), todo: count("todo"),
          current: items.filter((i) => i.state === "doing").map((i) => i.text),
          next: items.filter((i) => i.state === "todo").slice(0, 3).map((i) => i.text) }
      : null,
    artifacts: conv.artifacts.map((a) => ({ name: a.name, updated: a.updated })),
  };
}

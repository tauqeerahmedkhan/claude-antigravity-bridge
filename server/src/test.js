// End-to-end test of the bundled server (dist/): a "claude" and an "antigravity"
// instance talk over stdio in a temp sandbox. Run: npm test
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn as spawnFn } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-test-"));
const brain = path.join(sandbox, "brain");
const conv = path.join(brain, "1234-abcd");
fs.mkdirSync(conv, { recursive: true });
fs.writeFileSync(
  path.join(conv, "task.md"),
  "# Task\n- [x] Scaffold API\n- [/] Write invoice endpoint\n- [ ] Add tests\n"
);
// new-style Antigravity step message
const mdir = path.join(conv, ".system_generated", "messages");
fs.mkdirSync(mdir, { recursive: true });
fs.writeFileSync(path.join(mdir, "read.json"), "{}");
fs.writeFileSync(path.join(mdir, "a1.json"), JSON.stringify({
  id: "a1", timestamp: new Date().toISOString(),
  renderDetails: { messageTitle: "Run frontend build finished" },
  content: "Task finished with result: The command exited with code 0.",
  sourceMetadata: { tool: { stepIndex: 7, toolCall: { name: "run_command",
    argumentsJson: JSON.stringify({ CommandLine: "npm run build", Cwd: "e:/proj/frontend" }) } } },
}));
const env = { ...process.env, AGENT_BRIDGE_DIR: path.join(sandbox, "bus"), ANTIGRAVITY_BRAIN_DIR: brain };
const here = path.dirname(fileURLToPath(import.meta.url));

async function connect(agent) {
  const c = new Client({ name: `test-${agent}`, version: "0" });
  await c.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(here, "..", "dist", "server.mjs")],
    env: { ...env, BRIDGE_AGENT: agent },
  }));
  return c;
}
const call = async (c, name, args = {}) =>
  (await c.callTool({ name, arguments: args })).content[0].text;

const claude = await connect("claude");
const ag = await connect("antigravity");

const tools = (await claude.listTools()).tools.map((t) => t.name).sort();
console.log("tools:", tools.join(", "));
assert.equal(tools.length, 6);

await call(claude, "send_message", { text: "I'm editing src/billing.ts, avoid it" });
let got = await call(ag, "read_messages");
console.log("antigravity got ->", got);
assert.match(got, /billing\.ts/);
assert.match(await call(ag, "read_messages"), /No new messages/);

await call(ag, "send_message", { text: "OK. Invoice endpoint done", type: "progress" });
got = await call(claude, "read_messages");
console.log("claude got      ->", got);
assert.match(got, /Invoice endpoint done/);

const prog = JSON.parse(await call(claude, "get_antigravity_progress"));
console.log("progress        ->", prog.taskList);
assert.deepEqual([prog.taskList.done, prog.taskList.doing, prog.taskList.todo], [1, 1, 1]);
console.log("last step       ->", prog.recentSteps.at(-1));
assert.equal(prog.recentSteps.at(-1).title, "Run frontend build finished");
assert.equal(prog.recentSteps.at(-1).exitCode, 0);
assert.match(await call(claude, "read_antigravity_artifact", { name: "task.md" }), /Add tests/);

// Hook shares Claude's cursor: it shows only messages Claude hasn't seen yet
await call(ag, "send_message", { text: "Starting tests now", type: "progress" });
const hookOut = execFileSync(process.execPath, [path.join(here, "..", "dist", "claude-hook.mjs")], { env }).toString();
console.log("hook output     ->\n" + hookOut);
assert.match(hookOut, /Starting tests now/);
assert.doesNotMatch(hookOut, /Invoice endpoint done/);
assert.match(hookOut, /1 in progress/);
assert.match(hookOut, /last step .*Run frontend build finished \[exit 0\]/);

// ---- send + wait (short polls, desktop app cancels tool calls at ~60 s) ----
const deliver = (id) => store_post({ from: "antigravity", to: "claude", type: "progress", text: `📨 Delivered to the Antigravity agent: "${id}"` });
const busFile = path.join(sandbox, "bus", "messages.jsonl");
function store_post(m) {
  fs.appendFileSync(busFile, JSON.stringify({ id: Math.random().toString(36).slice(2), ts: new Date().toISOString(), ...m }) + "\n");
}
const t0 = Date.now();
setTimeout(() => deliver("x"), 500);
setTimeout(() => fs.writeFileSync(path.join(mdir, "b1.json"), JSON.stringify({ timestamp: new Date().toISOString(), renderDetails: { messageTitle: "Run round 9 finished" }, content: "exited with code 0" })), 1500);
setTimeout(() => call(ag, "send_message", { type: "result", text: "Round 9: 42/42 checks passed" }), 3000);
let sent = await call(claude, "send_message", { text: "Run the Round 9 checks", wait_seconds: 20 });
console.log("send+wait       ->", sent.split("\n").slice(0, 4).join(" / "), `| ${((Date.now() - t0) / 1000).toFixed(1)}s`);
assert.match(sent, /Prompt delivered:\n---\nRun the Round 9 checks\n---/);
let w = JSON.parse(sent.slice(sent.indexOf("{")));
assert.equal(w.status, "finished");
assert.match(w.antigravity_report, /42\/42/);
assert.ok(w.latest_steps.some((s) => s.includes("Run round 9 finished ✓")));
const taskId = w.task_id;
const raw = fs.readFileSync(busFile, "utf8");
assert.ok(raw.includes(`"replyTo":"${taskId}"`), "result auto-linked to the task");
// asking again later still finds the report, even though it was already marked read
w = JSON.parse(await call(claude, "wait_for_antigravity", { task_id: taskId, wait_seconds: 5 }));
assert.equal(w.status, "finished");

// still_running then finished across two short calls
sent = await call(claude, "send_message", { text: "Long task", wait_seconds: 0 });
const id2 = sent.match(/task_id: ([\w-]+)/)[1];
deliver("y");
w = JSON.parse(await call(claude, "wait_for_antigravity", { task_id: id2, wait_seconds: 5 }));
console.log("poll 1          ->", w.status);
assert.equal(w.status, "still_running");
setTimeout(() => call(ag, "send_message", { type: "result", reply_to: id2, text: "Long task done" }), 1000);
w = JSON.parse(await call(claude, "wait_for_antigravity", { task_id: id2, wait_seconds: 10 }));
console.log("poll 2          ->", w.status, "|", w.antigravity_report);
assert.equal(w.status, "finished");

// question, then answered -> no longer needs_reply
sent = await call(claude, "send_message", { text: "Task 3", wait_seconds: 0 });
const id3 = sent.match(/task_id: ([\w-]+)/)[1];
deliver("z");
setTimeout(() => call(ag, "send_message", { text: "Should I also update the walkthrough?" }), 800);
w = JSON.parse(await call(claude, "wait_for_antigravity", { task_id: id3, wait_seconds: 10 }));
console.log("question        ->", w.status, "|", w.antigravity_question);
assert.equal(w.status, "needs_reply");

// idle: activity then quiet
setTimeout(() => fs.writeFileSync(path.join(mdir, "b2.json"), JSON.stringify({ timestamp: new Date().toISOString(), renderDetails: { messageTitle: "Edit file" } })), 500);
await call(claude, "send_message", { text: "Yes please", type: "progress" });
w = JSON.parse(await call(claude, "wait_for_antigravity", { task_id: id3, wait_seconds: 20, idle_seconds: 5 }));
console.log("idle            ->", w.status);
assert.equal(w.status, "idle");

// ---- regression: agent hand-wrote two results joined by a literal "\n", no trailing newline ----
const bus = path.join(sandbox, "bus", "messages.jsonl");
const handA = JSON.stringify({ id: "h1", ts: new Date().toISOString(), from: "antigravity", to: "claude", type: "result", reply_to: "t-1", text: "Fix A done" });
const handB = JSON.stringify({ id: "h2", ts: new Date().toISOString(), from: "antigravity", to: "claude", type: "result", reply_to: "t-2", text: "Fix B done" });
fs.appendFileSync(bus, handA + "\\n" + handB); // exactly what PowerShell produced on the user's PC
sent = await call(claude, "send_message", { text: "Next task after the hand-written lines", wait_seconds: 0 });
const after = fs.readFileSync(bus, "utf8").split("\n").filter(Boolean);
assert.ok(after.at(-1).includes("Next task after"), "Claude's message must start on its own line");
got = await call(claude, "read_messages");
console.log("recovered       ->", got.split("\n").map((l) => l.slice(11, 70)));
assert.match(got, /Fix A done/);
assert.match(got, /Fix B done/);
const agSees = await call(ag, "read_messages");
assert.match(agSees, /Next task after the hand-written lines/);

// ---- outbox: agent writes a plain-text report file instead of calling the tool ----
sent = await call(claude, "send_message", { text: "Phase 8 task", wait_seconds: 0 });
const id8 = sent.match(/task_id: ([\w-]+)/)[1];
deliver("p8");
const outbox = path.join(sandbox, "bus", "outbox");
fs.mkdirSync(outbox, { recursive: true });
setTimeout(() => fs.writeFileSync(path.join(outbox, `${id8}.md`), "Phase 8 done.\nFiles: rent_sheet.py\nTests: 12/12 passed"), 1000);
w = JSON.parse(await call(claude, "wait_for_antigravity", { task_id: id8, wait_seconds: 15 }));
console.log("outbox report   ->", w.status, "|", w.antigravity_report?.replace(/\n/g, " / "));
assert.equal(w.status, "finished");
assert.match(w.antigravity_report, /12\/12 passed/);
assert.ok(!fs.existsSync(path.join(outbox, `${id8}.md`)), "report file moved to delivered/");
// several readers racing on the same file must post it only once
fs.writeFileSync(path.join(outbox, "race.md"), "race report");
await new Promise((r) => setTimeout(r, 2200));
const { execFileSync: ex } = await import("node:child_process");
const readerScript = `import('${path.join(here, "store.js").replace(/\\/g, "/")}').then(s => s.readAll())`;
const procs = [1, 2, 3, 4].map(() => new Promise((res) => {
  const cp = (awaitImportSpawn())(process.execPath, ["--input-type=module", "-e", readerScript], { env, stdio: "ignore" });
  cp.on("exit", res);
}));
function awaitImportSpawn() { return spawnFn; }
await Promise.all(procs);
const races = fs.readFileSync(busFile, "utf8").split("\n").filter((l) => l.includes("race report")).length;
console.log("race            -> posted", races, "time(s)");
assert.equal(races, 1);
const diagLog = fs.readFileSync(path.join(sandbox, "bus", "server.log"), "utf8");
assert.match(diagLog, /claude -> send_message/);
assert.match(diagLog, /outbox: delivered/);

await claude.close();
await ag.close();
fs.rmSync(sandbox, { recursive: true, force: true });
console.log("ALL TESTS PASSED");

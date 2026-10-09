// End-to-end test of the bundled server (dist/): a "claude" and an "antigravity"
// instance talk over stdio in a temp sandbox. Run: npm test
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
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

// ---- v1.3: task ids, results, wait_for_antigravity ----
const t0 = Date.now();
let sent = await call(claude, "send_message", { text: "Run the Round 9 checks" });
const taskId = sent.match(/task_id: (\S+)/)[1];
console.log("task sent       ->", taskId);
setTimeout(() => {
  const st = path.join(mdir, "b1.json");
  fs.writeFileSync(st, JSON.stringify({ timestamp: new Date().toISOString(), renderDetails: { messageTitle: "Run round 9 finished" }, content: "exited with code 0" }));
}, 1500);
setTimeout(() => call(ag, "send_message", { type: "result", text: "Round 9: 42/42 checks passed, no files changed" }), 3000);
let w = JSON.parse(await call(claude, "wait_for_antigravity", { task_id: taskId, timeout_seconds: 30 }));
console.log("wait (result)   ->", w.status, "|", w.result, "| steps:", w.steps_while_waiting.map((s) => s.title), `| ${((Date.now() - t0) / 1000).toFixed(1)}s`);
assert.equal(w.status, "finished");
assert.match(w.result, /42\/42/);
assert.ok(w.steps_while_waiting.some((s) => s.title === "Run round 9 finished"));
const raw = fs.readFileSync(path.join(sandbox, "bus", "messages.jsonl"), "utf8");
assert.ok(raw.includes(`"replyTo":"${taskId}"`), "result auto-linked to the task");

setTimeout(() => call(ag, "send_message", { text: "Should I also update the walkthrough?" }), 1500);
w = JSON.parse(await call(claude, "wait_for_antigravity", { timeout_seconds: 30 }));
console.log("wait (question) ->", w.status, "|", w.question);
assert.equal(w.status, "needs_reply");

setTimeout(() => fs.writeFileSync(path.join(mdir, "b2.json"), JSON.stringify({ timestamp: new Date().toISOString(), renderDetails: { messageTitle: "Edit file" } })), 1000);
w = JSON.parse(await call(claude, "wait_for_antigravity", { idle_seconds: 5, timeout_seconds: 60 }));
console.log("wait (idle)     ->", w.status, "after", w.waited_seconds, "s");
assert.equal(w.status, "idle");

w = JSON.parse(await call(claude, "wait_for_antigravity", { timeout_seconds: 5, idle_seconds: 60 }));
console.log("wait (nothing)  ->", w.status);
assert.equal(w.status, "no_activity");

// ---- regression: agent hand-wrote two results joined by a literal "\n", no trailing newline ----
const bus = path.join(sandbox, "bus", "messages.jsonl");
const handA = JSON.stringify({ id: "h1", ts: new Date().toISOString(), from: "antigravity", to: "claude", type: "result", reply_to: "t-1", text: "Fix A done" });
const handB = JSON.stringify({ id: "h2", ts: new Date().toISOString(), from: "antigravity", to: "claude", type: "result", reply_to: "t-2", text: "Fix B done" });
fs.appendFileSync(bus, handA + "\\n" + handB); // exactly what PowerShell produced on the user's PC
sent = await call(claude, "send_message", { text: "Next task after the hand-written lines" });
const after = fs.readFileSync(bus, "utf8").split("\n").filter(Boolean);
assert.ok(after.at(-1).includes("Next task after"), "Claude's message must start on its own line");
got = await call(claude, "read_messages");
console.log("recovered       ->", got.split("\n").map((l) => l.slice(11, 70)));
assert.match(got, /Fix A done/);
assert.match(got, /Fix B done/);
const agSees = await call(ag, "read_messages");
assert.match(agSees, /Next task after the hand-written lines/);

await claude.close();
await ag.close();
fs.rmSync(sandbox, { recursive: true, force: true });
console.log("ALL TESTS PASSED");

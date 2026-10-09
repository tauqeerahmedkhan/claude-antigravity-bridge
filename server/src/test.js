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
assert.equal(tools.length, 5);

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

await claude.close();
await ag.close();
fs.rmSync(sandbox, { recursive: true, force: true });
console.log("ALL TESTS PASSED");

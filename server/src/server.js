#!/usr/bin/env node
// Agent Bridge MCP server. Run one copy per agent; set BRIDGE_AGENT to
// "claude" (Claude Code) or "antigravity" (Antigravity's agent).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as store from "./store.js";

const ME = (process.env.BRIDGE_AGENT || "claude").toLowerCase();
const PEER = ME === "claude" ? "antigravity" : "claude";

const server = new McpServer({ name: "agent-bridge", version: "1.0.0" });
store.diag(`start as ${ME} (node ${process.version})`);

// Log every tool call so a silent failure on either side shows up in ~/.agent-bridge/server.log
const _register = server.registerTool.bind(server);
server.registerTool = (name, def, handler) =>
  _register(name, def, async (args, extra) => {
    store.diag(`${ME} -> ${name} ${JSON.stringify(args).slice(0, 200)}`);
    try {
      const r = await handler(args, extra);
      store.diag(`${ME} <- ${name} ok`);
      return r;
    } catch (e) {
      store.diag(`${ME} <- ${name} ERROR ${e?.stack || e}`);
      throw e;
    }
  });

const text = (obj) => ({
  content: [
    { type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) },
  ],
});

const fmt = (m) =>
  `[${m.ts.slice(11, 19)}] ${m.from}${m.type !== "message" ? ` (${m.type})` : ""}: ${m.text}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The Claude desktop app cancels MCP tool calls after ~60 s, so every wait is short and
// Claude polls with repeated calls. All state is derived from the log, so nothing is lost
// between calls (or if the prompt hook already showed a message).
const MAX_WAIT_S = 55;

async function waitForTask({ taskId, waitSeconds, idleSeconds, extra }) {
  const callStart = Date.now();
  const maxMs = Math.min(waitSeconds ?? 45, MAX_WAIT_S) * 1000;
  const idleMs = (idleSeconds ?? 900) * 1000;
  const progressToken = extra?._meta?.progressToken;
  let tick = 0;
  while (true) {
    const all = store.readAll();
    const task = taskId ? all.find((m) => m.id === taskId) : null;
    if (taskId && !task) return { status: "unknown_task", hint: `No task with id ${taskId}.` };
    const since = task ? Date.parse(task.ts) : callStart;
    const fromAg = all.filter((m) => m.from === PEER && Date.parse(m.ts) >= since);
    const lastClaudeTs = Math.max(since, ...all.filter((m) => m.from === ME && m.to === PEER).map((m) => Date.parse(m.ts)));
    const result = [...fromAg].reverse().find((m) => m.type === "result" && (!taskId || !m.replyTo || m.replyTo === taskId));
    const question = [...fromAg].reverse().find((m) => m.type === "message" && Date.parse(m.ts) >= lastClaudeTs);
    const delivered = fromAg.some((m) => m.type === "progress" && /^📨 Delivered/.test(m.text));
    const steps = store.stepsSince(since);
    // Antigravity only logs background commands as steps, so also watch its conversation folder.
    const convAct = store.conversationActivity();
    const lastActivity = Math.max(0, ...steps.map((s) => Date.parse(s.ts)), ...fromAg.map((m) => Date.parse(m.ts)),
      convAct > since ? convAct : 0);
    const now = Date.now();

    let status;
    if (result) status = "finished";
    else if (question) status = "needs_reply";
    else if (!delivered && now - since > 180000) status = "not_delivered";
    else if (lastActivity && now - lastActivity >= idleMs) status = "idle";
    else if (now - callStart >= maxMs) status = "still_running";

    if (status) {
      store.unread(ME); // mark everything seen so the prompt hook doesn't repeat it
      return {
        status,
        task_id: taskId,
        minutes_since_task_sent: Math.round((now - since) / 6000) / 10,
        ...(result ? { antigravity_report: result.text } : {}),
        ...(question ? { antigravity_question: question.text } : {}),
        steps_so_far: steps.length,
        failed_steps: steps.filter((s) => s.exitCode !== undefined && s.exitCode !== 0).length,
        latest_steps: steps.slice(-8).map((s) =>
          `${s.ts.slice(11, 19)} ${s.title}${s.exitCode !== undefined ? (s.exitCode === 0 ? " ✓" : ` ✗ (exit ${s.exitCode})`) : ""}`),
        next: {
          finished: "Show the user Antigravity's report (in full or a faithful summary), then continue.",
          needs_reply: "Show the user Antigravity's question, answer it with send_message, then wait again.",
          not_delivered: "The task has not reached Antigravity after 3 minutes (is Antigravity open?). Tell the user. Do NOT resend it automatically: it may still be delivered and would then run twice.",
          idle: "No sign of Antigravity working for a long time and no report. Ask the user to check Antigravity; do not assume it finished.",
          still_running: `Antigravity is still working. Give the user a one-line update, then call wait_for_antigravity again with task_id ${taskId ?? "(none)"}. Keep doing this until the status changes.`,
        }[status],
      };
    }
    if (progressToken !== undefined && tick++ % 5 === 0) {
      try {
        await extra.sendNotification({ method: "notifications/progress",
          params: { progressToken, progress: Math.round((now - callStart) / 1000), total: Math.round(maxMs / 1000),
                    message: `waiting for Antigravity (${steps.length} steps so far)` } });
      } catch {}
    }
    if (extra?.signal?.aborted) return { status: "cancelled" };
    await sleep(2000);
  }
}

if (ME === "claude") {
  server.registerTool(
    "send_message",
    {
      title: "Send a task or message to Antigravity",
      description:
        "Send a task to Google Antigravity's agent. It is delivered straight into the agent's chat and runs " +
        "immediately, so write a clear, self-contained prompt. IMPORTANT: before calling this, show the user " +
        "the complete prompt text in your reply (e.g. as a quote block) so they can see exactly what is sent. " +
        "The agent is told to report back when done. By default this call then waits up to ~45 s for the report; " +
        "if the status is still_running, keep calling wait_for_antigravity with the returned task_id until it " +
        "is finished, giving the user a one-line update each time. When the report arrives, show it to the user. " +
        "Use type 'progress' (no wait) for FYI updates that need no action.",
      inputSchema: {
        text: z.string().min(1).describe("The full prompt for the Antigravity agent"),
        type: z.enum(["message", "progress"]).optional()
          .describe("'message' (default) = a task/question the agent should act on; 'progress' = FYI only"),
        wait_seconds: z.number().int().min(0).max(MAX_WAIT_S).optional()
          .describe("How long to wait for the report in this call (default 45; 0 = return immediately)"),
      },
    },
    async ({ text: t, type, wait_seconds }, extra) => {
      const kind = type || "message";
      const m = store.post({ from: ME, to: PEER, type: kind, text: t });
      const head = `Sent to Antigravity (task_id: ${m.id}). Prompt delivered:\n---\n${t}\n---`;
      if (kind !== "message" || wait_seconds === 0) {
        return text(head + (kind === "message" ? `\nCall wait_for_antigravity with task_id ${m.id} to get the report.` : ""));
      }
      const w = await waitForTask({ taskId: m.id, waitSeconds: wait_seconds ?? 45, extra });
      return text(head + "\n" + JSON.stringify(w, null, 2));
    }
  );

  server.registerTool(
    "wait_for_antigravity",
    {
      title: "Wait for Antigravity's report",
      description:
        "Wait (up to ~45 s per call) for Antigravity's report on a task sent with send_message. Returns " +
        "finished (with antigravity_report), needs_reply (with antigravity_question), still_running, idle " +
        "(quiet for idle_seconds: probably done without reporting) or not_delivered. On still_running, give the " +
        "user a one-line update and call this again with the same task_id; repeat until it changes. " +
        "When finished, show the user the report.",
      inputSchema: {
        task_id: z.string().optional().describe("task_id from send_message (default: any new result)"),
        wait_seconds: z.number().int().min(5).max(MAX_WAIT_S).optional().describe("Max wait in this call, default 45"),
        idle_seconds: z.number().int().min(5).max(3600).optional()
          .describe("Report 'idle' after this long with no agent activity at all, default 900"),
      },
    },
    async ({ task_id, wait_seconds, idle_seconds }, extra) =>
      text(await waitForTask({ taskId: task_id, waitSeconds: wait_seconds, idleSeconds: idle_seconds, extra }))
  );
} else {
  server.registerTool(
    "send_message",
    {
      title: "Send a message or result to Claude Code",
      description:
        "Send a message to Claude Code. (For task reports you can also simply write the report to " +
        "~/.agent-bridge/outbox/<TaskID>.md, which is delivered the same way.) When you finish a task Claude gave you (or get stuck), you MUST " +
        "send type 'result' with reply_to set to that task's id and a short report: what you did, " +
        "files changed, build/test results, anything left or blocked. Use 'message' for questions, " +
        "'progress' for FYI updates.",
      inputSchema: {
        text: z.string().min(1).describe("The message or result report"),
        type: z.enum(["message", "progress", "result"]).optional()
          .describe("'result' = task finished/blocked report; 'message' (default) = needs Claude's attention; 'progress' = FYI"),
        reply_to: z.string().optional()
          .describe("Task id from Claude's message (shown as 'Task ID: …'). Defaults to Claude's latest task."),
      },
    },
    async ({ text: t, type, reply_to }) => {
      const kind = type || "message";
      const replyTo = reply_to || (kind === "result" ? store.lastTaskFrom("claude", "antigravity")?.id : undefined);
      const m = store.post({ from: ME, to: PEER, type: kind, text: t, replyTo });
      return text(`Sent to Claude (${m.id})${replyTo ? ` as ${kind} for task ${replyTo}` : ""}.`);
    }
  );
}

server.registerTool(
  "read_messages",
  {
    title: `Read messages from ${PEER}`,
    description:
      `Read new messages and progress updates from ${PEER}. Marks them read. ` +
      `Check this at the start of a task and before editing shared files.`,
    inputSchema: {
      include_read: z.boolean().optional()
        .describe("Also show the last 20 messages, read or not"),
    },
  },
  async ({ include_read }) => {
    const msgs = include_read ? store.recent(20) : store.unread(ME);
    if (!msgs.length) return text(`No new messages from ${PEER}.`);
    return text(msgs.map(fmt).join("\n"));
  }
);

server.registerTool(
  "get_antigravity_progress",
  {
    title: "Antigravity agent progress",
    description:
      "What the Antigravity agent is doing: its most recent steps (commands run, exit codes, " +
      "timestamps) and task list if it has one. Omit conversation_id for the most recently " +
      "active conversation; check lastActivity to judge whether it is current.",
    inputSchema: { conversation_id: z.string().optional() },
  },
  async ({ conversation_id }) => {
    const s = store.summarizeProgress(conversation_id);
    return text(s || "No Antigravity artifacts found (is Antigravity installed and has an agent run?).");
  }
);

server.registerTool(
  "list_antigravity_conversations",
  {
    title: "List Antigravity conversations",
    description: "List recent Antigravity agent conversations and their artifact files.",
    inputSchema: { limit: z.number().int().min(1).max(50).optional() },
  },
  async ({ limit }) => text(store.listConversations(limit || 10))
);

server.registerTool(
  "read_antigravity_artifact",
  {
    title: "Read an Antigravity artifact",
    description:
      "Read the full markdown of an Antigravity artifact such as task.md, " +
      "implementation_plan.md or walkthrough.md.",
    inputSchema: {
      name: z.string().describe("File name, e.g. task.md"),
      conversation_id: z.string().optional(),
    },
  },
  async ({ name, conversation_id }) => {
    const conv = store.readArtifacts(conversation_id);
    const a = conv?.artifacts.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!a) return text(`No artifact named ${name}. Available: ${conv?.artifacts.map((x) => x.name).join(", ") || "none"}`);
    return text(a.content);
  }
);

// Exit promptly when the client goes away, so Antigravity/Claude can always restart us
// (a lingering process made Antigravity's connector reload hang: "Close() did not return").
const bye = (why) => { store.diag(`exit (${why})`); process.exit(0); };
process.stdin.on("end", () => bye("stdin end"));
process.stdin.on("close", () => bye("stdin close"));
process.on("SIGTERM", () => bye("SIGTERM"));
process.on("SIGINT", () => bye("SIGINT"));
process.on("uncaughtException", (e) => { store.diag(`uncaught ${e?.stack || e}`); });
const transport = new StdioServerTransport();
transport.onclose = () => bye("transport closed");
await server.connect(transport);
store.diag(`${ME} connected`);

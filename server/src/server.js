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

const text = (obj) => ({
  content: [
    { type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) },
  ],
});

const fmt = (m) =>
  `[${m.ts.slice(11, 19)}] ${m.from}${m.type !== "message" ? ` (${m.type})` : ""}: ${m.text}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (ME === "claude") {
  server.registerTool(
    "send_message",
    {
      title: "Send a task or message to Antigravity",
      description:
        "Send a message to Google Antigravity's agent. It is delivered straight into the agent's chat " +
        "and submitted automatically, so the agent acts on it right away: write it as a clear, " +
        "self-contained prompt. The agent is told to report back with a 'result' message when done. " +
        "Returns a task_id; call wait_for_antigravity with it if you want to wait for that result. " +
        "Use type 'progress' for FYI updates that need no action.",
      inputSchema: {
        text: z.string().min(1).describe("The task or message for the Antigravity agent"),
        type: z.enum(["message", "progress"]).optional()
          .describe("'message' (default) = a task/question the agent should act on; 'progress' = FYI only"),
      },
    },
    async ({ text: t, type }) => {
      const m = store.post({ from: ME, to: PEER, type: type || "message", text: t });
      return text(
        `Sent to Antigravity. task_id: ${m.id}\n` +
        (m.type === "message"
          ? "To wait for the agent's result, call wait_for_antigravity with this task_id."
          : "")
      );
    }
  );
} else {
  server.registerTool(
    "send_message",
    {
      title: "Send a message or result to Claude Code",
      description:
        "Send a message to Claude Code. When you finish a task Claude gave you (or get stuck), you MUST " +
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

if (ME === "claude") {
  server.registerTool(
    "wait_for_antigravity",
    {
      title: "Wait for Antigravity to finish",
      description:
        "Wait until Antigravity's agent reports back, then return its result together with the steps it " +
        "ran meanwhile. Use after send_message when you want to continue once Antigravity is done. Ends when: " +
        "the agent sends a result ('finished'), asks you something ('needs_reply'), goes quiet for " +
        "idle_seconds after working ('idle': probably done without reporting, so check the steps), or " +
        "timeout_seconds passes ('still_running' / 'no_activity'). You can call it again to keep waiting.",
      inputSchema: {
        task_id: z.string().optional().describe("task_id returned by send_message (default: any result)"),
        timeout_seconds: z.number().int().min(5).max(1800).optional().describe("Max wait, default 300 (call again to keep waiting)"),
        idle_seconds: z.number().int().min(5).max(1800).optional()
          .describe("Treat as done after this long with no new agent steps, default 180"),
      },
    },
    async ({ task_id, timeout_seconds, idle_seconds }, extra) => {
      const timeout = (timeout_seconds ?? 300) * 1000;
      const idle = (idle_seconds ?? 180) * 1000;
      const start = Date.now();
      const progressToken = extra?._meta?.progressToken;
      const received = [];
      let lastActivity = 0;
      let tick = 0;
      let status;
      let result;
      let question;

      while (true) {
        for (const m of store.unread(ME)) {
          received.push(m);
          lastActivity = Math.max(lastActivity, Date.parse(m.ts) || Date.now());
          if (m.type === "result" && (!task_id || !m.replyTo || m.replyTo === task_id)) result = m;
          if (m.type === "message") question = m;
        }
        const steps = store.stepsSince(start);
        if (steps.length) lastActivity = Math.max(lastActivity, Date.parse(steps.at(-1).ts));
        const now = Date.now();
        if (result) status = "finished";
        else if (question) status = "needs_reply";
        else if (lastActivity && now - lastActivity >= idle) status = "idle";
        else if (now - start >= timeout) status = lastActivity ? "still_running" : "no_activity";
        if (status) {
          const summary = {
            status,
            waited_seconds: Math.round((now - start) / 1000),
            ...(result ? { result: result.text } : {}),
            ...(question ? { question: question.text } : {}),
            steps_while_waiting: steps.slice(-25).map((s) => ({
              ts: s.ts, title: s.title,
              ...(s.command ? { command: s.command } : {}),
              ...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}),
            })),
            failed_steps: steps.filter((s) => s.exitCode !== undefined && s.exitCode !== 0).length,
            other_updates: received.filter((m) => m !== result && m !== question).map(fmt),
            hint: {
              finished: "Antigravity reported back. Review the result and steps.",
              needs_reply: "Antigravity asked something. Answer with send_message, then wait again.",
              idle: "Agent went quiet without sending a result. It has probably finished; check the steps (and files) to confirm.",
              still_running: "Agent is still working. Call wait_for_antigravity again to keep waiting.",
              no_activity: "No sign of the agent working. Check Antigravity is open, or that the message was delivered.",
            }[status],
          };
          return text(summary);
        }
        if (progressToken !== undefined && tick++ % 5 === 0) {
          try {
            await extra.sendNotification({
              method: "notifications/progress",
              params: { progressToken, progress: Math.round((now - start) / 1000), total: Math.round(timeout / 1000),
                        message: `waiting for Antigravity (${steps.length} steps so far)` },
            });
          } catch {}
        }
        if (extra?.signal?.aborted) return text({ status: "cancelled" });
        await sleep(2000);
      }
    }
  );
}

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

await server.connect(new StdioServerTransport());

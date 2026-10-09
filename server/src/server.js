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
  `[${m.ts.slice(11, 19)}] ${m.from}${m.type === "progress" ? " (progress)" : ""}: ${m.text}`;

server.registerTool(
  "send_message",
  {
    title: `Send a message to ${PEER}`,
    description:
      (PEER === "antigravity"
        ? "Send a message to Google Antigravity's agent. It is delivered straight into the agent's chat " +
          "and submitted automatically, so the agent acts on it right away: write it as a clear, " +
          "self-contained prompt. Use it to hand off work, ask a question, or warn about files you are editing. "
        : "Send a message to Claude Code. Use it to report that you finished something, ask a question, " +
          "or warn about files you are editing. ") +
      "Use type 'progress' for status updates that need no action.",
    inputSchema: {
      text: z.string().min(1).describe("The message"),
      type: z.enum(["message", "progress"]).optional()
        .describe("'progress' for status updates, 'message' (default) for anything needing attention"),
    },
  },
  async ({ text: t, type }) => {
    const m = store.post({ from: ME, to: PEER, type: type || "message", text: t });
    return text(`Sent to ${PEER} (${m.id}).`);
  }
);

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

await server.connect(new StdioServerTransport());

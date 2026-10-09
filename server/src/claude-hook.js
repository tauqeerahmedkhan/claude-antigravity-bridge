#!/usr/bin/env node
// Claude Code UserPromptSubmit hook: whatever this prints is added to Claude's
// context for the prompt you just sent, so Antigravity news arrives automatically.
import * as store from "./store.js";

try {
  const msgs = store.unread("claude");
  const progress = store.summarizeProgress();
  const lines = [];

  if (msgs.length) {
    lines.push(`<antigravity_bridge new_messages="${msgs.length}">`);
    for (const m of msgs.slice(-15)) {
      const tag = m.type === "result" ? " RESULT" + (m.replyTo ? ` for task ${m.replyTo}` : "") : m.type === "progress" ? " (progress)" : "";
      lines.push(`- [${m.ts.slice(11, 19)}] ${m.from}${tag}: ${m.text}`);
    }
    if (msgs.length > 15) lines.push(`(${msgs.length - 15} older not shown; use read_messages)`);
    if (msgs.some((m) => m.type === "result" || m.type === "message")) {
      lines.push("Show the user any RESULT or question from Antigravity above before continuing.");
    }
    lines.push("</antigravity_bridge>");
  }

  if (progress?.taskList && (progress.taskList.doing || progress.taskList.todo)) {
    const t = progress.taskList;
    lines.push(
      `Antigravity task list: ${t.done} done, ${t.doing} in progress, ${t.todo} to do.` +
        (t.current.length ? ` Now: ${t.current.join("; ")}.` : "")
    );
  }
  const last = progress?.recentSteps?.at(-1);
  if (last && progress.minutesSinceLastActivity !== null && progress.minutesSinceLastActivity < 60) {
    lines.push(`Antigravity last step (${progress.minutesSinceLastActivity} min ago): ${last.title}` +
      (last.exitCode !== undefined ? ` [exit ${last.exitCode}]` : ""));
  }

  if (lines.length) process.stdout.write(lines.join("\n") + "\n");
} catch {
  // Never block the user's prompt because of the bridge.
}
process.exit(0);

import { describe, expect, it } from "vitest";
import type { ClaudeCodeHostEvent } from "../src/shared/types.js";
import { createTestSession, fauxAssistantMessage, fauxToolCall } from "./helpers.js";

const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });

describe("task list shared with foreground subagents", () => {
	it("a task created by a subagent is visible to the parent and reported to the host", async () => {
		const events: ClaudeCodeHostEvent[] = [];
		const t = await createTestSession({
			claudeCode: { loadAgentsFromDisk: false, onEvent: (e) => events.push(e) },
			responses: [
				toolUse(fauxToolCall("TaskCreate", { subject: "Parent task", description: "p" })),
				toolUse(fauxToolCall("Agent", { description: "child work", prompt: "add a task", subagent_type: "general-purpose", run_in_background: false })),
				// child
				toolUse(fauxToolCall("TaskCreate", { subject: "Child task", description: "c" })),
				fauxAssistantMessage("child done"),
				// parent
				toolUse(fauxToolCall("TaskList", {})),
				fauxAssistantMessage("done"),
			],
		});
		await t.session.prompt("go");
		const list = t.toolResults().find((r) => r.toolName === "TaskList")!;
		expect(list.text).toContain("#1 [pending] Parent task");
		expect(list.text).toContain("#2 [pending] Child task");
		const last = events.filter((e) => e.type === "tasks_updated").at(-1) as Extract<ClaudeCodeHostEvent, { type: "tasks_updated" }>;
		expect(last.tasks.map((x) => x.subject)).toEqual(["Parent task", "Child task"]);
		t.dispose();
	});
});

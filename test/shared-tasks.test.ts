import { describe, expect, it } from "vitest";
import type { ClaudeCodeHostEvent } from "../src/shared/types.js";
import { TASK_STATE_ENTRY_TYPE, taskListFromBranch } from "../src/tools/task-tools.js";
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

	it("#15: a subagent's task changes are persisted in the parent's branch (survive resume/fork/tree)", async () => {
		const t = await createTestSession({
			claudeCode: { loadAgentsFromDisk: false },
			responses: [
				toolUse(fauxToolCall("TaskCreate", { subject: "parent", description: "p" })),
				toolUse(fauxToolCall("Agent", { description: "child work", prompt: "add", subagent_type: "general-purpose", run_in_background: false })),
				// child
				toolUse(fauxToolCall("TaskCreate", { subject: "child", description: "c" })),
				toolUse(fauxToolCall("TaskUpdate", { taskId: "1", status: "in_progress" })),
				fauxAssistantMessage("child done"),
				// parent
				fauxAssistantMessage("done"),
			],
		});
		await t.session.prompt("go");
		const branch = t.session.sessionManager.getBranch();
		const rebuilt = taskListFromBranch(branch);
		expect(rebuilt?.tasks.map((x) => [x.subject, x.status])).toEqual([
			["parent", "in_progress"],
			["child", "pending"],
		]);
		expect(rebuilt?.highWaterMark).toBe(2);
		// only the subagent's changes are recorded as state entries (the parent's own are in its tool results)
		const stateEntries = branch.filter((e: any) => e.type === "custom" && e.customType === TASK_STATE_ENTRY_TYPE);
		expect(stateEntries).toHaveLength(2);
		// state entries are not part of the model context
		expect(JSON.stringify(t.session.messages)).not.toContain(TASK_STATE_ENTRY_TYPE);
		t.dispose();
	});

	it("#15: taskListFromBranch takes the latest of tool results and state entries, in branch order", () => {
		const result = (subjects: string[]) => ({
			type: "message",
			message: { role: "toolResult", toolName: "TaskCreate", isError: false, details: { taskList: { tasks: subjects.map((subject, i) => ({ id: String(i + 1), subject })), highWaterMark: subjects.length } } },
		});
		const state = (subjects: string[]) => ({ type: "custom", customType: TASK_STATE_ENTRY_TYPE, data: { tasks: subjects.map((subject, i) => ({ id: String(i + 1), subject })), highWaterMark: subjects.length } });
		expect(taskListFromBranch([result(["a"]), state(["a", "b"])])?.tasks.map((x) => x.subject)).toEqual(["a", "b"]);
		expect(taskListFromBranch([state(["a", "b"]), result(["a", "b", "c"])])?.tasks.map((x) => x.subject)).toEqual(["a", "b", "c"]);
		expect(taskListFromBranch([{ type: "custom", customType: "other", data: { tasks: [] } }])).toBeUndefined();
	});
});

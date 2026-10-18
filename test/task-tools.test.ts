import { describe, expect, it } from "vitest";
import { createCCContext } from "../src/shared/context.js";
import type { ClaudeCodeHostEvent } from "../src/shared/types.js";
import { coerceTaskCreateInput, registerTaskTools, subjectFromDescription, TASK_REMINDER_TURNS } from "../src/tools/task-tools.js";
import { captureTools, createTestSession, fakeCtx, fauxAssistantMessage, fauxToolCall, resultText } from "./helpers.js";

function setup() {
	const events: ClaudeCodeHostEvent[] = [];
	const cc = createCCContext({ onEvent: (e) => events.push(e) });
	const { tools, handlers } = captureTools((pi) => registerTaskTools(pi, cc));
	/** Run a tool the way pi does: prepareArguments (Claude Code validation) then execute. */
	const call = async (name: string, params: unknown) => {
		const tool = tools.get(name)!;
		const args = tool.prepareArguments ? tool.prepareArguments(params) : params;
		const r = await tool.execute("id1", args as any, undefined, undefined, fakeCtx("/tmp"));
		return { text: resultText(r), details: r.details as any };
	};
	const fire = async (ev: string, event: any, ctx: any = fakeCtx("/tmp")) => {
		let out: any;
		for (const h of handlers.get(ev) ?? []) out = (await h(event, ctx)) ?? out;
		return out;
	};
	return { events, tools, call, fire };
}

describe("task tools", () => {
	it("declare Claude Code's names and schemas", () => {
		const { tools } = setup();
		expect([...tools.keys()]).toEqual(["TaskCreate", "TaskGet", "TaskList", "TaskUpdate"]);
		const props = (n: string) => Object.keys((tools.get(n)!.parameters as any).properties);
		expect(props("TaskCreate")).toEqual(["subject", "description", "activeForm", "metadata"]);
		expect(props("TaskGet")).toEqual(["taskId"]);
		expect(props("TaskList")).toEqual([]);
		expect(props("TaskUpdate")).toEqual(["taskId", "subject", "description", "activeForm", "status", "addBlocks", "addBlockedBy", "owner", "metadata"]);
		expect((tools.get("TaskUpdate")!.parameters as any).properties.status.anyOf[1]).toEqual({ type: "string", const: "deleted" });
	});

	it("create / update / dependencies / list / get / delete", async () => {
		const { call, events } = setup();
		expect((await call("TaskList", {})).text).toBe("No tasks found");
		expect((await call("TaskCreate", { subject: "Write code", description: "Write the code", activeForm: "Writing code" })).text).toBe("Task #1 created successfully: Write code");
		await call("TaskCreate", { subject: "Test", description: "Run the tests" });
		await call("TaskCreate", { subject: "Ship", description: "Ship it" });
		expect((await call("TaskUpdate", { taskId: "1", status: "in_progress" })).text).toBe("Updated task #1 status");
		expect((await call("TaskUpdate", { taskId: "3", addBlockedBy: ["1", "2"] })).text).toBe("Updated task #3 blockedBy");
		expect((await call("TaskUpdate", { taskId: "2", addBlocks: ["3"] })).text).toBe("Updated task #2 ");
		expect((await call("TaskList", {})).text).toBe("#1 [in_progress] Write code\n#2 [pending] Test\n#3 [pending] Ship [blocked by #1, #2]");
		expect((await call("TaskGet", { taskId: "1" })).text).toBe("Task #1: Write code\nStatus: in_progress\nDescription: Write the code\nBlocks: #3");
		expect((await call("TaskUpdate", { taskId: "1", status: "completed", subject: "Write the code", owner: "me", description: "Write the code" })).text).toBe(
			"Updated task #1 subject, owner, status",
		);
		expect((await call("TaskList", {})).text).toBe("#1 [completed] Write the code (me)\n#2 [pending] Test\n#3 [pending] Ship [blocked by #2]");
		expect((await call("TaskGet", { taskId: "3" })).text).toBe("Task #3: Ship\nStatus: pending\nDescription: Ship it\nBlocked by: #1, #2");
		expect((await call("TaskUpdate", { taskId: "2", status: "deleted", subject: "ignored" })).text).toBe("Updated task #2 deleted");
		expect((await call("TaskList", {})).text).toBe("#1 [completed] Write the code (me)\n#3 [pending] Ship");
		// ids are never reused; a missing description is backfilled from the subject
		expect((await call("TaskCreate", { subject: "Docs" })).text).toBe("Task #4 created successfully: Docs");
		expect((await call("TaskGet", { taskId: "4" })).text).toContain("Description: Docs");
		expect((await call("TaskGet", { taskId: "2" })).text).toBe("Task not found");
		expect((await call("TaskUpdate", { taskId: "99", status: "completed" })).text).toBe("Task not found");
		expect((await call("TaskUpdate", { taskId: "3", addBlocks: ["99"] })).text).toBe("Updated task #3 blocks");
		expect((await call("TaskUpdate", { id: "3", active_form: "Shipping" })).text).toBe("Updated task #3 activeForm");
		expect(events.at(-1)).toEqual({ type: "tasks_updated", tasks: expect.any(Array) });
		expect(events.findLast((e) => e.type === "todos_updated")).toEqual({
			type: "todos_updated",
			todos: [
				{ content: "Write the code", activeForm: "Writing code", status: "completed" },
				{ content: "Ship", activeForm: "Shipping", status: "pending" },
				{ content: "Docs", activeForm: "Docs", status: "pending" },
			],
		});
	});

	it("metadata merge and _internal tasks", async () => {
		const { call } = setup();
		await call("TaskCreate", { subject: "A", description: "a", metadata: { prio: 1, x: 2 } });
		const r = await call("TaskUpdate", { taskId: "1", metadata: { prio: null, team: "core" } });
		expect(r.text).toBe("Updated task #1 metadata");
		expect(r.details.taskList.tasks[0].metadata).toEqual({ x: 2, team: "core" });
		await call("TaskCreate", { subject: "Hidden", description: "h", metadata: { _internal: true } });
		expect((await call("TaskList", {})).text).toBe("#1 [pending] A");
	});

	it("validation errors use Claude Code's wording", async () => {
		const { call } = setup();
		await expect(call("TaskUpdate", { status: "completed" })).rejects.toThrow("InputValidationError: TaskUpdate failed due to the following issue:\nThe required parameter `taskId` is missing");
		await expect(call("TaskUpdate", { taskId: 3 })).rejects.toThrow("The parameter `taskId` type is expected as `string` but provided as `number`");
		await expect(call("TaskUpdate", { taskId: "1", status: "done" })).rejects.toThrow(/^InputValidationError: \[\n  \{\n    "code": "invalid_union"/);
		await expect(call("TaskList", { foo: 1 })).rejects.toThrow("An unexpected parameter `foo` was provided");
		await expect(call("TaskCreate", { todos: [{ content: "x" }] })).rejects.toThrow(
			/^InputValidationError: TaskCreate creates ONE task per call[\s\S]*\n\nTaskCreate failed due to the following issues:\nThe required parameter `subject` is missing\nThe required parameter `description` is missing\nAn unexpected parameter `todos` was provided$/,
		);
	});

	it("repairs common TaskCreate input shapes", () => {
		expect(coerceTaskCreateInput({ title: "Lint", content: "Run the linter", priority: "high" })).toEqual({ subject: "Lint", description: "Run the linter" });
		expect(coerceTaskCreateInput({ task: "Write the changelog" })).toEqual({ description: "Write the changelog", subject: "Write the changelog" });
		expect(coerceTaskCreateInput({ subject: "a", description: "b" })).toBeNull();
		expect(coerceTaskCreateInput({ prompt: "x", subagent_type: "y" })).toBeNull();
		expect(subjectFromDescription("Refactor the parser module so that it is easier to test and also faster than before, finally")).toBe(
			"Refactor the parser module so that it is easier to test and also faster than",
		);
		expect(subjectFromDescription("**Fix** it\nmore")).toBe("**Fix** it");
	});

	it("reconstructs the list from the branch on session_start and session_tree", async () => {
		const { call, fire, events } = setup();
		const a = await call("TaskCreate", { subject: "A", description: "a" });
		const b = await call("TaskCreate", { subject: "B", description: "b" });
		const entries = [
			{ type: "message", message: { role: "toolResult", toolName: "TaskCreate", isError: false, details: a.details } },
			{ type: "message", message: { role: "toolResult", toolName: "TaskList", isError: false, details: {} } },
			{ type: "message", message: { role: "toolResult", toolName: "TaskCreate", isError: false, details: b.details } },
			{ type: "message", message: { role: "toolResult", toolName: "TaskUpdate", isError: true, details: {} } },
		];
		await fire("session_start", { type: "session_start", reason: "resume" }, fakeCtx("/tmp", { sessionManager: { getBranch: () => entries } as any }));
		expect(events.findLast((e) => e.type === "todos_updated")).toMatchObject({ todos: [{ content: "A" }, { content: "B" }] });
		await fire("session_tree", { type: "session_tree" }, fakeCtx("/tmp", { sessionManager: { getBranch: () => entries.slice(0, 2) } as any }));
		expect((await call("TaskList", {})).text).toBe("#1 [pending] A");
		// the high-water mark travels with the list
		expect((await call("TaskCreate", { subject: "C", description: "c" })).text).toBe("Task #2 created successfully: C");
		await fire("session_tree", { type: "session_tree" }, fakeCtx("/tmp", { sessionManager: { getBranch: () => [] } as any }));
		expect((await call("TaskList", {})).text).toBe("No tasks found");
	});
});

describe("task reminder", () => {
	const N = TASK_REMINDER_TURNS;
	const user = { role: "user", content: "go", timestamp: 1 };
	const turn = (i: number, blocks: any[]) => [
		{ role: "assistant", content: blocks, timestamp: 100 + i },
		{ role: "toolResult", toolCallId: `t${i}`, content: [{ type: "text", text: "ok" }], timestamp: 200 + i },
	];
	const tool = (name: string) => ({ type: "toolCall", id: "x", name, arguments: {} });
	const reminderTexts = (messages: any[]) => messages.filter((m) => m.role === "custom").map((m) => m.content as string);

	it("counts non-thinking content blocks since the last TaskCreate/TaskUpdate and since the last reminder", async () => {
		const { call, fire } = setup();
		await call("TaskCreate", { subject: "Work", description: "w" });
		const msgs: any[] = [user, ...turn(0, [tool("TaskCreate")])];
		for (let i = 1; i < N; i++) {
			msgs.push(...turn(i, [{ type: "thinking", thinking: "hm" }, tool("TaskList")]));
			expect(await fire("context", { type: "context", messages: [...msgs] })).toBeUndefined();
		}
		msgs.push(...turn(N, [tool("TaskGet")]));
		const out = await fire("context", { type: "context", messages: [...msgs] });
		expect(out.messages.at(-1)).toMatchObject({ role: "custom", display: false });
		expect(out.messages.at(-1).content).toBe(
			"<system-reminder>\nThe task tools haven't been used recently. If you're working on tasks that would benefit from tracking progress, consider using TaskCreate to add new tasks and TaskUpdate to update task status (set to in_progress when starting, completed when done). Also consider cleaning up the task list if it has become stale. Only use these if relevant to the current work. This is just a gentle reminder - ignore if not applicable.\n\n\nHere are the existing tasks:\n\n#1. [pending] Work\n</system-reminder>",
		);
		// the reminder stays at its position on later calls; the next one comes N blocks later
		msgs.push(...turn(N + 1, [{ type: "text", text: "a" }, tool("TaskList"), tool("TaskList")]));
		const later = await fire("context", { type: "context", messages: [...msgs] });
		expect(reminderTexts(later.messages)).toHaveLength(1);
		expect(later.messages.indexOf(later.messages.find((m: any) => m.role === "custom"))).toBe(msgs.length - 2);
		for (let i = N + 2; i < N + 9; i++) msgs.push(...turn(i, [tool("TaskList")]));
		expect(reminderTexts((await fire("context", { type: "context", messages: [...msgs] })).messages)).toHaveLength(2);
	});

	it("reminds in a long run where the task tools were never used (no task list)", async () => {
		const { fire } = setup();
		const msgs: any[] = [user];
		for (let i = 0; i < N - 1; i++) msgs.push(...turn(i, [tool("Bash")]));
		expect(await fire("context", { type: "context", messages: [...msgs] })).toBeUndefined();
		msgs.push(...turn(N, [tool("Bash")]));
		const out = await fire("context", { type: "context", messages: [...msgs] });
		expect(out.messages.at(-1).content).toMatch(/applicable\.\n\n<\/system-reminder>$/);
	});

	it("end-to-end: persists the list in details, validates, and reconstructs from the real session", async () => {
		const events: ClaudeCodeHostEvent[] = [];
		const t = await createTestSession({
			responses: [
				fauxAssistantMessage(fauxToolCall("TaskCreate", { subject: "A", description: "a" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("TaskUpdate", { taskId: "1", status: "bogus" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("TaskUpdate", { taskId: "1", status: "completed" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			],
			claudeCode: { onEvent: (e) => events.push(e), subagents: false },
		});
		await t.session.prompt("track");
		const results = t.toolResults();
		expect(results.map((r) => [r.toolName, r.isError])).toEqual([
			["TaskCreate", false],
			["TaskUpdate", true],
			["TaskUpdate", false],
		]);
		expect(results[1].text).toMatch(/^InputValidationError: \[/);
		expect(results[2].text).toBe("Updated task #1 status");
		expect(events.findLast((e) => e.type === "todos_updated")).toEqual({ type: "todos_updated", todos: [{ content: "A", activeForm: "A", status: "completed" }] });

		const reEvents: ClaudeCodeHostEvent[] = [];
		const cc = createCCContext({ onEvent: (e) => reEvents.push(e) });
		const { handlers } = captureTools((pi) => registerTaskTools(pi, cc));
		for (const h of handlers.get("session_start")!) {
			await h({ type: "session_start", reason: "resume" }, fakeCtx(t.cwd, { sessionManager: t.session.sessionManager } as any));
		}
		expect(reEvents[0]).toEqual({ type: "todos_updated", todos: [{ content: "A", activeForm: "A", status: "completed" }] });
		t.dispose();
	});
});

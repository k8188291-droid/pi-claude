import { describe, expect, it } from "vitest";
import { registerTodoWrite, TODO_REMINDER_TURNS, TODO_WRITE_RESULT_TEXT } from "../src/tools/todo-write.js";
import { createCCContext } from "../src/shared/context.js";
import type { ClaudeCodeHostEvent, TodoItem } from "../src/shared/types.js";
import { captureTools, createTestSession, fakeCtx, fauxAssistantMessage, fauxToolCall, resultText } from "./helpers.js";

function setup() {
	const events: ClaudeCodeHostEvent[] = [];
	const cc = createCCContext({ onEvent: (e) => events.push(e) });
	const { tools, handlers } = captureTools((pi) => registerTodoWrite(pi, cc));
	const tool = tools.get("TodoWrite")!;
	const run = (todos: unknown) => tool.execute("id1", { todos } as any, undefined, undefined, fakeCtx("/tmp"));
	const fire = async (ev: string, event: any, ctx: any = fakeCtx("/tmp")) => {
		let out: any;
		for (const h of handlers.get(ev) ?? []) out = (await h(event, ctx)) ?? out;
		return out;
	};
	return { events, tool, run, fire, handlers };
}

const sample: TodoItem[] = [
	{ content: "Run tests", activeForm: "Running tests", status: "in_progress" },
	{ content: "Build", activeForm: "Building", status: "pending" },
];

const assistant = (toolName?: string) => ({
	role: "assistant",
	content: toolName ? [{ type: "toolCall", id: "x", name: toolName, arguments: {} }] : [{ type: "text", text: "ok" }],
});

function contextWith(assistantTurns: Array<string | undefined>) {
	const msgs: any[] = [{ role: "user", content: "go" }];
	for (const t of assistantTurns) msgs.push(assistant(t));
	return msgs;
}

describe("TodoWrite tool", () => {
	it("has the Claude Code schema", () => {
		const { tool } = setup();
		const p = tool.parameters as any;
		expect(Object.keys(p.properties)).toEqual(["todos"]);
		const item = p.properties.todos.items;
		expect(Object.keys(item.properties).sort()).toEqual(["activeForm", "content", "status"]);
		expect(item.properties.status.enum).toEqual(["pending", "in_progress", "completed"]);
		expect(tool.description).toContain("When NOT to Use This Tool");
	});

	it("replaces the list, returns details and emits todos_updated", async () => {
		const { run, events } = setup();
		const r = await run(sample);
		expect(resultText(r)).toBe(TODO_WRITE_RESULT_TEXT);
		expect(r.details).toEqual({ todos: sample });
		expect(events.at(-1)).toEqual({ type: "todos_updated", todos: sample });
		const r2 = await run([{ content: "Only", activeForm: "Onlying", status: "completed" }]);
		expect((r2.details as any).todos).toHaveLength(1);
		expect(events.at(-1)).toEqual({ type: "todos_updated", todos: [{ content: "Only", activeForm: "Onlying", status: "completed" }] });
	});

	it("validates items", async () => {
		const { run } = setup();
		await expect(run([{ content: "", activeForm: "x", status: "pending" }])).rejects.toThrow(/content/);
		await expect(run([{ content: "x", activeForm: "  ", status: "pending" }])).rejects.toThrow(/activeForm/);
		await expect(run([{ content: "x", activeForm: "y", status: "done" }])).rejects.toThrow(/status/);
		await expect(run("nope")).rejects.toThrow(/array/);
	});

	it("warns (not errors) on multiple in_progress items", async () => {
		const { run } = setup();
		const r = await run([
			{ content: "a", activeForm: "A", status: "in_progress" },
			{ content: "b", activeForm: "B", status: "in_progress" },
		]);
		expect(resultText(r)).toContain(TODO_WRITE_RESULT_TEXT);
		expect(resultText(r)).toMatch(/Warning: 2 tasks are marked in_progress/);
	});

	it("reconstructs from the branch on session_start and session_tree", async () => {
		const { fire, events } = setup();
		const older: TodoItem[] = [{ content: "old", activeForm: "olding", status: "pending" }];
		const entries = [
			{ type: "message", message: { role: "user", content: "hi" } },
			{ type: "message", message: { role: "toolResult", toolName: "TodoWrite", isError: false, details: { todos: older } } },
			{ type: "message", message: { role: "toolResult", toolName: "Read", isError: false, details: { todos: [] } } },
			{ type: "message", message: { role: "toolResult", toolName: "TodoWrite", isError: false, details: { todos: sample } } },
			{ type: "message", message: { role: "toolResult", toolName: "TodoWrite", isError: true, details: {} } },
		];
		await fire("session_start", { type: "session_start", reason: "resume" }, fakeCtx("/tmp", { sessionManager: { getBranch: () => entries } as any }));
		expect(events.at(-1)).toEqual({ type: "todos_updated", todos: sample });

		await fire("session_tree", { type: "session_tree" }, fakeCtx("/tmp", { sessionManager: { getBranch: () => entries.slice(0, 2) } as any }));
		expect(events.at(-1)).toEqual({ type: "todos_updated", todos: older });

		await fire("session_tree", { type: "session_tree" }, fakeCtx("/tmp", { sessionManager: { getBranch: () => [] } as any }));
		expect(events.at(-1)).toEqual({ type: "todos_updated", todos: [] });
	});
});

describe("TodoWrite reminder", () => {
	const N = TODO_REMINDER_TURNS;

	it("injects a reminder after N turns without TodoWrite while todos are incomplete, at most once per N turns", async () => {
		const { run, fire } = setup();
		await run(sample);
		const turns: Array<string | undefined> = ["TodoWrite"];
		for (let i = 0; i < N - 1; i++) turns.push(undefined);
		expect(await fire("context", { type: "context", messages: contextWith(turns) })).toBeUndefined();

		turns.push(undefined); // N turns since TodoWrite
		const out = await fire("context", { type: "context", messages: contextWith(turns) });
		const last = out.messages.at(-1);
		expect(last.role).toBe("custom");
		expect(last.display).toBe(false);
		expect(last.content).toMatch(/^<system-reminder>/);
		expect(last.content).toContain("The TodoWrite tool hasn't been used recently");
		expect(last.content).toContain("NEVER mention this reminder to the user");
		expect(last.content).toContain("1. [in_progress] Run tests");
		expect(last.content).toContain("2. [pending] Build");

		// no spam within the next N-1 turns
		for (let i = 0; i < N - 1; i++) {
			turns.push(undefined);
			expect(await fire("context", { type: "context", messages: contextWith(turns) })).toBeUndefined();
		}
		turns.push(undefined);
		expect((await fire("context", { type: "context", messages: contextWith(turns) }))?.messages.at(-1).role).toBe("custom");
	});

	it("does not remind when all todos are completed", async () => {
		const { run, fire } = setup();
		await run([{ content: "a", activeForm: "A", status: "completed" }]);
		const turns: Array<string | undefined> = ["TodoWrite", ...Array(N + 2).fill(undefined)];
		expect(await fire("context", { type: "context", messages: contextWith(turns) })).toBeUndefined();
	});

	it("reminds in a long run where TodoWrite was never used", async () => {
		const { fire } = setup();
		expect(await fire("context", { type: "context", messages: contextWith(Array(N - 1).fill("Bash")) })).toBeUndefined();
		const out = await fire("context", { type: "context", messages: contextWith(Array(N).fill("Bash")) });
		expect(out.messages.at(-1).content).toContain("The TodoWrite tool hasn't been used recently");
		expect(out.messages.at(-1).content).not.toContain("existing contents");
	});

	it("end-to-end: persists todos in details and the model sees a reminder after N turns", async () => {
		const events: ClaudeCodeHostEvent[] = [];
		const seenReminders: number[] = [];
		const responses: any[] = [fauxAssistantMessage(fauxToolCall("TodoWrite", { todos: sample }), { stopReason: "toolUse" })];
		for (let i = 0; i < N + 1; i++) {
			responses.push((ctx: any) => {
				const hasReminder = ctx.messages.some(
					(m: any) => m.role === "user" && JSON.stringify(m.content).includes("The TodoWrite tool hasn't been used recently"),
				);
				if (hasReminder) seenReminders.push(i);
				return fauxAssistantMessage(fauxToolCall("Noop", {}), { stopReason: "toolUse" });
			});
		}
		responses.push(fauxAssistantMessage("done"));
		const t = await createTestSession({
			responses,
			claudeCode: { onEvent: (e) => events.push(e), subagents: false },
			extraExtensions: [
				(pi) =>
					pi.registerTool({
						name: "Noop",
						label: "Noop",
						description: "noop",
						parameters: { type: "object", properties: {} } as any,
						async execute() {
							return { content: [{ type: "text", text: "ok" }], details: {} };
						},
					}),
			],
		});
		await t.session.prompt("do work");
		const todoResult = t.toolResults().find((r) => r.toolName === "TodoWrite")!;
		expect(todoResult.isError).toBe(false);
		expect(todoResult.text).toBe(TODO_WRITE_RESULT_TEXT);
		expect(todoResult.details).toEqual({ todos: sample });
		expect(events).toContainEqual({ type: "todos_updated", todos: sample });
		// before response i the context holds i assistant turns since the TodoWrite turn;
		// the reminder is transient, so only the call at i === N sees it
		expect(seenReminders).toEqual([N]);

		// branch-based reconstruction from the real session
		const reEvents: ClaudeCodeHostEvent[] = [];
		const cc = createCCContext({ onEvent: (e) => reEvents.push(e) });
		const { handlers } = captureTools((pi) => registerTodoWrite(pi, cc));
		for (const h of handlers.get("session_start")!) {
			await h({ type: "session_start", reason: "resume" }, fakeCtx(t.cwd, { sessionManager: t.session.sessionManager } as any));
		}
		expect(reEvents).toEqual([{ type: "todos_updated", todos: sample }]);
		t.dispose();
	});
});

import type { AssistantMessage, Context } from "@mariozechner/pi-ai";
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { subagentInternals } from "../src/subagent/index.js";
import type { ClaudeCodeHostEvent } from "../src/shared/types.js";
import { createTestSession, fauxAssistantMessage, fauxToolCall, tempDir, type TestSession } from "./helpers.js";

const CHILD_MARKER = "CHILD-AGENT-SYSTEM-PROMPT";

type Handler = (ctx: Context, options: any) => AssistantMessage | Promise<AssistantMessage>;

/** Fill the shared faux queue with one routing factory so parent and child calls can interleave freely. */
function routed(handler: Handler, n = 30) {
	return Array.from({ length: n }, () => (ctx: Context, options: any) => handler(ctx, options));
}

const isChild = (ctx: Context) => (ctx.systemPrompt ?? "").includes(CHILD_MARKER);
const toolNames = (ctx: Context) => (ctx.tools ?? []).map((t) => t.name);

function msgText(m: any): string {
	if (typeof m.content === "string") return m.content;
	return (m.content ?? []).map((c: any) => c.text ?? (c.type === "toolCall" ? `${c.name}` : "")).join("\n");
}
const allText = (ctx: Context) => ctx.messages.map(msgText).join("\n");
const lastRole = (ctx: Context) => ctx.messages.at(-1)?.role;
const firstUserText = (ctx: Context) => msgText(ctx.messages.find((m) => m.role === "user") ?? { content: "" });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs = 5000) {
	const t0 = Date.now();
	while (!cond()) {
		if (Date.now() - t0 > timeoutMs) throw new Error("waitFor timed out");
		await sleep(10);
	}
}

const echoExtension: ExtensionFactory = (pi) => {
	for (const name of ["Echo", "Forbidden"]) {
		pi.registerTool({
			name,
			label: name,
			description: `${name} tool`,
			parameters: { type: "object", properties: { v: { type: "string" } } } as any,
			async execute(_id, p: any) {
				return { content: [{ type: "text", text: `${name}:${p.v}` }], details: {} };
			},
		});
	}
};

const agents = {
	tester: { description: "Test agent", prompt: `${CHILD_MARKER} tester` },
	restricted: { description: "Restricted agent", prompt: `${CHILD_MARKER} restricted`, tools: ["Echo", "Read"] },
};

describe("Task tool (subagents)", () => {
	let t: TestSession | undefined;
	let events: ClaudeCodeHostEvent[];

	beforeEach(() => {
		events = [];
		subagentInternals.homeDir = tempDir("pi-cc-home-");
		subagentInternals.childExtensionFactories = [echoExtension];
	});
	afterEach(() => {
		t?.dispose();
		t = undefined;
		subagentInternals.homeDir = undefined;
		subagentInternals.childExtensionFactories = [];
	});

	async function setup(handler: Handler, extra: Record<string, unknown> = {}) {
		t = await createTestSession({
			responses: routed(handler),
			claudeCode: { agents, onEvent: (e) => events.push(e), ...extra },
		});
		return t;
	}

	it("registers Task with agent types listed, and returns the child's final text", async () => {
		let parentTools: string[] = [];
		let parentTaskDescription = "";
		let childCtx: Context | undefined;
		await setup((ctx) => {
			if (isChild(ctx)) {
				childCtx = ctx;
				return fauxAssistantMessage("child final answer");
			}
			parentTools = toolNames(ctx);
			parentTaskDescription = ctx.tools?.find((x) => x.name === "Task")?.description ?? "";
			if (lastRole(ctx) === "toolResult") return fauxAssistantMessage("parent done");
			return fauxAssistantMessage(fauxToolCall("Task", { description: "Test the thing", prompt: "do the work", subagent_type: "tester" }, { id: "call-1" }), {
				stopReason: "toolUse",
			});
		});
		await t!.session.prompt("go");

		expect(parentTools).toContain("Task");
		expect(parentTaskDescription).toContain("- general-purpose:");
		expect(parentTaskDescription).toContain("- Explore:");
		expect(parentTaskDescription).toContain("- Plan:");
		expect(parentTaskDescription).toContain("- tester: Test agent");

		// child: agent prompt as system prompt, task prompt as user message, no nested Task / AskUserQuestion
		expect(childCtx!.systemPrompt!.startsWith(`${CHILD_MARKER} tester`)).toBe(true);
		expect(childCtx!.systemPrompt).toContain("Current working directory:");
		expect(firstUserText(childCtx!)).toBe("do the work");
		expect(toolNames(childCtx!)).toContain("Echo");
		expect(toolNames(childCtx!)).not.toContain("Task");
		expect(toolNames(childCtx!)).not.toContain("AskUserQuestion");

		const [res] = t!.toolResults();
		expect(res.toolName).toBe("Task");
		expect(res.isError).toBe(false);
		expect(res.text.startsWith("child final answer")).toBe(true);
		expect(res.text).toMatch(/agentId: a[0-9a-f]+/);
		expect(res.text).toMatch(/<usage>total_tokens: \d+\ntool_uses: 0\nduration_ms: \d+<\/usage>/);
		expect(res.details).toMatchObject({ subagentType: "tester", description: "Test the thing", status: "completed", background: false });
		expect(res.details.usage).toMatchObject({ turns: 1, toolUses: 0 });
		expect(res.details.usage.totalTokens).toBeGreaterThan(0);
		expect((t!.session.messages.at(-1) as any).content[0].text).toBe("parent done");

		// events
		const start = events.find((e) => e.type === "subagent_start") as any;
		const end = events.find((e) => e.type === "subagent_end") as any;
		expect(start).toMatchObject({ parentToolCallId: "call-1", subagentType: "tester", description: "Test the thing", background: false });
		expect(start.agentId).toBe(res.details.agentId);
		expect(end).toMatchObject({ agentId: start.agentId, parentToolCallId: "call-1", isError: false });
		expect(end.usage.turns).toBe(1);
		const forwarded = events.filter((e) => e.type === "subagent_event") as any[];
		expect(forwarded.length).toBeGreaterThan(0);
		expect(forwarded.every((e) => e.agentId === start.agentId && e.parentToolCallId === "call-1")).toBe(true);
		const types = forwarded.map((e) => e.event.type);
		expect(types).toContain("agent_start");
		expect(types).toContain("message_end");
		expect(types).toContain("agent_end");
		expect(events.indexOf(start)).toBeLessThan(events.indexOf(end));
	});

	it("restricts the child's tools to the definition allowlist and reports tool use progress", async () => {
		let childTools: string[] = [];
		const updates: any[] = [];
		await setup((ctx) => {
			if (isChild(ctx)) {
				childTools = toolNames(ctx);
				if (lastRole(ctx) === "toolResult") return fauxAssistantMessage("used echo");
				return fauxAssistantMessage(fauxToolCall("Echo", { v: "hi" }), { stopReason: "toolUse" });
			}
			if (lastRole(ctx) === "toolResult") return fauxAssistantMessage("ok");
			return fauxAssistantMessage(fauxToolCall("Task", { description: "Restricted", prompt: "use echo", subagent_type: "restricted" }), { stopReason: "toolUse" });
		});
		t!.session.subscribe((e: any) => {
			if (e.type === "tool_execution_update" && e.toolName === "Task") updates.push(e.partialResult);
		});
		await t!.session.prompt("go");
		expect(childTools).toContain("Echo");
		expect(childTools).not.toContain("Forbidden");
		expect(childTools).not.toContain("Task");
		expect(childTools.every((n) => ["Echo", "Read"].includes(n))).toBe(true);
		const [res] = t!.toolResults();
		expect(res.text.startsWith("used echo")).toBe(true);
		expect(res.details.usage).toMatchObject({ turns: 2, toolUses: 1 });
		expect(updates.some((u) => u.details?.lastToolName === "Echo")).toBe(true);
	});

	it("uses Explore's read-only prompt and tool set", async () => {
		let childCtx: Context | undefined;
		await setup((ctx) => {
			if ((ctx.systemPrompt ?? "").includes("file search specialist")) {
				childCtx = ctx;
				return fauxAssistantMessage("found it");
			}
			if (lastRole(ctx) === "toolResult") return fauxAssistantMessage("ok");
			return fauxAssistantMessage(fauxToolCall("Task", { description: "Find stuff", prompt: "find x", subagent_type: "Explore" }), { stopReason: "toolUse" });
		});
		await t!.session.prompt("go");
		expect(childCtx!.systemPrompt).toContain("READ-ONLY");
		const names = toolNames(childCtx!);
		expect(names).not.toContain("Echo");
		expect(names).not.toContain("Write");
		expect(names).not.toContain("Edit");
		expect(names.every((n) => ["Read", "Grep", "Glob", "Bash", "WebFetch", "WebSearch"].includes(n))).toBe(true);
	});

	it("runs multiple Task calls from one message concurrently", async () => {
		const spans: Record<string, { start: number; end: number }> = {};
		await setup(async (ctx) => {
			if (isChild(ctx)) {
				const key = firstUserText(ctx);
				const start = Date.now();
				await sleep(150);
				spans[key] = { start, end: Date.now() };
				return fauxAssistantMessage(`result ${key}`);
			}
			if (lastRole(ctx) === "toolResult") return fauxAssistantMessage("both done");
			return fauxAssistantMessage(
				[
					fauxToolCall("Task", { description: "First", prompt: "A", subagent_type: "tester" }, { id: "c-a" }),
					fauxToolCall("Task", { description: "Second", prompt: "B", subagent_type: "tester" }, { id: "c-b" }),
				],
				{ stopReason: "toolUse" },
			);
		});
		await t!.session.prompt("go");
		expect(spans.A && spans.B).toBeTruthy();
		expect(spans.B.start).toBeLessThan(spans.A.end);
		expect(spans.A.start).toBeLessThan(spans.B.end);
		const results = t!.toolResults();
		expect(results.map((r) => r.text.split("\n")[0]).sort()).toEqual(["result A", "result B"]);
		const starts = events.filter((e) => e.type === "subagent_start") as any[];
		expect(starts.map((s) => s.parentToolCallId).sort()).toEqual(["c-a", "c-b"]);
		expect(new Set(starts.map((s) => s.agentId)).size).toBe(2);
	});

	it("runs in the background and wakes the parent with a task notification", async () => {
		let notificationSeen = "";
		let childDone = false;
		await setup(async (ctx) => {
			if (isChild(ctx)) {
				await sleep(150);
				childDone = true;
				return fauxAssistantMessage("background findings");
			}
			const text = allText(ctx);
			if (text.includes("<task-notification>")) {
				notificationSeen = text;
				return fauxAssistantMessage("got the notification");
			}
			if (lastRole(ctx) === "toolResult") return fauxAssistantMessage("launched");
			return fauxAssistantMessage(
				fauxToolCall("Task", { description: "Bg work", prompt: "work in bg", subagent_type: "tester", run_in_background: true }, { id: "bg-1" }),
				{ stopReason: "toolUse" },
			);
		});
		await t!.session.prompt("go");
		expect(childDone).toBe(false); // the parent turn did not wait for the child
		const [res] = t!.toolResults();
		expect(res.text).toContain("Async agent launched successfully");
		expect(res.details).toMatchObject({ status: "async_launched", background: true });
		expect(events.find((e) => e.type === "subagent_start")).toMatchObject({ background: true, parentToolCallId: "bg-1" });

		await waitFor(() => (t!.session.messages.at(-1) as any)?.content?.[0]?.text === "got the notification");
		expect(notificationSeen).toContain(`<task-id>${res.details.agentId}</task-id>`);
		expect(notificationSeen).toContain("<status>completed</status>");
		expect(notificationSeen).toContain("background findings");
		expect(events.find((e) => e.type === "subagent_end")).toMatchObject({ agentId: res.details.agentId, isError: false, parentToolCallId: "bg-1" });
	});

	it("propagates parent abort to the child session", async () => {
		let childSignal: AbortSignal | undefined;
		await setup(async (ctx, options) => {
			if (isChild(ctx)) {
				childSignal = options?.signal;
				await sleep(300);
				return fauxAssistantMessage("too late");
			}
			if (lastRole(ctx) === "toolResult") return fauxAssistantMessage("after");
			return fauxAssistantMessage(fauxToolCall("Task", { description: "Slow", prompt: "slow", subagent_type: "tester" }), { stopReason: "toolUse" });
		});
		const p = t!.session.prompt("go");
		await waitFor(() => childSignal !== undefined);
		await t!.session.abort();
		await p;
		expect(childSignal!.aborted).toBe(true);
		const end = events.find((e) => e.type === "subagent_end") as any;
		expect(end).toMatchObject({ isError: true });
		const res = t!.toolResults()[0];
		expect(res?.isError).toBe(true);
	});

	it("aborts background agents on session_shutdown without notifying", async () => {
		let childSignal: AbortSignal | undefined;
		await setup(async (ctx, options) => {
			if (isChild(ctx)) {
				childSignal = options?.signal;
				await sleep(200);
				return fauxAssistantMessage("never delivered");
			}
			if (lastRole(ctx) === "toolResult") return fauxAssistantMessage("launched");
			return fauxAssistantMessage(fauxToolCall("Task", { description: "Bg", prompt: "bg", subagent_type: "tester", run_in_background: true }), {
				stopReason: "toolUse",
			});
		});
		await t!.session.prompt("go");
		await waitFor(() => childSignal !== undefined);
		await t!.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		expect(childSignal!.aborted).toBe(true);
		await waitFor(() => events.some((e) => e.type === "subagent_end"));
		await sleep(250);
		expect(allTextOf(t!.session.messages)).not.toContain("<task-notification>");
	});

	it("reports unknown agent types and models as tool errors", async () => {
		let step = 0;
		await setup((ctx) => {
			if (lastRole(ctx) === "toolResult") {
				step++;
				if (step === 1)
					return fauxAssistantMessage(fauxToolCall("Task", { description: "x", prompt: "y", subagent_type: "tester", model: "definitely-not-a-model" }), { stopReason: "toolUse" });
				return fauxAssistantMessage("done");
			}
			return fauxAssistantMessage(fauxToolCall("Task", { description: "x", prompt: "y", subagent_type: "nope" }), { stopReason: "toolUse" });
		});
		await t!.session.prompt("go");
		const [a, b] = t!.toolResults();
		expect(a.isError).toBe(true);
		expect(a.text).toContain("Agent type 'nope' not found");
		expect(a.text).toContain("general-purpose");
		expect(b.isError).toBe(true);
		expect(b.text).toContain('Unknown model "definitely-not-a-model"');
		expect(events.filter((e) => e.type === "subagent_start")).toHaveLength(0);
	});

	it("propagates child model errors as tool errors", async () => {
		await setup((ctx) => {
			if (isChild(ctx)) return fauxAssistantMessage([], { stopReason: "error", errorMessage: "boom from child" });
			if (lastRole(ctx) === "toolResult") return fauxAssistantMessage("done");
			return fauxAssistantMessage(fauxToolCall("Task", { description: "x", prompt: "y", subagent_type: "tester" }), { stopReason: "toolUse" });
		});
		await t!.session.prompt("go");
		const [res] = t!.toolResults();
		expect(res.isError).toBe(true);
		expect(res.text).toContain("boom from child");
		expect(events.find((e) => e.type === "subagent_end")).toMatchObject({ isError: true });
	});

	it("resumes a finished agent with its previous context", async () => {
		let agentId = "";
		let resumedCtx: Context | undefined;
		await setup((ctx) => {
			if (isChild(ctx)) {
				if (allText(ctx).includes("second question")) {
					resumedCtx = ctx;
					return fauxAssistantMessage("second answer");
				}
				return fauxAssistantMessage("first answer");
			}
			if (lastRole(ctx) === "toolResult") {
				const last = msgText(ctx.messages.at(-1));
				const m = last.match(/agentId: (a[0-9a-f]+)/);
				if (m && !agentId) {
					agentId = m[1];
					return fauxAssistantMessage(fauxToolCall("Task", { description: "Follow up", prompt: "second question", resume: agentId }), { stopReason: "toolUse" });
				}
				return fauxAssistantMessage("done");
			}
			return fauxAssistantMessage(fauxToolCall("Task", { description: "First", prompt: "first question", subagent_type: "tester" }), { stopReason: "toolUse" });
		});
		await t!.session.prompt("go");
		const [first, second] = t!.toolResults();
		expect(first.text.startsWith("first answer")).toBe(true);
		expect(second.isError).toBe(false);
		expect(second.text.startsWith("second answer")).toBe(true);
		expect(second.details.agentId).toBe(agentId);
		expect(allText(resumedCtx!)).toContain("first question");
		expect(allText(resumedCtx!)).toContain("first answer");
	});
});

function allTextOf(messages: readonly any[]): string {
	return messages.map(msgText).join("\n");
}

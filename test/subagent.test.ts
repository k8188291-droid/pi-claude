import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
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

describe("Agent tool (subagents)", () => {
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

	async function setup(handler: Handler, extra: Record<string, unknown> = {}, cwd?: string) {
		t = await createTestSession({
			cwd,
			responses: routed(handler),
			claudeCode: { agents, onEvent: (e) => events.push(e), ...extra },
		});
		return t;
	}

	const agentCall = (input: Record<string, unknown>, id?: string) => fauxAssistantMessage(fauxToolCall("Agent", input, id ? { id } : undefined), { stopReason: "toolUse" });

	it("registers Agent, lists agent types in a reminder, and returns a foreground child's framed report", async () => {
		let parentTools: string[] = [];
		let parentDescription = "";
		let parentFirstText = "";
		let childCtx: Context | undefined;
		await setup((ctx) => {
			if (isChild(ctx)) {
				childCtx = ctx;
				return fauxAssistantMessage("child final answer");
			}
			parentTools = toolNames(ctx);
			parentDescription = ctx.tools?.find((x) => x.name === "Agent")?.description ?? "";
			if (lastRole(ctx) === "toolResult") return fauxAssistantMessage("parent done");
			parentFirstText = allText(ctx);
			return agentCall({ description: "Test the thing", prompt: "do the work", subagent_type: "tester", run_in_background: false }, "call-1");
		});
		await t!.session.prompt("go");

		expect(parentTools).toContain("Agent");
		expect(parentTools).not.toContain("Task");
		expect(parentDescription).toContain("Available agent types are listed in <system-reminder> messages in the conversation.");
		expect(parentFirstText).toContain("Available agent types for the Agent tool:");
		expect(parentFirstText).toContain("- tester: Test agent (Tools: All tools)");

		// child: agent prompt + subagent notes as system prompt, task prompt as first user message
		expect(childCtx!.systemPrompt!.startsWith(`${CHILD_MARKER} tester\n\nMessages from the agent that launched you`)).toBe(true);
		expect(childCtx!.systemPrompt).toContain("<cwd>");
		expect(firstUserText(childCtx!)).toBe("do the work");
		expect(toolNames(childCtx!)).toContain("Echo");
		expect(toolNames(childCtx!)).toContain("Agent"); // subagents may launch agents
		expect(toolNames(childCtx!)).not.toContain("AskUserQuestion");

		const [res] = t!.toolResults();
		expect(res.toolName).toBe("Agent");
		expect(res.isError).toBe(false);
		expect(res.text.startsWith("[Subagent hand-back] The text below is the final report")).toBe(true);
		expect(res.text).toContain("The report follows:\n  child final answer\nagentId: a");
		expect(res.text).toMatch(/agentId: a[0-9a-f]{16}\n<usage>subagent_tokens: \d+\ntool_uses: 0\nduration_ms: \d+<\/usage>$/);
		expect(res.details).toMatchObject({ subagentType: "tester", description: "Test the thing", status: "completed", background: false });
		expect(res.details.usage).toMatchObject({ turns: 1, toolUses: 0 });
		expect((t!.session.messages.at(-1) as any).content[0].text).toBe("parent done");

		const start = events.find((e) => e.type === "subagent_start") as any;
		const end = events.find((e) => e.type === "subagent_end") as any;
		expect(start).toMatchObject({ parentToolCallId: "call-1", subagentType: "tester", description: "Test the thing", background: false });
		expect(start.agentId).toBe(res.details.agentId);
		expect(end).toMatchObject({ agentId: start.agentId, parentToolCallId: "call-1", isError: false });
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
			return agentCall({ description: "Restricted", prompt: "use echo", subagent_type: "restricted", run_in_background: false });
		});
		t!.session.subscribe((e: any) => {
			if (e.type === "tool_execution_update" && e.toolName === "Agent") updates.push(e.partialResult);
		});
		await t!.session.prompt("go");
		expect(childTools.sort()).toEqual(["Echo", "Read"]);
		const [res] = t!.toolResults();
		expect(res.text).toContain("  used echo\nagentId:");
		expect(res.text).toMatch(/tool_uses: 1\n/);
		expect(res.details.usage).toMatchObject({ turns: 2, toolUses: 1 });
		expect(updates.some((u) => u.details?.lastToolName === "Echo")).toBe(true);
	});

	it("uses Explore's read-only prompt and tool set, and rewrites unavailable-tool errors", async () => {
		let childCtx: Context | undefined;
		let writeResult = "";
		await setup((ctx) => {
			if ((ctx.systemPrompt ?? "").includes("file search specialist")) {
				childCtx = ctx;
				if (lastRole(ctx) === "toolResult") {
					writeResult = msgText(ctx.messages.at(-1));
					return fauxAssistantMessage("found it");
				}
				return fauxAssistantMessage(fauxToolCall("Write", { file_path: "/tmp/x", content: "x" }), { stopReason: "toolUse" });
			}
			if (lastRole(ctx) === "toolResult") return fauxAssistantMessage("ok");
			return agentCall({ description: "Find stuff", prompt: "find x", subagent_type: "Explore", run_in_background: false });
		});
		await t!.session.prompt("go");
		expect(childCtx!.systemPrompt).toContain("READ-ONLY");
		const names = toolNames(childCtx!);
		for (const n of ["Read", "Grep", "Glob", "Bash", "TaskStop", "Echo"]) expect(names).toContain(n);
		for (const n of ["Write", "Edit", "Agent", "AskUserQuestion"]) expect(names).not.toContain(n);
		expect(writeResult).toBe("Error: No such tool available: Write. Write is not among the tools available here. Continue with the tools you have.");
		// Explore/Plan foreground results carry no agentId/usage trailer
		expect(t!.toolResults()[0].text).toMatch(/The report follows:\n {2}found it$/);
	});

	it("matches subagent_type ignoring case and dashes, and validates input like Claude Code", async () => {
		let step = 0;
		await setup((ctx) => {
			if (isChild(ctx) || (ctx.systemPrompt ?? "").includes("file search specialist")) return fauxAssistantMessage("child ok");
			if (lastRole(ctx) !== "toolResult") return agentCall({ description: "x", prompt: "y", subagent_type: "nope" });
			step++;
			if (step === 1) return agentCall({ description: "x", prompt: "y", subagent_type: "explore", run_in_background: false });
			if (step === 2) return agentCall({ description: "x", prompt: "y", model: "gpt-5" });
			if (step === 3) return agentCall({ description: "x" });
			return fauxAssistantMessage("done");
		});
		await t!.session.prompt("go");
		const [a, b, c, d] = t!.toolResults();
		expect(a).toMatchObject({ isError: true, text: "Agent type 'nope' not found. Available agents: Explore, general-purpose, Plan, restricted, tester" });
		expect(b.isError).toBe(false);
		expect(b.details.subagentType).toBe("Explore");
		expect(c.isError).toBe(true);
		expect(c.text).toContain('"code": "invalid_value"');
		expect(d).toMatchObject({ isError: true, text: "InputValidationError: Agent failed due to the following issue:\nThe required parameter `prompt` is missing" });
		expect(events.filter((e) => e.type === "subagent_start")).toHaveLength(1);
	});

	it("runs multiple foreground Agent calls from one message concurrently", async () => {
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
					fauxToolCall("Agent", { description: "First", prompt: "A", subagent_type: "tester", run_in_background: false }, { id: "c-a" }),
					fauxToolCall("Agent", { description: "Second", prompt: "B", subagent_type: "tester", run_in_background: false }, { id: "c-b" }),
				],
				{ stopReason: "toolUse" },
			);
		});
		await t!.session.prompt("go");
		expect(spans.A && spans.B).toBeTruthy();
		expect(spans.B.start).toBeLessThan(spans.A.end);
		expect(spans.A.start).toBeLessThan(spans.B.end);
		const results = t!.toolResults();
		expect(results.map((r) => r.text.split("\n")[1]).sort()).toEqual(["  result A", "  result B"]);
		const starts = events.filter((e) => e.type === "subagent_start") as any[];
		expect(starts.map((s) => s.parentToolCallId).sort()).toEqual(["c-a", "c-b"]);
		expect(new Set(starts.map((s) => s.agentId)).size).toBe(2);
	});

	it("runs in the background by default, writes a transcript, and wakes the parent with a task notification", async () => {
		let notificationSeen = "";
		let childDone = false;
		let childTools: string[] = [];
		await setup(async (ctx) => {
			if (isChild(ctx)) {
				childTools = toolNames(ctx);
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
			return agentCall({ description: "Bg work", prompt: "work in bg", subagent_type: "tester" }, "bg-1");
		});
		await t!.session.prompt("go");
		expect(childDone).toBe(false); // the parent turn did not wait for the child
		const [res] = t!.toolResults();
		expect(res.text.startsWith("Async agent launched successfully. (This tool result is internal metadata")).toBe(true);
		expect(res.text).toContain(`agentId: ${res.details.agentId} (internal ID - do not mention to user.)`);
		expect(res.text).toContain(`output_file: ${res.details.outputFile}`);
		expect(res.details).toMatchObject({ status: "async_launched", background: true });
		expect(events.find((e) => e.type === "subagent_start")).toMatchObject({ background: true, parentToolCallId: "bg-1" });

		await waitFor(() => (t!.session.messages.at(-1) as any)?.content?.[0]?.text === "got the notification");
		expect(childTools).not.toContain("AskUserQuestion");
		expect(notificationSeen).toContain(`<task-id>${res.details.agentId}</task-id>\n<tool-use-id>bg-1</tool-use-id>\n<output-file>${res.details.outputFile}</output-file>`);
		expect(notificationSeen).toContain("<status>completed</status>\n<summary>Agent \"Bg work\" finished</summary>\n<note>A task-notification fires each time");
		expect(notificationSeen).toContain("<result>background findings</result>\n<usage><subagent_tokens>");
		expect(events.find((e) => e.type === "subagent_end")).toMatchObject({ agentId: res.details.agentId, isError: false, parentToolCallId: "bg-1" });
		const transcript = readFileSync(res.details.outputFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		expect(transcript.map((l) => l.type)).toEqual(["user", "custom", "assistant"]); // prompt, agent listing reminder, reply
	});

	it("TaskStop stops a background agent and reports it as killed", async () => {
		let childSignal: AbortSignal | undefined;
		let agentId = "";
		let notification = "";
		await setup(async (ctx, options) => {
			if (isChild(ctx)) {
				childSignal = options?.signal;
				await new Promise((r) => {
					options?.signal?.addEventListener("abort", r);
					setTimeout(r, 3000);
				});
				return fauxAssistantMessage("never delivered");
			}
			const text = allText(ctx);
			if (text.includes("<task-notification>")) {
				notification = text;
				return fauxAssistantMessage("noted");
			}
			const m = /agentId: (a[0-9a-f]+)/.exec(msgText(ctx.messages.at(-1)));
			if (m && !agentId) {
				agentId = m[1];
				await waitFor(() => childSignal !== undefined);
				return fauxAssistantMessage(fauxToolCall("TaskStop", { task_id: agentId }), { stopReason: "toolUse" });
			}
			if (lastRole(ctx) === "toolResult") return fauxAssistantMessage("stopped");
			return agentCall({ description: "Slow agent", prompt: "slow", subagent_type: "tester" });
		});
		await t!.session.prompt("go");
		const stop = t!.toolResults()[1];
		expect(stop.toolName).toBe("TaskStop");
		expect(JSON.parse(stop.text)).toEqual({ message: `Successfully stopped task: ${agentId} (Slow agent)`, task_id: agentId, task_type: "local_agent", command: "Slow agent" });
		expect(stop.text).not.toContain("task-notification");
		expect(childSignal!.aborted).toBe(true);
		await waitFor(() => notification !== "");
		expect(notification).toContain("<status>killed</status>\n<summary>Agent \"Slow agent\" was stopped by Claude</summary>");
		expect(notification).not.toContain("<usage>");
	});

	it("propagates parent abort to a foreground child session", async () => {
		let childSignal: AbortSignal | undefined;
		await setup(async (ctx, options) => {
			if (isChild(ctx)) {
				childSignal = options?.signal;
				await sleep(300);
				return fauxAssistantMessage("too late");
			}
			if (lastRole(ctx) === "toolResult") return fauxAssistantMessage("after");
			return agentCall({ description: "Slow", prompt: "slow", subagent_type: "tester", run_in_background: false });
		});
		const p = t!.session.prompt("go");
		await waitFor(() => childSignal !== undefined);
		await t!.session.abort();
		await p;
		expect(childSignal!.aborted).toBe(true);
		expect(events.find((e) => e.type === "subagent_end")).toMatchObject({ isError: true });
		expect(t!.toolResults()[0]?.isError).toBe(true);
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
			return agentCall({ description: "Bg", prompt: "bg", subagent_type: "tester" });
		});
		await t!.session.prompt("go");
		await waitFor(() => childSignal !== undefined);
		await t!.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		expect(childSignal!.aborted).toBe(true);
		await waitFor(() => events.some((e) => e.type === "subagent_end"));
		await sleep(250);
		expect(allTextOf(t!.session.messages)).not.toContain("<task-notification>");
	});

	it("lets a subagent launch a nested agent, which runs in the foreground by default", async () => {
		let innerCtx: Context | undefined;
		let outerSaw = "";
		await setup((ctx) => {
			if (isChild(ctx)) {
				if (firstUserText(ctx) === "inner task") {
					innerCtx = ctx;
					return fauxAssistantMessage("inner result");
				}
				if (lastRole(ctx) === "toolResult") {
					outerSaw = msgText(ctx.messages.at(-1));
					return fauxAssistantMessage("outer result");
				}
				return agentCall({ description: "Inner", prompt: "inner task", subagent_type: "tester" });
			}
			if (lastRole(ctx) === "toolResult") return fauxAssistantMessage("done");
			return agentCall({ description: "Outer", prompt: "outer task", subagent_type: "tester", run_in_background: false });
		});
		await t!.session.prompt("go");
		expect(innerCtx).toBeDefined();
		expect(outerSaw).toContain("The report follows:\n  inner result\nagentId:");
		expect(t!.toolResults()[0].text).toContain("  outer result\nagentId:");
	});

	it("forks: the child inherits the parent's conversation and gets the fork directive", async () => {
		let forkCtx: Context | undefined;
		await setup((ctx) => {
			if (allText(ctx).includes("<fork-boilerplate>")) {
				forkCtx = ctx;
				return fauxAssistantMessage("fork report");
			}
			if (lastRole(ctx) === "toolResult") return fauxAssistantMessage("done");
			return agentCall({ description: "Fork it", prompt: "summarize", subagent_type: "fork", run_in_background: false });
		});
		await t!.session.prompt("original question");
		expect(forkCtx).toBeDefined();
		const text = allText(forkCtx!);
		expect(text).toContain("original question");
		expect(text).toContain("Fork started — processing in background");
		expect(text).toContain("</fork-boilerplate>\nYour directive: summarize");
		expect(t!.toolResults()[0].text).toContain("  fork report\nagentId:");
	});

	it("isolation: worktree runs the agent in a temporary git worktree, kept only when changed", async () => {
		const repo = tempDir("pi-cc-repo-");
		const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, stdio: "pipe" });
		git("init", "-q");
		writeFileSync(join(repo, "a.txt"), "a\n");
		git("add", ".");
		git("commit", "-qm", "init");
		const childCwds: string[] = [];
		await setup(
			(ctx) => {
				if (isChild(ctx)) {
					const cwd = /<cwd>\n(.*)\n<\/cwd>/.exec(ctx.systemPrompt ?? "")?.[1] ?? "";
					if (lastRole(ctx) === "toolResult") return fauxAssistantMessage("wrote");
					childCwds.push(cwd);
					if (firstUserText(ctx) === "edit") return fauxAssistantMessage(fauxToolCall("Write", { file_path: join(cwd, "b.txt"), content: "b\n" }), { stopReason: "toolUse" });
					return fauxAssistantMessage("looked");
				}
				if (lastRole(ctx) !== "toolResult") return agentCall({ description: "Look", prompt: "look", subagent_type: "tester", isolation: "worktree", run_in_background: false });
				if (t!.toolResults().length === 1) return agentCall({ description: "Edit", prompt: "edit", subagent_type: "tester", isolation: "worktree", run_in_background: false });
				return fauxAssistantMessage("done");
			},
			{},
			repo,
		);
		await t!.session.prompt("go");
		const [look, edit] = t!.toolResults();
		expect(childCwds[0]).toContain(join(".claude", "worktrees", "agent-"));
		expect(existsSync(childCwds[0])).toBe(false); // untouched worktree removed
		expect(look.text).not.toContain("worktreePath");
		expect(edit.isError).toBe(false);
		expect(edit.text).toMatch(/agentId: a[0-9a-f]+\nworktreePath: .*\nworktreeBranch: worktree-agent-/);
		expect(readFileSync(join(edit.details.worktree.worktreePath, "b.txt"), "utf8")).toBe("b\n");
		expect(existsSync(join(repo, "b.txt"))).toBe(false);
	});

	it("a subagent restricted to a deferred tool gets tool_search to load it", async () => {
		let child: string[] = [];
		let childAfter: string[] = [];
		t = await createTestSession({
			claudeCode: {
				deferredTools: ["Glob"],
				loadAgentsFromDisk: false,
				agents: { finder: { description: "finds files", prompt: "CHILD", tools: ["Glob", "Read"] } },
			},
			responses: [
				agentCall({ description: "find files", prompt: "go", subagent_type: "finder", run_in_background: false }),
				(ctx: Context) => {
					child = toolNames(ctx);
					return fauxAssistantMessage(fauxToolCall("tool_search", { query: "glob file pattern" }), { stopReason: "toolUse" });
				},
				(ctx: Context) => {
					childAfter = toolNames(ctx);
					return fauxAssistantMessage("child done");
				},
				fauxAssistantMessage("parent done"),
			],
		});
		subagentInternals.childExtensionFactories = [];
		await t.session.prompt("go");
		expect(child.sort()).toEqual(["Read", "tool_search"]);
		expect(childAfter).toContain("Glob");
	});

	it("propagates child model errors as tool errors", async () => {
		await setup((ctx) => {
			if (isChild(ctx)) return fauxAssistantMessage([], { stopReason: "error", errorMessage: "boom from child" });
			if (lastRole(ctx) === "toolResult") return fauxAssistantMessage("done");
			return agentCall({ description: "x", prompt: "y", subagent_type: "tester", run_in_background: false });
		});
		await t!.session.prompt("go");
		const [res] = t!.toolResults();
		expect(res.isError).toBe(true);
		expect(res.text).toContain("boom from child");
		expect(events.find((e) => e.type === "subagent_end")).toMatchObject({ isError: true });
	});
});

function allTextOf(messages: readonly any[]): string {
	return messages.map(msgText).join("\n");
}

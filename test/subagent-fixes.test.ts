import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { subagentInternals } from "../src/subagent/index.js";
import type { ClaudeCodeToolsOptions } from "../src/shared/types.js";
import { createTestSession, fauxAssistantMessage, fauxToolCall, tempDir, type TestSession } from "./helpers.js";

/*
 * Regression tests for docs/review-2026-10-18.md: subagent tool restrictions (#2a/#2b/#2c/#2d),
 * remote isolation (#3) and parent shutdown during child creation (#13).
 */

const CHILD = "CHILD-AGENT-SYSTEM-PROMPT";
type Handler = (ctx: Context, options: any) => AssistantMessage | Promise<AssistantMessage>;
const routed = (handler: Handler, n = 30) => Array.from({ length: n }, () => (ctx: Context, options: any) => handler(ctx, options));
const isChild = (ctx: Context) => (ctx.systemPrompt ?? "").includes(CHILD);
const toolNames = (ctx: Context) => (ctx.tools ?? []).map((t) => t.name).sort();
const lastRole = (ctx: Context) => ctx.messages.at(-1)?.role;
const lastText = (ctx: Context) => {
	const m: any = ctx.messages.at(-1);
	return typeof m?.content === "string" ? m.content : (m?.content ?? []).map((c: any) => c.text ?? "").join("\n");
};
const allText = (ctx: Context) =>
	ctx.messages.map((m: any) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((c: any) => c.text ?? "").join("\n"))).join("\n");
const toolUse = (name: string, input: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, input), { stopReason: "toolUse" });
const agentCall = (input: Record<string, unknown>) => toolUse("Agent", { description: "run it", prompt: "go", run_in_background: false, ...input });

/** A host/MCP-like extension: one direct tool and one deferred MCP tool that records its runs. */
let executed: string[] = [];
const mcpExtension: ExtensionFactory = (pi) => {
	pi.registerTool({
		name: "Echo",
		label: "Echo",
		description: "Echo tool",
		parameters: { type: "object", properties: { v: { type: "string" } } } as any,
		async execute(_id, p: any) {
			executed.push("Echo");
			return { content: [{ type: "text", text: `Echo:${p.v}` }], details: {} };
		},
	});
	pi.registerTool({
		name: "mcp__prod__danger",
		label: "danger",
		description: "dangerous prod tool",
		parameters: { type: "object", properties: { v: { type: "string" } } } as any,
		exposure: "deferred",
		async execute() {
			executed.push("mcp__prod__danger");
			return { content: [{ type: "text", text: "danger ran" }], details: {} };
		},
	});
};

describe("subagent fixes (review 2026-10-18)", () => {
	let t: TestSession | undefined;
	let home: string;

	beforeEach(() => {
		executed = [];
		home = tempDir("pi-cc-home-");
		subagentInternals.homeDir = home;
		subagentInternals.childExtensionFactories = [mcpExtension];
	});
	afterEach(() => {
		t?.dispose();
		t = undefined;
		subagentInternals.homeDir = undefined;
		subagentInternals.childExtensionFactories = [];
	});

	async function run(handler: Handler, claudeCode: ClaudeCodeToolsOptions = {}, cwd?: string) {
		t = await createTestSession({ cwd, responses: routed(handler), claudeCode: { loadAgentsFromDisk: false, ...claudeCode } });
		await t.session.prompt("go");
		return t;
	}

	/** Child: search for the danger tool, then call it; records what the child saw. */
	function dangerProbe(agentType: string, seen: { tools: string[][]; results: string[] }, parentDone = "done"): Handler {
		return (ctx) => {
			if (isChild(ctx)) {
				seen.tools.push(toolNames(ctx));
				if (lastRole(ctx) === "toolResult") seen.results.push(lastText(ctx));
				if (seen.tools.length === 1) return toolUse("tool_search", { query: "danger prod" });
				if (seen.tools.length === 2) return toolUse("mcp__prod__danger", { v: "x" });
				return fauxAssistantMessage("child done");
			}
			if (lastRole(ctx) === "toolResult") return fauxAssistantMessage(parentDone);
			return agentCall({ subagent_type: agentType });
		};
	}

	it("#2a: a tool-restricted agent cannot load or run disallowed deferred tools via tool_search", async () => {
		const seen = { tools: [] as string[][], results: [] as string[] };
		await run(dangerProbe("readonly", seen), { agents: { readonly: { description: "read only", prompt: `${CHILD} ro`, tools: ["Read"] } } });
		expect(seen.tools[0]).toEqual(["Read"]); // like Claude Code: only the allowed tools, no tool_search
		expect(seen.tools.every((names) => !names.includes("mcp__prod__danger"))).toBe(true);
		expect(seen.results[0]).toContain("No such tool available: tool_search");
		expect(seen.results[1]).toContain("No such tool available: mcp__prod__danger");
		expect(executed).toEqual([]);
	});

	it("#2a: an allowed deferred host tool is still loadable with tool_search", async () => {
		const seen = { tools: [] as string[][], results: [] as string[] };
		await run(dangerProbe("prod", seen), { agents: { prod: { description: "prod", prompt: `${CHILD} prod`, tools: ["Read", "mcp__prod__danger"] } } });
		expect(seen.tools[0]).toEqual(["Read", "tool_search"]);
		expect(seen.tools[2]).toContain("mcp__prod__danger");
		expect(executed).toEqual(["mcp__prod__danger"]);
	});

	it("#2b: tools: [] (options) gives the agent no tools at all", async () => {
		const seen = { tools: [] as string[][], results: [] as string[] };
		await run(
			(ctx) => {
				if (isChild(ctx)) {
					seen.tools.push(toolNames(ctx));
					if (lastRole(ctx) === "toolResult") {
						seen.results.push(lastText(ctx));
						return fauxAssistantMessage("child done");
					}
					return toolUse("Echo", { v: "x" });
				}
				if (lastRole(ctx) === "toolResult") return fauxAssistantMessage("done");
				return agentCall({ subagent_type: "empty" });
			},
			{ agents: { empty: { description: "empty", prompt: `${CHILD} empty`, tools: [] } } },
		);
		expect(seen.tools[0]).toEqual([]);
		expect(seen.results[0]).toContain("No such tool available: Echo");
		expect(executed).toEqual([]);
	});

	it("#2b: tools: [] in agent frontmatter gives the agent no tools; an absent tools key still means all", async () => {
		const cwd = tempDir("pi-cc-proj-");
		mkdirSync(join(cwd, ".claude", "agents"), { recursive: true });
		writeFileSync(join(cwd, ".claude", "agents", "emptydisk.md"), `---\nname: emptydisk\ndescription: d\ntools: []\n---\n${CHILD} emptydisk`);
		writeFileSync(join(cwd, ".claude", "agents", "alltools.md"), `---\nname: alltools\ndescription: d\n---\n${CHILD} alltools`);
		const seen: Record<string, string[]> = {};
		let calls = 0;
		await run(
			(ctx) => {
				if (isChild(ctx)) {
					seen[(ctx.systemPrompt ?? "").includes("emptydisk") ? "empty" : "all"] = toolNames(ctx);
					return fauxAssistantMessage("child done");
				}
				calls++;
				if (calls === 1) return agentCall({ subagent_type: "emptydisk" });
				if (calls === 2) return agentCall({ subagent_type: "alltools" });
				return fauxAssistantMessage("done");
			},
			{ loadAgentsFromDisk: true },
			cwd,
		);
		expect(seen.empty).toEqual([]);
		expect(seen.all).toEqual(expect.arrayContaining(["Read", "Bash", "Echo", "Agent"]));
	});

	for (const rule of ["mcp__prod__*", "mcp__prod", "mcp__*"]) {
		it(`#2d: disallowedTools ${rule} removes the MCP server's tools`, async () => {
			const cwd = tempDir("pi-cc-proj-");
			mkdirSync(join(cwd, ".claude", "agents"), { recursive: true });
			writeFileSync(join(cwd, ".claude", "agents", "nomcp.md"), `---\nname: nomcp\ndescription: d\ndisallowedTools: ${rule}\n---\n${CHILD} nomcp`);
			const seen = { tools: [] as string[][], results: [] as string[] };
			await run(
				(ctx) => {
					if (isChild(ctx)) {
						seen.tools.push(toolNames(ctx));
						if (lastRole(ctx) === "toolResult") {
							seen.results.push(lastText(ctx));
							return fauxAssistantMessage("child done");
						}
						return toolUse("mcp__prod__danger", { v: "x" });
					}
					if (lastRole(ctx) === "toolResult") return fauxAssistantMessage("done");
					return agentCall({ subagent_type: "nomcp" });
				},
				{ loadAgentsFromDisk: true },
				cwd,
			);
			expect(seen.tools[0]).toContain("Echo");
			expect(seen.tools[0]).not.toContain("tool_search"); // nothing left to load
			expect(seen.results[0]).toContain("No such tool available: mcp__prod__danger");
			expect(executed).toEqual([]);
		});
	}

	it("#2d: tools: [mcp__prod] allows the whole MCP server", async () => {
		const seen = { tools: [] as string[][], results: [] as string[] };
		await run(dangerProbe("srv", seen), { agents: { srv: { description: "srv", prompt: `${CHILD} srv`, tools: ["mcp__prod"] } } });
		expect(seen.tools[0]).toEqual(["tool_search"]);
		expect(executed).toEqual(["mcp__prod__danger"]);
	});

	describe('#2c quirk agentDisallowAll (disallowedTools: "*")', () => {
		const agents = { noall: { description: "no tools", prompt: `${CHILD} noall`, disallowedTools: ["*"] } as any };
		async function probe(extra: ClaudeCodeToolsOptions) {
			let childTools: string[] | undefined;
			let listing = "";
			await run((ctx) => {
				if (isChild(ctx)) {
					childTools = toolNames(ctx);
					return fauxAssistantMessage("child done");
				}
				if (lastRole(ctx) === "toolResult") return fauxAssistantMessage("done");
				listing = allText(ctx);
				return agentCall({ subagent_type: "noall" });
			}, { agents, ...extra });
			return { childTools: childTools!, listing };
		}

		it("claude-code (default): ignored like Claude Code — the agent keeps every tool", async () => {
			const { childTools, listing } = await probe({});
			expect(childTools).toEqual(expect.arrayContaining(["Read", "Bash", "Echo", "Agent"]));
			expect(listing).toContain("- noall: no tools (Tools: All tools)");
		});

		it("fixed: removes every tool", async () => {
			const { childTools, listing } = await probe({ quirks: { agentDisallowAll: "fixed" } });
			expect(childTools).toEqual([]);
			expect(listing).toContain("- noall: no tools (Tools: None)");
		});

		it("compat: fixed enables it too", async () => {
			const { childTools } = await probe({ compat: "fixed" });
			expect(childTools).toEqual([]);
		});
	});

	describe('#3 quirk remoteIsolationFallback (isolation: "remote")', () => {
		async function probe(extra: ClaudeCodeToolsOptions) {
			let childRan = false;
			await run((ctx) => {
				if (isChild(ctx)) {
					childRan = true;
					return fauxAssistantMessage("child done");
				}
				if (lastRole(ctx) === "toolResult") return fauxAssistantMessage("done");
				return agentCall({ subagent_type: "tester", isolation: "remote" });
			}, { agents: { tester: { description: "t", prompt: `${CHILD} t` } }, ...extra });
			return { childRan, result: t!.toolResults()[0] };
		}

		it("claude-code (default): silently runs locally like Claude Code", async () => {
			const { childRan, result } = await probe({});
			expect(childRan).toBe(true);
			expect(result.isError).toBe(false);
			expect(result.text).toContain("child done");
		});

		it("fixed: fails clearly instead of running locally", async () => {
			const { childRan, result } = await probe({ quirks: { remoteIsolationFallback: "fixed" } });
			expect(childRan).toBe(false);
			expect(result.isError).toBe(true);
			expect(result.text).toContain('isolation: "remote" is not available');
		});
	});

	it("#13: a child created while the parent shuts down never starts", async () => {
		let childModelCalls = 0;
		let childSessionStarted = false;
		const shutdownDuringCreation: ExtensionFactory = (pi) => {
			// runs while the child session is being created: the parent shuts down right then
			void t!.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			pi.on("session_start", () => {
				childSessionStarted = true;
			});
		};
		t = await createTestSession({
			responses: routed((ctx) => {
				if (isChild(ctx)) {
					childModelCalls++;
					return fauxAssistantMessage("child done");
				}
				if (lastRole(ctx) === "toolResult") return fauxAssistantMessage("done");
				return agentCall({ subagent_type: "tester" });
			}),
			claudeCode: { loadAgentsFromDisk: false, agents: { tester: { description: "t", prompt: `${CHILD} t` } } },
		});
		subagentInternals.childExtensionFactories = [shutdownDuringCreation];
		await t.session.prompt("go");
		expect(childModelCalls).toBe(0);
		expect(childSessionStarted).toBe(false);
		const [res] = t.toolResults();
		expect(res.isError).toBe(true);
		expect(res.text).toContain("Subagent was aborted");
	});

	it("writes a background agent's transcript as a private (0600) file", async () => {
		let outputFile = "";
		let childDone = false;
		await run((ctx) => {
			if (isChild(ctx)) {
				childDone = true;
				return fauxAssistantMessage("child done");
			}
			if (lastRole(ctx) === "toolResult") return fauxAssistantMessage("launched");
			return toolUse("Agent", { description: "bg", prompt: "go", subagent_type: "tester" });
		}, { agents: { tester: { description: "t", prompt: `${CHILD} t` } } });
		outputFile = t!.toolResults()[0].details.outputFile;
		const t0 = Date.now();
		while (!childDone && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 10));
		expect(statSync(outputFile).mode & 0o777).toBe(0o600);
	});
});

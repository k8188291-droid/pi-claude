import { describe, expect, it } from "vitest";
import { registerFauxProvider } from "@mariozechner/pi-ai";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionFactory,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { createClaudeCodeExtension, wrapStreamFnForToolSearch } from "../src/index.js";
import { createClaudeCodeSession } from "../src/sdk.js";
import type { ClaudeCodeHostEvent } from "../src/shared/types.js";
import { searchTools } from "../src/tools/tool-search.js";
import { createTestSession, fauxAssistantMessage, fauxToolCall, tempDir } from "./helpers.js";

const DEFERRED_SECTION = "The following deferred tools are now available via ToolSearch";

function echoTool(pi: ExtensionAPI, name: string, description: string) {
	pi.registerTool({
		name,
		label: name,
		description,
		parameters: { type: "object", properties: { v: { type: "string", description: "value" } }, required: ["v"] } as any,
		async execute(_id, p: any) {
			return { content: [{ type: "text", text: `${name}:${p.v}` }], details: {} };
		},
	});
}

const extraTools: ExtensionFactory = (pi) => {
	echoTool(pi, "WebFetch", "Fetches content from a URL and processes it");
	echoTool(pi, "NotebookEdit", "Replace a cell in a Jupyter notebook");
	echoTool(pi, "mcp__slack__send_message", "Send a message to a Slack channel");
	echoTool(pi, "mcp__slack__list_channels", "List channels in Slack");
};

const DEFERRED = ["WebFetch", "NotebookEdit", "mcp__slack__send_message", "mcp__slack__list_channels"];

type Seen = { tools: string[]; systemPrompt: string };

function recordingStep(seen: Seen[], response: () => any) {
	return (context: any) => {
		seen.push({ tools: (context.tools ?? []).map((t: any) => t.name), systemPrompt: context.systemPrompt ?? "" });
		return response();
	};
}

describe("ToolSearch", () => {
	it("is not registered when no tools are deferred", async () => {
		const seen: Seen[] = [];
		const t = await createTestSession({
			responses: [recordingStep(seen, () => fauxAssistantMessage("hi"))],
			extraExtensions: [extraTools],
		});
		await t.session.prompt("go");
		expect(seen[0]!.tools).not.toContain("ToolSearch");
		expect(seen[0]!.tools).toContain("WebFetch");
		expect(seen[0]!.systemPrompt).not.toContain(DEFERRED_SECTION);
		t.dispose();
	});

	it("hides deferred tools, loads them mid-run, and keeps them loaded across prompts", async () => {
		const seen: Seen[] = [];
		const events: ClaudeCodeHostEvent[] = [];
		const t = await createTestSession({
			claudeCode: { deferredTools: DEFERRED, onEvent: (e) => events.push(e) },
			extraExtensions: [extraTools],
			responses: [
				recordingStep(seen, () =>
					fauxAssistantMessage(fauxToolCall("ToolSearch", { query: "select:WebFetch", max_results: 5 }), { stopReason: "toolUse" }),
				),
				recordingStep(seen, () => fauxAssistantMessage(fauxToolCall("WebFetch", { v: "x" }), { stopReason: "toolUse" })),
				recordingStep(seen, () => fauxAssistantMessage("done")),
				// second prompt
				recordingStep(seen, () => fauxAssistantMessage(fauxToolCall("WebFetch", { v: "y" }), { stopReason: "toolUse" })),
				recordingStep(seen, () => fauxAssistantMessage("done2")),
			],
		});
		await t.session.prompt("go");

		// first LLM call: deferred tools absent, ToolSearch present, names listed in the system prompt
		expect(seen[0]!.tools).toContain("ToolSearch");
		for (const n of DEFERRED) expect(seen[0]!.tools).not.toContain(n);
		expect(seen[0]!.systemPrompt).toContain(DEFERRED_SECTION);
		for (const n of DEFERRED) expect(seen[0]!.systemPrompt).toContain(`\n${n}`);

		// ToolSearch result: <functions> block with the full definition
		const results = t.toolResults();
		expect(results[0]!.toolName).toBe("ToolSearch");
		expect(results[0]!.isError).toBe(false);
		const m = /^<functions>\n<function>(.*)<\/function>\n<\/functions>$/.exec(results[0]!.text);
		expect(m).not.toBeNull();
		const def = JSON.parse(m![1]!);
		expect(Object.keys(def)).toEqual(["description", "name", "parameters"]);
		expect(def.name).toBe("WebFetch");
		expect(def.description).toBe("Fetches content from a URL and processes it");
		expect(def.parameters.required).toEqual(["v"]);

		// next LLM call in the SAME run sees the loaded tool (others still hidden), and it executes
		expect(seen[1]!.tools).toContain("WebFetch");
		expect(seen[1]!.tools).not.toContain("NotebookEdit");
		expect(results[1]).toMatchObject({ toolName: "WebFetch", text: "WebFetch:x", isError: false });
		expect(events).toContainEqual({ type: "tools_activated", names: ["WebFetch"] });

		// next prompt: still loaded, no longer listed as deferred
		await t.session.prompt("again");
		expect(seen[3]!.tools).toContain("WebFetch");
		expect(seen[3]!.tools).not.toContain("NotebookEdit");
		expect(seen[3]!.systemPrompt).toContain(DEFERRED_SECTION);
		expect(seen[3]!.systemPrompt).not.toContain("\nWebFetch");
		expect(seen[3]!.systemPrompt).toContain("\nNotebookEdit");
		expect(t.toolResults()[2]).toMatchObject({ toolName: "WebFetch", text: "WebFetch:y", isError: false });
		t.dispose();
	});

	it("drops the system-prompt section once every deferred tool is loaded", async () => {
		const seen: Seen[] = [];
		const t = await createTestSession({
			claudeCode: { deferredTools: ["WebFetch", "NotebookEdit"] },
			extraExtensions: [extraTools],
			responses: [
				fauxAssistantMessage(fauxToolCall("ToolSearch", { query: "select:WebFetch,NotebookEdit,Nope" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("ok"),
				recordingStep(seen, () => fauxAssistantMessage("ok2")),
			],
		});
		await t.session.prompt("go");
		const r = t.toolResults()[0]!;
		// max_results omitted: default applied via prepareArguments, no validation error
		expect(r.isError).toBe(false);
		expect((r.text.match(/<function>/g) ?? []).length).toBe(2);
		await t.session.prompt("again");
		expect(seen[0]!.systemPrompt).not.toContain(DEFERRED_SECTION);
		expect(seen[0]!.tools).toEqual(expect.arrayContaining(["WebFetch", "NotebookEdit", "ToolSearch"]));
		t.dispose();
	});

	it("blocks direct calls to deferred tools that were not loaded", async () => {
		const t = await createTestSession({
			claudeCode: { deferredTools: DEFERRED },
			extraExtensions: [extraTools],
			responses: [fauxAssistantMessage(fauxToolCall("WebFetch", { v: "x" }), { stopReason: "toolUse" }), fauxAssistantMessage("ok")],
		});
		await t.session.prompt("go");
		const r = t.toolResults()[0]!;
		expect(r.isError).toBe(true);
		expect(r.text).toContain("InputValidationError");
		expect(r.text).toContain('select:WebFetch');
		t.dispose();
	});

	it("reports no matches with the list of deferred tools", async () => {
		const t = await createTestSession({
			claudeCode: { deferredTools: DEFERRED },
			extraExtensions: [extraTools],
			responses: [
				fauxAssistantMessage(fauxToolCall("ToolSearch", { query: "kubernetes", max_results: 5 }), { stopReason: "toolUse" }),
				fauxAssistantMessage("ok"),
			],
		});
		await t.session.prompt("go");
		const r = t.toolResults()[0]!;
		expect(r.isError).toBe(false);
		expect(r.text).toContain("No matching deferred tools found");
		for (const n of DEFERRED) expect(r.text).toContain(n);
		t.dispose();
	});

	it("hides deferred tools that are registered later (dynamically)", async () => {
		const seen: Seen[] = [];
		const t = await createTestSession({
			claudeCode: { deferredTools: ["LateTool"] },
			extraExtensions: [
				(pi) => {
					pi.registerTool({
						name: "Spawner",
						label: "Spawner",
						description: "registers LateTool",
						parameters: { type: "object", properties: {} } as any,
						async execute() {
							echoTool(pi, "LateTool", "A tool registered at runtime");
							return { content: [{ type: "text", text: "spawned" }], details: {} };
						},
					});
				},
			],
			responses: [
				fauxAssistantMessage(fauxToolCall("Spawner", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("ok"),
				recordingStep(seen, () => fauxAssistantMessage(fauxToolCall("ToolSearch", { query: "+late", max_results: 5 }), { stopReason: "toolUse" })),
				recordingStep(seen, () => fauxAssistantMessage("ok2")),
			],
		});
		await t.session.prompt("go");
		await t.session.prompt("again");
		expect(seen[0]!.tools).not.toContain("LateTool");
		expect(seen[0]!.systemPrompt).toContain("\nLateTool");
		expect(t.toolResults()[1]!.text).toContain('"name":"LateTool"');
		expect(seen[1]!.tools).toContain("LateTool");
		t.dispose();
	});

	it("restores loaded tools from the session when it is reopened", async () => {
		const cwd = tempDir();
		const sessionManager = SessionManager.inMemory(cwd);
		const open = async (responses: any[]) => {
			const faux = registerFauxProvider();
			faux.setResponses(responses);
			const authStorage = AuthStorage.inMemory();
			authStorage.setRuntimeApiKey(faux.getModel().provider, "test-key");
			const { session } = await createClaudeCodeSession({
				cwd,
				agentDir: tempDir("pi-cc-agentdir-"),
				model: faux.getModel(),
				authStorage,
				modelRegistry: ModelRegistry.inMemory(authStorage),
				sessionManager,
				settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } } as any),
				claudeCode: { deferredTools: DEFERRED },
				loader: { extensionFactories: [extraTools], noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true },
			});
			return { session, faux };
		};

		const a = await open([
			fauxAssistantMessage(fauxToolCall("ToolSearch", { query: "select:NotebookEdit", max_results: 5 }), { stopReason: "toolUse" }),
			fauxAssistantMessage("ok"),
		]);
		await a.session.prompt("go");
		a.session.dispose();
		a.faux.unregister();
		expect(sessionManager.getEntries().some((e: any) => e.type === "custom" && e.customType === "cc-tool-search")).toBe(true);

		const seen: Seen[] = [];
		const b = await open([recordingStep(seen, () => fauxAssistantMessage("ok"))]);
		await b.session.prompt("again");
		expect(seen[0]!.tools).toContain("NotebookEdit");
		expect(seen[0]!.tools).not.toContain("WebFetch");
		expect(seen[0]!.systemPrompt).not.toContain("\nNotebookEdit");
		b.session.dispose();
		b.faux.unregister();
	});

	for (const installWrapper of [false, true]) {
		it(`host-built session (createClaudeCodeExtension + createAgentSession), wrapper ${installWrapper ? "installed manually" : "not installed"}`, async () => {
			const cwd = tempDir();
			const agentDir = tempDir("pi-cc-agentdir-");
			const faux = registerFauxProvider();
			const seen: Seen[] = [];
			faux.setResponses([recordingStep(seen, () => fauxAssistantMessage("a")), recordingStep(seen, () => fauxAssistantMessage("b"))]);
			const authStorage = AuthStorage.inMemory();
			authStorage.setRuntimeApiKey(faux.getModel().provider, "test-key");
			const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } } as any);
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager,
				extensionFactories: [createClaudeCodeExtension({ deferredTools: ["WebFetch"] }), extraTools],
				noSkills: true,
				noContextFiles: true,
				noPromptTemplates: true,
				noThemes: true,
			});
			await resourceLoader.reload();
			const { session } = await createAgentSession({
				cwd,
				agentDir,
				model: faux.getModel(),
				authStorage,
				modelRegistry: ModelRegistry.inMemory(authStorage),
				sessionManager: SessionManager.inMemory(cwd),
				settingsManager,
				resourceLoader,
				noTools: "builtin",
			});
			if (installWrapper) session.agent.streamFn = wrapStreamFnForToolSearch(session.agent.streamFn);
			await session.prompt("go");
			await session.prompt("again");
			if (installWrapper) {
				expect(seen[0]!.tools).not.toContain("WebFetch");
			} else {
				expect(seen[0]!.tools).toContain("WebFetch"); // first call: not hidden yet
			}
			expect(seen[1]!.tools).not.toContain("WebFetch"); // fallback: deactivated via setActiveTools
			expect(seen[1]!.systemPrompt).toContain("\nWebFetch");
			session.dispose();
			faux.unregister();
		});
	}

	it("falls back to deactivating deferred tools when the host deactivates ToolSearch", async () => {
		const seen: Seen[] = [];
		const t = await createTestSession({
			claudeCode: { deferredTools: ["WebFetch"] },
			extraExtensions: [
				extraTools,
				// a host that removes ToolSearch from the active set: the wrapper cannot identify the session
				(pi) =>
					pi.on("before_agent_start", async () => {
						pi.setActiveTools(pi.getActiveTools().filter((n) => n !== "ToolSearch"));
					}),
			],
			responses: [recordingStep(seen, () => fauxAssistantMessage("a")), recordingStep(seen, () => fauxAssistantMessage("b"))],
		});
		await t.session.prompt("go");
		await t.session.prompt("again");
		expect(seen[0]!.tools).toContain("WebFetch"); // not hidden on the first call
		expect(seen[1]!.tools).not.toContain("WebFetch"); // deactivated via setActiveTools afterwards
		t.dispose();
	});
});

describe("pi runtime assumption", () => {
	it("pi does not refresh the tool list between turns of one run (why ToolSearch wraps streamFn)", async () => {
		const seen: Seen[] = [];
		const t = await createTestSession({
			extraExtensions: [
				(pi) => {
					echoTool(pi, "Hidden", "hidden");
					pi.on("before_agent_start", async () => {
						pi.setActiveTools(pi.getActiveTools().filter((n) => n !== "Hidden"));
					});
					pi.registerTool({
						name: "Enable",
						label: "Enable",
						description: "enables Hidden",
						parameters: { type: "object", properties: {} } as any,
						async execute() {
							pi.setActiveTools([...pi.getActiveTools(), "Hidden"]);
							return { content: [{ type: "text", text: "ok" }], details: {} };
						},
					});
				},
			],
			responses: [
				recordingStep(seen, () => fauxAssistantMessage(fauxToolCall("Enable", {}), { stopReason: "toolUse" })),
				recordingStep(seen, () => fauxAssistantMessage("done")),
			],
		});
		await t.session.prompt("go");
		expect(seen[0]!.tools).not.toContain("Hidden");
		// if this starts failing, pi refreshes tools mid-run and the streamFn wrapper could be dropped
		expect(seen[1]!.tools).not.toContain("Hidden");
		t.dispose();
	});
});

describe("searchTools", () => {
	const tools = [
		{ name: "WebFetch", description: "Fetches content from a URL" },
		{ name: "WebSearch", description: "Search the web" },
		{ name: "NotebookEdit", description: "Edit a Jupyter notebook cell" },
		{ name: "mcp__slack__send_message", description: "Send a message" },
		{ name: "mcp__slack__list_channels", description: "List channels" },
		{ name: "mcp__github__create_issue", description: "Create a GitHub issue and send a notification" },
	].map((t) => ({ ...t, parameters: {}, sourceInfo: {} as any }));
	const names = (q: string, n = 5) => searchTools(tools as any, q, n).map((t) => t.name);

	it("selects exact names", () => {
		expect(names("select:NotebookEdit, webfetch")).toEqual(["NotebookEdit", "WebFetch"]);
		expect(names("select:Missing")).toEqual([]);
	});
	it("ranks keyword matches", () => {
		expect(names("notebook jupyter")[0]).toBe("NotebookEdit");
		// name token + description word beats name token alone
		expect(names("web")).toEqual(["WebSearch", "WebFetch"]);
		expect(names("web", 1)).toEqual(["WebSearch"]);
	});
	it("requires +terms in the name", () => {
		expect(names("+slack send")).toEqual(["mcp__slack__send_message"]);
		expect(names("+slack")).toEqual(["mcp__slack__list_channels", "mcp__slack__send_message"]);
		expect(names("send")).toContain("mcp__github__create_issue");
		expect(names("+slack send")).not.toContain("mcp__github__create_issue");
	});
	it("matches a whole tool name", () => {
		expect(names("WebSearch")).toEqual(["WebSearch"]);
	});
});

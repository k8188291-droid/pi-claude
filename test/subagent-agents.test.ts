import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createTestModelRuntime } from "./helpers.js";
import { beforeAll, describe, expect, it } from "vitest";
import { agentAllowsTool, BUILT_IN_AGENTS, loadAgentDefinitions, parseAgentMarkdown, parseToolList, toolRuleMatches, toolsLabel } from "../src/subagent/agents.js";
import { formatAgentListingReminder } from "../src/subagent/agents.js";
import { foregroundResultText, frameHandback, validateAgentInput } from "../src/subagent/prompt.js";
import { resolveSubagentModel } from "../src/subagent/models.js";
import { tempDir } from "./helpers.js";

function writeAgent(dir: string, file: string, content: string) {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, file), content);
}

describe("agent definitions", () => {
	it("has the built-in agents", () => {
		expect(Object.keys(BUILT_IN_AGENTS).sort()).toEqual(["Explore", "Plan", "claude", "general-purpose"]);
		expect(BUILT_IN_AGENTS.claude.tools).toEqual(["*"]);
		expect(BUILT_IN_AGENTS["general-purpose"].tools).toEqual(["*"]);
		expect(BUILT_IN_AGENTS.Explore.tools).toBeUndefined();
		expect(BUILT_IN_AGENTS.Explore.disallowedTools).toEqual(expect.arrayContaining(["Agent", "Edit", "Write", "NotebookEdit"]));
		expect(BUILT_IN_AGENTS.Explore.prompt).toMatch(/READ-ONLY/);
		expect(BUILT_IN_AGENTS.Plan.disallowedTools).toContain("Edit");
	});

	it("parses markdown frontmatter (tools as string or list, model aliases, inherit)", () => {
		const a = parseAgentMarkdown(
			"---\nname: reviewer\ndescription: Reviews code\ntools: Read, Grep,  Glob\nmodel: haiku\n---\n\nYou review code.\n",
			"/x/reviewer.md",
			"project",
		)!;
		expect(a).toMatchObject({ name: "reviewer", description: "Reviews code", tools: ["Read", "Grep", "Glob"], model: "haiku", prompt: "You review code.", source: "project" });

		const b = parseAgentMarkdown("---\ndescription: d\ntools:\n  - Read\n  - Bash\nmodel: inherit\n---\nBody", "/x/fallback-name.md", "user")!;
		expect(b.name).toBe("fallback-name");
		expect(b.tools).toEqual(["Read", "Bash"]);
		expect(b.model).toBeUndefined();

		const c = parseAgentMarkdown("---\nname: all\ndescription: d\ntools: '*'\n---\nBody", "/x/all.md", "user")!;
		expect(c.tools).toBeUndefined();
	});

	it("applies precedence built-in < user < project < options.agents", () => {
		const home = tempDir("pi-cc-home-");
		const cwd = tempDir("pi-cc-proj-");
		writeAgent(join(home, ".claude", "agents"), "a.md", "---\nname: alpha\ndescription: user alpha\n---\nuser alpha prompt");
		writeAgent(join(home, ".claude", "agents"), "b.md", "---\nname: beta\ndescription: user beta\n---\nuser beta prompt");
		writeAgent(join(home, ".claude", "agents"), "explore.md", "---\nname: Explore\ndescription: user explore\n---\nuser explore");
		writeAgent(join(cwd, ".claude", "agents"), "b.md", "---\nname: beta\ndescription: project beta\n---\nproject beta prompt");
		writeAgent(join(cwd, ".claude", "agents"), "g.md", "---\nname: gamma\ndescription: project gamma\n---\nproject gamma");
		writeAgent(join(cwd, ".claude", "agents"), "notes.txt", "ignored");

		const defs = loadAgentDefinitions({
			cwd,
			homeDir: home,
			agents: { gamma: { description: "options gamma", prompt: "options gamma prompt", tools: ["Read"] } },
		});
		expect(defs.get("alpha")).toMatchObject({ description: "user alpha", source: "user" });
		expect(defs.get("beta")).toMatchObject({ description: "project beta", prompt: "project beta prompt", source: "project" });
		expect(defs.get("gamma")).toMatchObject({ description: "options gamma", tools: ["Read"], source: "options" });
		expect(defs.get("Explore")).toMatchObject({ description: "user explore", source: "user" });
		expect(defs.get("Plan")?.source).toBe("built-in");
		expect(defs.get("general-purpose")?.source).toBe("built-in");

		const noDisk = loadAgentDefinitions({ cwd, homeDir: home, loadAgentsFromDisk: false });
		expect([...noDisk.keys()].sort()).toEqual(["Explore", "Plan", "claude", "general-purpose"]);
	});

	it("parses disallowedTools, effort and background frontmatter", () => {
		const a = parseAgentMarkdown("---\nname: r\ndescription: d\ndisallowedTools: Write, Edit\neffort: high\nbackground: true\n---\nBody", "/x/r.md", "project")!;
		expect(a).toMatchObject({ disallowedTools: ["Write", "Edit"], effort: "high", background: true });
	});

	it("lists agent types like Claude Code's system reminder", () => {
		const defs = loadAgentDefinitions({
			cwd: tempDir(),
			homeDir: tempDir(),
			loadAgentsFromDisk: false,
			agents: { mine: { description: "My agent", prompt: "p" }, reader: { description: "Reads", prompt: "p", tools: ["Read", "Grep"] } },
		});
		const text = formatAgentListingReminder(defs);
		expect(text.startsWith("Available agent types for the Agent tool:\n- claude: Catch-all for any task that doesn't fit a more specific agent.")).toBe(true);
		expect(text).toContain("\n- Explore: Fast read-only search agent");
		expect(text).toContain("(Tools: All tools except Agent, Artifact, ArtifactComments, ArtifactData, ArtifactCheck, ExitPlanMode, Edit, Write, NotebookEdit)");
		expect(text).toContain("- general-purpose: General-purpose agent for researching complex questions");
		expect(text).toContain("- mine: My agent (Tools: All tools)");
		expect(text).toContain("- reader: Reads (Tools: Read, Grep)");
		// sorted case-insensitively
		const names = [...text.matchAll(/^- ([^:]+):/gm)].map((m) => m[1]);
		expect(names).toEqual(["claude", "Explore", "general-purpose", "mine", "Plan", "reader"]);
		expect(text.endsWith("send them in a single message with multiple tool uses so they run concurrently.")).toBe(true);
	});
});

describe("Agent tool texts", () => {
	it("frames foreground reports and appends agentId/usage except for Explore/Plan", () => {
		expect(frameHandback("a\nb")).toMatch(/The report follows:\n {2}a\n {2}b$/);
		const usage = { totalTokens: 120, toolUses: 1, durationMs: 5 };
		expect(foregroundResultText({ report: "done", agentId: "a1", agentType: "general-purpose", usage })).toMatch(
			/ {2}done\nagentId: a1\n<usage>subagent_tokens: 120\ntool_uses: 1\nduration_ms: 5<\/usage>$/,
		);
		expect(foregroundResultText({ report: "found", agentId: "a1", agentType: "Explore", usage })).toMatch(/The report follows:\n {2}found$/);
		expect(foregroundResultText({ report: "", agentId: "a1", agentType: "Plan", usage })).toContain("  (Subagent completed but returned no output.)");
		expect(foregroundResultText({ report: "x", agentId: "a1", agentType: "Plan", usage, worktree: { worktreePath: "/w", worktreeBranch: "b" } })).toContain(
			"agentId: a1\nworktreePath: /w\nworktreeBranch: b\n<usage>",
		);
	});

	it("reports input errors in Claude Code's InputValidationError wording", () => {
		expect(validateAgentInput({ description: "d", prompt: "p" })).toBeUndefined();
		expect(validateAgentInput({ description: "d", prompt: "p", name: "x", team_name: "t", mode: "m" })).toBeUndefined();
		expect(validateAgentInput({ description: "d" })).toBe("InputValidationError: Agent failed due to the following issue:\nThe required parameter `prompt` is missing");
		expect(validateAgentInput({ description: "d", prompt: 1 })).toBe(
			"InputValidationError: Agent failed due to the following issue:\nThe parameter `prompt` type is expected as `string` but provided as `number`",
		);
		const bad = validateAgentInput({ description: "d", prompt: "p", model: "gpt-5" })!;
		expect(bad.startsWith("InputValidationError: [")).toBe(true);
		expect(JSON.parse(bad.slice("InputValidationError: ".length))).toEqual([
			{ code: "invalid_value", values: ["sonnet", "opus", "haiku", "fable"], path: ["model"], message: 'Invalid option: expected one of "sonnet"|"opus"|"haiku"|"fable"' },
		]);
	});
});

describe("subagent model resolution", () => {
	let registry: ModelRegistry;
	beforeAll(async () => {
		registry = new ModelRegistry(await createTestModelRuntime("anthropic"));
	});
	const parent = getModel("anthropic", "claude-sonnet-4-5") as any;

	it("inherits the parent by default", () => {
		expect(resolveSubagentModel(undefined, registry, parent, { strict: true })).toEqual({ ok: true, model: parent });
		expect(resolveSubagentModel("inherit", registry, parent, { strict: true })).toEqual({ ok: true, model: parent });
	});

	it("maps aliases to an available model of the same family", () => {
		const r = resolveSubagentModel("haiku", registry, parent, { strict: true });
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.model?.provider).toBe("anthropic");
			expect(r.model?.id).toContain("haiku");
		}
		// parent already matches the alias
		const s = resolveSubagentModel("sonnet", registry, parent, { strict: true });
		expect(s.ok && s.model).toBe(parent);
	});

	it("falls back to the parent for unresolvable aliases", () => {
		const fauxParent = { provider: "faux", id: "faux-1" } as any;
		const r = resolveSubagentModel("opus", { getAll: () => [], getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => false } as any, fauxParent, { strict: true });
		expect(r).toMatchObject({ ok: true, model: fauxParent });
		expect((r as any).note).toMatch(/alias/);
	});

	it("resolves full ids and provider/id; unknown ids error (strict) or fall back (definitions)", () => {
		const a = resolveSubagentModel("anthropic/claude-haiku-4-5", registry, parent, { strict: true });
		expect(a.ok && a.model?.id).toBe("claude-haiku-4-5");
		const b = resolveSubagentModel("claude-haiku-4-5", registry, parent, { strict: true });
		expect(b.ok && b.model?.id).toBe("claude-haiku-4-5");
		const c = resolveSubagentModel("no-such-model", registry, parent, { strict: true });
		expect(c.ok).toBe(false);
		const d = resolveSubagentModel("no-such-model", registry, parent, { strict: false });
		expect(d).toMatchObject({ ok: true, model: parent });
	});
});

describe("agent tool restrictions (review 2026-10-18 #2b/#2c/#2d)", () => {
	const md = (fm: string) => parseAgentMarkdown(`---\nname: x\ndescription: d\n${fm}\n---\nBody`, "/x/x.md", "project")!;

	it("#2b: an empty tools value means no tools; absent or '*' means all (like Claude Code)", () => {
		expect(parseToolList(undefined)).toBeUndefined();
		expect(parseToolList([])).toEqual([]);
		expect(parseToolList("")).toEqual([]);
		expect(parseToolList(null)).toEqual([]);
		expect(parseToolList(["Read", "*"])).toBeUndefined();
		expect(md("tools: []").tools).toEqual([]);
		expect(md("tools:").tools).toEqual([]);
		expect(md("model: haiku").tools).toBeUndefined();
		expect(agentAllowsTool(md("tools: []"), "Read")).toBe(false);
		expect(agentAllowsTool(md("model: haiku"), "Read")).toBe(true);

		const defs = loadAgentDefinitions({ cwd: tempDir(), homeDir: tempDir(), agents: { empty: { description: "d", prompt: "p", tools: [] }, all: { description: "d", prompt: "p" } } });
		expect(defs.get("empty")!.tools).toEqual([]);
		expect(defs.get("all")!.tools).toBeUndefined();
		expect(agentAllowsTool(defs.get("empty")!, "Read")).toBe(false);
		expect(toolsLabel(defs.get("empty")!)).toBe("All tools"); // Claude Code's label for an empty list
	});

	it("#2d: mcp__server / mcp__server__* / mcp__* rules match MCP tools like Claude Code", () => {
		expect(toolRuleMatches("mcp__prod", "mcp__prod__danger", "deny")).toBe(true);
		expect(toolRuleMatches("mcp__prod__*", "mcp__prod__danger", "deny")).toBe(true);
		expect(toolRuleMatches("mcp__*", "mcp__prod__danger", "deny")).toBe(true);
		expect(toolRuleMatches("mcp__prod", "mcp__production__x", "deny")).toBe(false);
		expect(toolRuleMatches("mcp__prod__other", "mcp__prod__danger", "deny")).toBe(false);
		expect(toolRuleMatches("mcp__*", "Read", "deny")).toBe(false);
		expect(toolRuleMatches("mcp__prod", "mcp__prod__danger", "allow")).toBe(true);
		expect(toolRuleMatches("mcp__prod__*", "mcp__prod__danger", "allow")).toBe(true);
		expect(toolRuleMatches("ToolSearch", "tool_search", "allow")).toBe(true);

		const deny = md("disallowedTools: mcp__prod");
		expect(agentAllowsTool(deny, "mcp__prod__danger")).toBe(false);
		expect(agentAllowsTool(deny, "mcp__other__x")).toBe(true);
		expect(agentAllowsTool(deny, "Read")).toBe(true);
		const allow = md("tools: Read, mcp__prod__*");
		expect(agentAllowsTool(allow, "mcp__prod__danger")).toBe(true);
		expect(agentAllowsTool(allow, "mcp__other__x")).toBe(false);
		expect(agentAllowsTool(allow, "Bash")).toBe(false);
	});

	it('#2c: disallowedTools "*" is ignored by default and removes every tool with the quirk fixed', () => {
		const a = md('disallowedTools: "*"');
		expect(a.disallowedTools).toBeUndefined();
		expect(a.disallowAll).toBe(true);
		expect(agentAllowsTool(a, "Read")).toBe(true);
		expect(toolsLabel(a)).toBe("All tools");
		expect(agentAllowsTool(a, "Read", { disallowAll: true })).toBe(false);
		expect(toolsLabel(a, { disallowAll: true })).toBe("None");
		// definitions without the wildcard are unaffected by the quirk
		const b = md("disallowedTools: Write");
		expect(b.disallowAll).toBeUndefined();
		expect(agentAllowsTool(b, "Read", { disallowAll: true })).toBe(true);
		// Agent SDK-style options definitions may carry disallowedTools too
		const defs = loadAgentDefinitions({ cwd: tempDir(), homeDir: tempDir(), agents: { o: { description: "d", prompt: "p", disallowedTools: ["*"] } as any, w: { description: "d", prompt: "p", disallowedTools: ["Write"] } as any } });
		expect(defs.get("o")!.disallowAll).toBe(true);
		expect(agentAllowsTool(defs.get("w")!, "Write")).toBe(false);
		expect(toolsLabel(defs.get("w")!)).toBe("All tools except Write");
	});
});

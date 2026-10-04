import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getModel } from "@mariozechner/pi-ai";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { BUILT_IN_AGENTS, loadAgentDefinitions, parseAgentMarkdown } from "../src/subagent/agents.js";
import { buildTaskDescription } from "../src/subagent/index.js";
import { resolveSubagentModel } from "../src/subagent/models.js";
import { tempDir } from "./helpers.js";

function writeAgent(dir: string, file: string, content: string) {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, file), content);
}

describe("agent definitions", () => {
	it("has the built-in agents", () => {
		expect(Object.keys(BUILT_IN_AGENTS).sort()).toEqual(["Explore", "Plan", "general-purpose"]);
		expect(BUILT_IN_AGENTS["general-purpose"].tools).toBeUndefined();
		expect(BUILT_IN_AGENTS.Explore.tools).toEqual(expect.arrayContaining(["Read", "Grep", "Glob", "Bash"]));
		expect(BUILT_IN_AGENTS.Explore.tools).not.toContain("Write");
		expect(BUILT_IN_AGENTS.Explore.prompt).toMatch(/READ-ONLY/);
		expect(BUILT_IN_AGENTS.Plan.tools).not.toContain("Edit");
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
		expect([...noDisk.keys()].sort()).toEqual(["Explore", "Plan", "general-purpose"]);
	});

	it("lists agent types in the Task description, filtering unknown tools", () => {
		const defs = loadAgentDefinitions({ cwd: tempDir(), homeDir: tempDir(), loadAgentsFromDisk: false, agents: { mine: { description: "My agent", prompt: "p" } } });
		const desc = buildTaskDescription(defs, new Set(["Read", "Grep", "Glob", "Bash", "Write"]));
		expect(desc).toContain("- general-purpose: General-purpose agent");
		expect(desc).toContain("- Explore: Fast agent specialized for exploring codebases");
		expect(desc).toContain("(Tools: Read, Grep, Glob, Bash)");
		expect(desc).toContain("- mine: My agent (Tools: *)");
		expect(desc).not.toContain("WebFetch");
	});
});

describe("subagent model resolution", () => {
	const auth = AuthStorage.inMemory();
	auth.setRuntimeApiKey("anthropic", "test");
	const registry = ModelRegistry.inMemory(auth);
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
		const emptyAuth = AuthStorage.inMemory();
		const reg = ModelRegistry.inMemory(emptyAuth);
		const fauxParent = { provider: "faux", id: "faux-1" } as any;
		const r = resolveSubagentModel("opus", { ...reg, getAll: () => [], hasConfiguredAuth: () => false } as any, fauxParent, { strict: true });
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

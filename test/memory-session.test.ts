import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryClaudeCodeSession, createMemoryModelRuntime, type MemoryClaudeCodeSession } from "../src/memory/index.js";
import { outsidePackages, recordHostFs } from "./fs-spy.js";
import { withLegacyContext } from "./helpers.js";

type Faux = ReturnType<typeof registerFauxProvider>;

async function fauxRuntime(responses: FauxResponseStep[]): Promise<{ faux: Faux; modelRuntime: ModelRuntime }> {
	const faux = withLegacyContext(registerFauxProvider());
	faux.setResponses(responses);
	const modelRuntime = await createMemoryModelRuntime();
	const model = faux.getModel();
	modelRuntime.registerProvider(model.provider, {
		name: "Faux",
		api: faux.api as never,
		baseUrl: model.baseUrl || "http://faux.invalid",
		apiKey: "test-key",
		models: faux.models.map((m) => ({ id: m.id, name: m.name, reasoning: m.reasoning, input: m.input, cost: m.cost, contextWindow: m.contextWindow, maxTokens: m.maxTokens })) as never,
	});
	return { faux, modelRuntime };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()!();
});

async function start(responses: FauxResponseStep[], opts: Parameters<typeof createMemoryClaudeCodeSession>[0] = {}): Promise<MemoryClaudeCodeSession & { faux: Faux }> {
	const { faux, modelRuntime } = await fauxRuntime(responses);
	const s = await createMemoryClaudeCodeSession({ model: faux.getModel(), modelRuntime, settings: { compaction: { enabled: false } } as never, ...opts });
	cleanups.push(() => {
		s.session.dispose();
		faux.unregister();
	});
	return Object.assign(s, { faux });
}

const toolResults = (s: MemoryClaudeCodeSession) =>
	s.session.messages
		.filter((m) => (m as { role: string }).role === "toolResult")
		.map((m) => {
			const r = m as unknown as { toolName: string; isError: boolean; content: Array<{ type: string; text?: string }> };
			return { toolName: r.toolName, isError: r.isError, text: r.content.map((c) => c.text ?? "").join("") };
		});

describe("createMemoryClaudeCodeSession", () => {
	it("installs the Claude Code tools (pi's built-ins off) and reads AGENTS.md and skills from the VFS", async () => {
		let seenTools: string[] = [];
		let systemPrompt = "";
		const s = await start(
			[
				(ctx: any) => {
					seenTools = (ctx.tools ?? []).map((t: { name: string }) => t.name);
					systemPrompt = ctx.systemPrompt ?? "";
					return fauxAssistantMessage(fauxText("hi"));
				},
			],
			{
				snapshot: {
					version: 1,
					cwd: "/workspace",
					files: {
						"/workspace/AGENTS.md": "MEMORY_AGENTS_MARKER\n",
						"/workspace/.pi/skills/check-memory/SKILL.md": "---\nname: check-memory\ndescription: Verify memory tools\n---\nBODY\n",
						"/workspace/.pi/extensions/evil.ts": "throw new Error('must never load')\n",
					},
				},
			},
		);
		await s.session.prompt("hello");
		for (const name of ["Read", "Write", "Edit", "Bash", "Grep", "Glob"]) expect(seenTools).toContain(name);
		for (const name of ["read", "write", "edit", "bash"]) expect(seenTools).not.toContain(name);
		expect(seenTools).not.toContain("Agent");
		expect(systemPrompt).toMatch(/MEMORY_AGENTS_MARKER/);
		// loaded from the VFS; pi 1.x lists skills in the system prompt only when a tool named
		// "read" or "bash" is active, which the Claude Code tools (Read, Bash) are not
		expect(s.resourceLoader.getSkills().skills.map((k) => k.name)).toEqual(["check-memory"]);
		expect(s.extensionsResult.extensions.every((e) => e.path.startsWith("<inline:"))).toBe(true);
		expect(s.extensionsResult.errors).toEqual([]);
		expect(s.host.supportsWorktrees).toBe(false);
		expect(s.cwd).toBe("/workspace");
		// the virtual cwd does not exist on the host
		expect(existsSync("/workspace/AGENTS.md")).toBe(false);
	});

	it("runs a complete agent turn with a tool that needs no filesystem, and snapshots the session", async () => {
		const s = await start([
			fauxAssistantMessage(fauxToolCall("TaskCreate", { subject: "Check memory", description: "verify the sandbox" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await s.session.prompt("make a task");
		expect(toolResults(s)).toEqual([{ toolName: "TaskCreate", isError: false, text: expect.stringContaining("created successfully") }]);
		await s.host.fs.writeFile("/workspace/note.txt", "kept\n");
		const snapshot = JSON.parse(JSON.stringify(await s.snapshot()));
		expect(snapshot.files["/workspace/note.txt"].data).toBe("kept\n");
		expect(snapshot.session.entries.length).toBeGreaterThan(2);
		expect(JSON.stringify(snapshot)).not.toMatch(/test-key/);

		// a new session from the snapshot continues the same conversation
		let seenMessages: unknown[] = [];
		const resumed = await start(
			[
				(ctx: any) => {
					seenMessages = ctx.messages;
					return fauxAssistantMessage("again");
				},
			],
			{ snapshot },
		);
		expect(resumed.sessionManager.getSessionId()).toBe(snapshot.session.header.id);
		expect(new TextDecoder().decode(await resumed.host.fs.readFile("/workspace/note.txt"))).toBe("kept\n");
		await resumed.session.prompt("continue");
		expect(JSON.stringify(seenMessages)).toMatch(/make a task/);
	});

	it("uses a caller-supplied host and cwd", async () => {
		const { createMemoryHost } = await import("../src/memory/index.js");
		const host = await createMemoryHost({ cwd: "/repo" });
		const s = await start([fauxAssistantMessage("ok")], { host, cwd: "/repo/pkg" });
		expect(s.host).toBe(host);
		expect(s.cwd).toBe("/repo/pkg");
		expect((await host.fs.stat("/repo/pkg")).isDirectory).toBe(true);
	});

	it("touches no host file outside the installed packages (fs calls recorded during session, turn and snapshot)", async () => {
		const { faux, modelRuntime } = await fauxRuntime([
			fauxAssistantMessage(fauxToolCall("TaskCreate", { subject: "s", description: "d" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const touched = await recordHostFs(async () => {
			const s = await createMemoryClaudeCodeSession({
				model: faux.getModel(),
				modelRuntime,
				snapshot: { version: 1, cwd: "/workspace", files: { "/workspace/AGENTS.md": "x\n", "/agent/skills/s/SKILL.md": "---\ndescription: d\n---\n" } },
			});
			cleanups.push(() => {
				s.session.dispose();
				faux.unregister();
			});
			await s.session.prompt("go");
			await s.snapshot();
		});
		// pi-ai's default auth context probes ambient provider credentials (google-vertex ADC); pi's
		// ModelRuntime offers no way to replace that context
		const adc = [process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "", join(homedir(), ".config", "gcloud", "application_default_credentials.json")];
		expect(outsidePackages(touched, adc)).toEqual([]);
	});

	// Depends on the tool rewiring (every tool reaching fs/shell/search through
	// ClaudeCodeToolsOptions.host). Before it, Write/Read/Bash/Grep/Glob still use the real disk,
	// so this would write to the host's /workspace: keep it skipped until that change is merged.
	it.skip("[needs host rewiring] Write, Read, Edit, Bash, Grep and Glob all run on the in-memory filesystem", async () => {
		const s = await start([
			fauxAssistantMessage(fauxToolCall("Write", { file_path: "/workspace/src/a.ts", content: "export const foo = 1;\n" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("Read", { file_path: "/workspace/src/a.ts" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("Edit", { file_path: "/workspace/src/a.ts", old_string: "foo = 1", new_string: "foo = 2" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("Bash", { command: "cat src/a.ts && echo made > src/b.txt" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("Grep", { pattern: "foo", output_mode: "content" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("Glob", { pattern: "**/*" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await s.session.prompt("go");
		const results = toolResults(s);
		expect(results.map((r) => [r.toolName, r.isError])).toEqual([
			["Write", false],
			["Read", false],
			["Edit", false],
			["Bash", false],
			["Grep", false],
			["Glob", false],
		]);
		expect(results[3].text).toContain("export const foo = 2;");
		expect(results[4].text).toContain("src/a.ts");
		expect(results[5].text).toContain("src/b.txt");
		expect(new TextDecoder().decode(await s.host.fs.readFile("/workspace/src/a.ts"))).toBe("export const foo = 2;\n");
		expect(existsSync("/workspace/src/a.ts")).toBe(false);
	});
});

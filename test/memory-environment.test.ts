import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { InMemoryFs } from "just-bash";
import { describe, expect, it } from "vitest";
import {
	createMemoryHost,
	createSnapshotSessionManager,
	loadSnapshot,
	MemoryResourceLoader,
	type MemorySnapshot,
	parseSnapshot,
	serializeSnapshot,
} from "../src/memory/index.js";

async function write(vfs: InMemoryFs, path: string, content: string | Uint8Array) {
	await vfs.mkdir(path.slice(0, path.lastIndexOf("/")) || "/", { recursive: true });
	await vfs.writeFile(path, content);
}

describe("MemoryResourceLoader", () => {
	it("loads AGENTS.md, skills and prompt templates from the virtual filesystem", async () => {
		const vfs = new InMemoryFs();
		await write(vfs, "/agent/AGENTS.md", "GLOBAL_MARKER\n");
		await write(vfs, "/AGENTS.md", "ROOT_MARKER\n");
		await write(vfs, "/workspace/AGENTS.md", "﻿MEMORY_AGENTS_MARKER\n");
		await write(vfs, "/workspace/CLAUDE.md", "not used: AGENTS.md wins in the same directory\n");
		await write(vfs, "/workspace/.pi/skills/check-memory/SKILL.md", "---\nname: check-memory\ndescription: Verify the memory workspace\n---\nBODY\n");
		await write(vfs, "/workspace/.pi/skills/check-memory/nested/SKILL.md", "---\nname: nested\ndescription: inside another skill\n---\n");
		await write(vfs, "/agent/skills/plain.md", "---\ndescription: A root-level skill file\n---\n");
		await write(vfs, "/agent/skills/no-description/SKILL.md", "---\nname: x\n---\n");
		await write(vfs, "/workspace/.agents/skills/dir-name/SKILL.md", "---\ndescription: Named after its directory\ndisable-model-invocation: true\n---\n");
		await write(vfs, "/workspace/.pi/prompts/review.md", "---\ndescription: Review memory files\nargument-hint: <path>\n---\nReview $ARGUMENTS\n");
		await write(vfs, "/agent/prompts/sub/deep.md", "Deep prompt\n");
		const loader = new MemoryResourceLoader({ vfs });
		await loader.reload();

		expect(loader.getAgentsFiles().agentsFiles).toEqual([
			{ path: "/agent/AGENTS.md", content: "GLOBAL_MARKER\n" },
			{ path: "/AGENTS.md", content: "ROOT_MARKER\n" },
			{ path: "/workspace/AGENTS.md", content: "MEMORY_AGENTS_MARKER\n" },
		]);
		const skills = loader.getSkills().skills;
		expect(skills.map((s) => s.name).sort()).toEqual(["check-memory", "dir-name", "plain"]);
		expect(skills.find((s) => s.name === "check-memory")).toMatchObject({
			filePath: "/workspace/.pi/skills/check-memory/SKILL.md",
			baseDir: "/workspace/.pi/skills/check-memory",
			sourceInfo: { source: "memory", scope: "project" },
		});
		expect(skills.find((s) => s.name === "plain")?.sourceInfo.scope).toBe("user");
		expect(skills.find((s) => s.name === "dir-name")?.disableModelInvocation).toBe(true);
		expect(loader.getSkills().diagnostics.map((d) => d.path)).toEqual(["/agent/skills/no-description/SKILL.md"]);
		const prompts = loader.getPrompts().prompts;
		expect(prompts.map((p) => p.name).sort()).toEqual(["deep", "review"]);
		expect(prompts.find((p) => p.name === "review")).toMatchObject({ description: "Review memory files", argumentHint: "<path>", content: "Review $ARGUMENTS" });
		expect(loader.getThemes().themes).toEqual([]);
	});

	it("extensions are only the in-process factories; extension files in the VFS are never loaded", async () => {
		const vfs = new InMemoryFs();
		await write(vfs, "/workspace/.pi/extensions/evil.ts", "throw new Error('loaded')\n");
		await write(vfs, "/agent/extensions/evil.js", "throw new Error('loaded')\n");
		const registered: string[] = [];
		const loader = new MemoryResourceLoader({
			vfs,
			extensionFactories: [
				(pi) => {
					registered.push("factory ran");
					pi.registerCommand("hello", { description: "hi", handler: async () => {} });
				},
				() => {
					throw new Error("broken factory");
				},
			],
		});
		const empty = new MemoryResourceLoader({ vfs });
		await empty.reload();
		expect(empty.getExtensions().extensions).toEqual([]);
		await loader.reload();
		const result = loader.getExtensions();
		expect(registered).toEqual(["factory ran"]);
		expect(result.extensions.map((e) => e.path)).toEqual(["<inline:1>"]);
		expect(result.errors).toEqual([{ path: "<inline:2>", error: "broken factory" }]);
	});

	it("extendResources adds skill and prompt roots; options set the system prompt", async () => {
		const vfs = new InMemoryFs();
		await write(vfs, "/extra/skills/x/SKILL.md", "---\ndescription: extra\n---\n");
		const loader = new MemoryResourceLoader({ vfs, systemPrompt: "SYS", appendSystemPrompt: ["APPEND"], noContextFiles: true });
		await write(vfs, "/workspace/AGENTS.md", "ignored\n");
		loader.extendResources({ skillPaths: [{ path: "/extra/skills", metadata: {} as never }] });
		await loader.reload();
		expect(loader.getSkills().skills.map((s) => s.name)).toEqual(["x"]);
		expect(loader.getSystemPrompt()).toBe("SYS");
		expect(loader.getAppendSystemPrompt()).toEqual(["APPEND"]);
		expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
	});
});

describe("snapshots", () => {
	it("round-trip text, binary, symlinks, modes and mtimes; runtime roots are left out", async () => {
		const host = await createMemoryHost();
		const { vfs } = host;
		await host.fs.writeFile("/workspace/text.txt", "hello");
		await host.fs.writeFile("/workspace/data.bin", new Uint8Array([0, 1, 2, 255]));
		await host.fs.writeFile("/workspace/bad-utf8.bin", new Uint8Array([0xc3, 0x28]));
		await host.fs.writeFile("/workspace/run.sh", "#!/bin/sh\n", { mode: 0o755 });
		await host.fs.mkdir("/workspace/empty/dir", { recursive: true, mode: 0o700 });
		await vfs.symlink("text.txt", "/workspace/link.txt");
		await vfs.utimes("/workspace/text.txt", new Date(1_700_000_000_000), new Date(1_700_000_000_000));

		const snapshot = JSON.parse(JSON.stringify(await serializeSnapshot(vfs, { cwd: "/workspace" }))) as MemorySnapshot;
		expect(Object.keys(snapshot.files).filter((p) => /^\/(bin|usr|proc|dev)\//.test(p))).toEqual([]);
		expect(snapshot.files["/workspace/text.txt"]).toMatchObject({ encoding: "utf8", data: "hello", mtimeMs: 1_700_000_000_000 });
		expect(snapshot.files["/workspace/data.bin"]).toMatchObject({ encoding: "base64" });
		expect(snapshot.files["/workspace/bad-utf8.bin"]).toMatchObject({ encoding: "base64" });

		const restored = new InMemoryFs();
		const loaded = await loadSnapshot(restored, snapshot);
		expect(loaded).toEqual({ cwd: "/workspace", session: undefined });
		expect(await restored.readFile("/workspace/text.txt")).toBe("hello");
		expect([...(await restored.readFileBuffer("/workspace/data.bin"))]).toEqual([0, 1, 2, 255]);
		expect([...(await restored.readFileBuffer("/workspace/bad-utf8.bin"))]).toEqual([0xc3, 0x28]);
		expect(await restored.readlink("/workspace/link.txt")).toBe("text.txt");
		expect((await restored.stat("/workspace/run.sh")).mode & 0o777).toBe(0o755);
		expect((await restored.stat("/workspace/empty/dir")).mode & 0o777).toBe(0o700);
		expect((await restored.stat("/workspace/text.txt")).mtime.getTime()).toBe(1_700_000_000_000);
		const again = await serializeSnapshot(restored, { cwd: "/workspace" });
		expect(again.files).toEqual(snapshot.files);
		expect(again.symlinks).toEqual(snapshot.symlinks);
	});

	it("loads memory-pi-agent snapshots (plain-string files and directories); ignores and never writes OAuth credentials", async () => {
		const legacy = JSON.stringify({
			version: 1,
			cwd: "/workspace",
			oauth: { access: "secret-access", refresh: "secret-refresh", expires: 1, accountId: "a" },
			directories: ["/workspace/empty"],
			files: { "/workspace/AGENTS.md": "Always verify.\n", "/workspace/img.png": { encoding: "base64", data: "iVBORw0KGgo=", mode: 420 } },
			symlinks: { "/workspace/l": "AGENTS.md" },
		});
		const vfs = new InMemoryFs();
		await loadSnapshot(vfs, legacy);
		expect(await vfs.readFile("/workspace/AGENTS.md")).toBe("Always verify.\n");
		expect((await vfs.stat("/workspace/empty")).isDirectory).toBe(true);
		expect(await vfs.readlink("/workspace/l")).toBe("AGENTS.md");
		const saved = JSON.stringify(await serializeSnapshot(vfs));
		expect(saved).not.toMatch(/secret-access|secret-refresh|"oauth"/);
		expect(() => parseSnapshot({ ...JSON.parse(legacy), version: 2 })).toThrow(/Unsupported snapshot version/);
	});

	it("saves and restores the complete pi session tree", async () => {
		const original = SessionManager.inMemory("/workspace", { id: "saved-session" });
		original.appendModelChange("bedrock", "some-model");
		original.appendThinkingLevelChange("medium");
		const userEntryId = original.appendMessage({ role: "user", content: [{ type: "text", text: "remember this" }], timestamp: Date.now() });
		original.appendMessage(fauxAssistantMessage("I will remember this"));
		original.branch(userEntryId);
		original.appendMessage(fauxAssistantMessage("alternate branch"));
		const jsonEntries = JSON.parse(JSON.stringify(original.getEntries()));
		const originalLeafId = original.getLeafId();

		const vfs = new InMemoryFs();
		await write(vfs, "/workspace/visible.txt", "x");
		const snapshot = JSON.parse(JSON.stringify(await serializeSnapshot(vfs, { cwd: "/workspace", sessionManager: original })));
		expect(snapshot.session.header.id).toBe("saved-session");
		expect(snapshot.session.entries).toEqual(jsonEntries);
		expect(snapshot.session.leafId).toBe(originalLeafId);
		expect(JSON.stringify(snapshot.files)).not.toMatch(/remember this/);

		const loaded = await loadSnapshot(new InMemoryFs(), snapshot);
		const restored = createSnapshotSessionManager(loaded.cwd, loaded.session);
		expect(restored.getSessionId()).toBe("saved-session");
		expect(restored.getEntries()).toEqual(jsonEntries);
		expect(restored.getLeafId()).toBe(originalLeafId);
		expect(restored.getChildren(userEntryId)).toHaveLength(2);
		expect(restored.buildSessionContext().messages.map((m) => (m as { content: unknown }).content)).toEqual([
			[{ type: "text", text: "remember this" }],
			[{ type: "text", text: "alternate branch" }],
		]);
		restored.appendMessage({ role: "user", content: [{ type: "text", text: "continued" }], timestamp: Date.now() });
		expect(restored.getLeafEntry()?.parentId).toBe(originalLeafId);

		// leafId null: positioned before the first entry
		const reset = createSnapshotSessionManager("/workspace", { ...loaded.session!, leafId: null });
		expect(reset.getLeafId()).toBeNull();
	});

	it("rejects malformed sessions", async () => {
		const base = { version: 1, cwd: "/w", files: {} };
		await expect(loadSnapshot(new InMemoryFs(), { ...base, session: { header: { type: "nope" }, entries: [] } } as never)).rejects.toThrow(/session header/);
		await expect(loadSnapshot(new InMemoryFs(), { ...base, session: { header: { type: "session", id: "x" }, entries: {} } } as never)).rejects.toThrow(/entries must be an array/);
	});
});

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalHost } from "../src/host/local.js";
import type { ClaudeCodeHost, HostFileSystem } from "../src/host/types.js";
import type { ResourceLoaderOptions } from "../src/shared/types.js";
import { createCCContext } from "../src/shared/context.js";
import { subagentInternals } from "../src/subagent/index.js";
import { WORKTREE_UNSUPPORTED } from "../src/subagent/worktree.js";
import { registerBash } from "../src/tools/bash.js";
import { registerEdit } from "../src/tools/edit.js";
import { registerGlob } from "../src/tools/glob.js";
import { registerGrep } from "../src/tools/grep.js";
import { registerRead } from "../src/tools/read.js";
import { registerWrite } from "../src/tools/write.js";
import { captureTools, createTestSession, fauxAssistantMessage, fauxToolCall, fakeCtx, resultText, tempDir, type TestSession } from "./helpers.js";

// The proof that routing through the host is complete: a wrapped local host records every
// filesystem, shell and search call, and each tool's work shows up in it. (test/host-boundary.test.ts
// proves the other half: nothing under src/ but the local host can reach the machine directly.)

interface Call {
	api: string;
	/** First argument: a path, a command string or rg's argument vector. */
	arg: unknown;
}

function recordingHost(base: ClaudeCodeHost = createLocalHost()): { host: ClaudeCodeHost; calls: Call[]; since(n: number): Call[] } {
	const calls: Call[] = [];
	const fs = {} as Record<string, unknown>;
	for (const [name, fn] of Object.entries(base.fs)) {
		fs[name] = (...args: unknown[]) => {
			calls.push({ api: `fs.${name}`, arg: args[0] });
			return (fn as (...a: unknown[]) => unknown).apply(base.fs, args);
		};
	}
	// keeps the base's tmpDir/homeDir/env getters
	const host: ClaudeCodeHost = Object.assign(Object.create(base) as ClaudeCodeHost, {
		fs: fs as unknown as HostFileSystem,
		shell: {
			spawn(command: string, options: Parameters<ClaudeCodeHost["shell"]["spawn"]>[1]) {
				calls.push({ api: "shell.spawn", arg: command });
				return base.shell.spawn(command, options);
			},
		},
		search: {
			ripgrep(args: string[], options: Parameters<ClaudeCodeHost["search"]["ripgrep"]>[1]) {
				calls.push({ api: "search.ripgrep", arg: args });
				return base.search.ripgrep(args, options);
			},
			glob(pattern: string, options: Parameters<ClaudeCodeHost["search"]["glob"]>[1]) {
				calls.push({ api: "search.glob", arg: pattern });
				return base.search.glob(pattern, options);
			},
		},
	});
	return { host, calls, since: (n) => calls.slice(n) };
}

const apis = (calls: Call[]) => new Set(calls.map((c) => c.api));
const touched = (calls: Call[], path: string) => calls.some((c) => c.arg === path);

describe("tools go through the host", () => {
	it("Read, Write, Edit, Grep, Glob and Bash all use the host's filesystem, search and shell", async () => {
		const { host, calls, since } = recordingHost();
		const cwd = realpathSync(tempDir("pi-cc-host-routing-"));
		const { tools } = captureTools((pi: ExtensionAPI) => {
			const cc = createCCContext({ host });
			expect(cc.host).toBe(host);
			registerRead(pi, cc);
			registerWrite(pi, cc);
			registerEdit(pi, cc);
			registerGrep(pi, cc);
			registerGlob(pi, cc);
			registerBash(pi, cc);
		});
		const run = async (name: string, params: Record<string, unknown>) =>
			resultText((await tools.get(name)!.execute("id", params as any, undefined, undefined, fakeCtx(cwd))) as any);
		const file = join(cwd, "notes.txt");

		let n = calls.length;
		expect(await run("Write", { file_path: file, content: "alpha needle\n" })).toContain("File created successfully");
		expect([...apis(since(n))]).toEqual(expect.arrayContaining(["fs.stat", "fs.writeFile"]));
		expect(touched(since(n), file)).toBe(true);
		expect(readFileSync(file, "utf8")).toBe("alpha needle\n");

		n = calls.length;
		expect(await run("Read", { file_path: file })).toBe("1\talpha needle\n2\t");
		expect([...apis(since(n))]).toEqual(expect.arrayContaining(["fs.stat", "fs.readFile"]));
		expect(touched(since(n), file)).toBe(true);

		n = calls.length;
		expect(await run("Edit", { file_path: file, old_string: "alpha", new_string: "beta" })).toContain("has been updated successfully");
		expect([...apis(since(n))]).toEqual(expect.arrayContaining(["fs.stat", "fs.readFile", "fs.writeFile"]));
		expect(readFileSync(file, "utf8")).toBe("beta needle\n");

		n = calls.length;
		expect(await run("Grep", { pattern: "needle" })).toBe("Found 1 file\nnotes.txt");
		const rg = since(n).filter((c) => c.api === "search.ripgrep");
		expect(rg).toHaveLength(1);
		expect(rg[0].arg).toContain("needle");

		n = calls.length;
		expect(await run("Glob", { pattern: "*.txt" })).toBe("notes.txt");
		const files = since(n).filter((c) => c.api === "search.ripgrep");
		expect(files).toHaveLength(1);
		expect(files[0].arg).toEqual(expect.arrayContaining(["--files", "--glob", "*.txt"]));

		n = calls.length;
		mkdirSync(join(cwd, "sub"));
		expect(await run("Bash", { command: "cd sub && echo from-shell" })).toContain("from-shell");
		const bash = since(n);
		const spawned = bash.filter((c) => c.api === "shell.spawn");
		expect(spawned).toHaveLength(1);
		expect(spawned[0].arg).toContain("from-shell");
		// the output file and the cwd side channel live on the host too
		expect([...apis(bash)]).toEqual(expect.arrayContaining(["fs.mkdir", "fs.writeFile", "fs.appendFile", "fs.readFile", "fs.rm"]));
		expect(await run("Bash", { command: "pwd" })).toBe(join(cwd, "sub"));
	});

	it("the local host reports rm of a directory without recursive as EISDIR", async () => {
		const { fs } = createLocalHost();
		const dir = tempDir("pi-cc-host-rm-");
		await expect(fs.rm(dir)).rejects.toMatchObject({ code: "EISDIR" });
		await fs.rm(dir, { recursive: true });
		await expect(fs.stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("a host whose filesystem fails makes the tools fail: nothing falls back to the machine", async () => {
		const local = createLocalHost();
		const broken = Object.fromEntries(
			Object.keys(local.fs).map((name) => [name, async () => Promise.reject(Object.assign(new Error(`EACCES: host says no (${name})`), { code: "EACCES" }))]),
		) as unknown as HostFileSystem;
		const host: ClaudeCodeHost = Object.assign(Object.create(local) as ClaudeCodeHost, { fs: broken });
		const cwd = tempDir("pi-cc-host-broken-");
		const file = join(cwd, "real.txt");
		writeFileSync(file, "on disk\n");
		const { tools } = captureTools((pi: ExtensionAPI) => {
			const cc = createCCContext({ host });
			registerRead(pi, cc);
			registerWrite(pi, cc);
		});
		const run = (name: string, params: Record<string, unknown>) => tools.get(name)!.execute("id", params as any, undefined, undefined, fakeCtx(cwd));
		await expect(run("Read", { file_path: file })).rejects.toThrow("host says no");
		await expect(run("Write", { file_path: join(cwd, "new.txt"), content: "x" })).rejects.toThrow("host says no");
	});
});

describe("subagents share the parent's host", () => {
	const CHILD = "CHILD-HOST-ROUTING";
	let t: TestSession | undefined;
	afterEach(() => {
		t?.dispose();
		t = undefined;
		subagentInternals.homeDir = undefined;
	});
	const isChild = (ctx: Context) => (ctx.systemPrompt ?? "").includes(CHILD);
	const lastRole = (ctx: Context) => ctx.messages.at(-1)?.role;
	const agentCall = (input: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall("Agent", input), { stopReason: "toolUse" });
	const agents = { tester: { description: "Test agent", prompt: `${CHILD} tester` } };

	it("a subagent's Read goes through the parent's host", async () => {
		const { host, calls } = recordingHost();
		subagentInternals.homeDir = tempDir("pi-cc-home-");
		const cwd = tempDir("pi-cc-host-sub-");
		const file = join(cwd, "child.txt");
		writeFileSync(file, "child data\n");
		const handler = (ctx: Context) => {
			if (isChild(ctx)) {
				if (lastRole(ctx) === "toolResult") return fauxAssistantMessage("child read it");
				return fauxAssistantMessage(fauxToolCall("Read", { file_path: file }), { stopReason: "toolUse" });
			}
			if (lastRole(ctx) === "toolResult") return fauxAssistantMessage("parent done");
			return agentCall({ description: "Read a file", prompt: "read child.txt", subagent_type: "tester", run_in_background: false });
		};
		t = await createTestSession({ cwd, responses: Array.from({ length: 10 }, () => handler), claudeCode: { host, agents } });
		await t.session.prompt("go");
		const [res] = t.toolResults();
		expect(res.toolName).toBe("Agent");
		expect(res.text).toContain("child read it");
		// only the child read child.txt, and it did so through the recorded host
		expect(calls.some((c) => c.api === "fs.readFile" && c.arg === file)).toBe(true);
	});

	it("subagentResourceLoader builds the child session's resource loader", async () => {
		subagentInternals.homeDir = tempDir("pi-cc-home-");
		const built: ResourceLoaderOptions[] = [];
		const subagentResourceLoader = (options: ResourceLoaderOptions) => {
			built.push(options);
			return new DefaultResourceLoader(options);
		};
		let childPrompt = "";
		const handler = (ctx: Context) => {
			if (isChild(ctx)) {
				childPrompt = ctx.systemPrompt ?? "";
				return fauxAssistantMessage("child done");
			}
			if (lastRole(ctx) === "toolResult") return fauxAssistantMessage("parent done");
			return agentCall({ description: "Loader", prompt: "work", subagent_type: "tester", run_in_background: false });
		};
		t = await createTestSession({ responses: Array.from({ length: 5 }, () => handler), claudeCode: { agents, subagentResourceLoader } });
		// the parent session is built by createTestSession itself, not through the subagent factory
		expect(built).toHaveLength(0);
		await t.session.prompt("go");
		expect(t.toolResults()[0].text).toContain("child done");
		expect(built).toHaveLength(1);
		expect(built[0].cwd).toBe(t.cwd);
		// the options carry what the child needs: the Claude Code tools and its system prompt
		expect(built[0].extensionFactories!.length).toBeGreaterThan(1);
		expect(built[0].systemPromptOverride!(undefined)).toContain(`${CHILD} tester`);
		expect(childPrompt).toContain(`${CHILD} tester`);
	});

	it('isolation: "worktree" is reported as unsupported when the host has no worktrees', async () => {
		const local = createLocalHost();
		const host: ClaudeCodeHost = Object.assign(Object.create(local) as ClaudeCodeHost, { supportsWorktrees: false });
		subagentInternals.homeDir = tempDir("pi-cc-home-");
		let childRan = false;
		const handler = (ctx: Context) => {
			if (isChild(ctx)) {
				childRan = true;
				return fauxAssistantMessage("should not run");
			}
			if (lastRole(ctx) === "toolResult") return fauxAssistantMessage("parent done");
			return agentCall({ description: "Isolated", prompt: "work", subagent_type: "tester", run_in_background: false, isolation: "worktree" });
		};
		t = await createTestSession({ responses: Array.from({ length: 5 }, () => handler), claudeCode: { host, agents } });
		await t.session.prompt("go");
		const [res] = t.toolResults();
		expect(res.isError).toBe(true);
		expect(res.text).toContain(WORKTREE_UNSUPPORTED);
		expect(childRan).toBe(false);
	});
});

import fs, { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createCCContext, type CCContext } from "../src/shared/context.js";
import type { ClaudeCodeHostEvent, ClaudeCodeToolsOptions } from "../src/shared/types.js";
import { registerBash } from "../src/tools/bash.js";
import { OUTPUT_HARD_CAP, buildScript } from "../src/tools/bash-process.js";
import { registerTaskStop } from "../src/tools/task-stop.js";
import { fakeCtx, resultText, tempDir } from "./helpers.js";

interface Harness {
	messages: Array<{ message: any; options: any }>;
	events: ClaudeCodeHostEvent[];
	cc: CCContext;
	cwd: string;
	run(name: string, params: any, opts?: { signal?: AbortSignal; toolCallId?: string }): Promise<any>;
	fire(event: string): Promise<void>;
}

const harnesses: Harness[] = [];

function setup(options: ClaudeCodeToolsOptions = {}): Harness {
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, Function[]>();
	const messages: Array<{ message: any; options: any }> = [];
	const events: ClaudeCodeHostEvent[] = [];
	const fakePi = {
		registerTool: (def: ToolDefinition) => tools.set(def.name, def),
		on: (ev: string, h: Function) => handlers.set(ev, [...(handlers.get(ev) ?? []), h]),
		sendMessage: (message: any, opts: any) => messages.push({ message, options: opts }),
	} as unknown as ExtensionAPI;
	const cc = createCCContext({ ...options, onEvent: (e) => events.push(e) }, fakePi);
	registerBash(fakePi, cc);
	registerTaskStop(fakePi, cc);
	const cwd = realpathSync(tempDir("pi-cc-bashlc-"));
	const h: Harness = {
		messages,
		events,
		cc,
		cwd,
		run: (name, params, opts = {}) => tools.get(name)!.execute(opts.toolCallId ?? "call-1", params, opts.signal, undefined, fakeCtx(cwd)),
		async fire(event) {
			for (const fn of handlers.get(event) ?? []) await fn({ type: event }, fakeCtx(cwd));
		},
	};
	harnesses.push(h);
	return h;
}

afterEach(async () => {
	for (const h of harnesses.splice(0)) {
		await h.fire("session_shutdown");
		rmSync(h.cwd, { recursive: true, force: true });
	}
});

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 20));
	}
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const idOf = (text: string) => /ID: (b[0-9a-z]{8})/.exec(text)?.[1] ?? "";
const pathOf = (text: string) => /Output is being written to: (\S+\.output)\./.exec(text)?.[1] ?? "";
const mode = (p: string) => statSync(p).mode & 0o777;
const uid = process.getuid?.();

describe("#9 large foreground output is never lost", () => {
	it("output beyond the in-memory cap points at a complete file that starts at the first byte", async () => {
		const h = setup();
		const n = OUTPUT_HARD_CAP + 2 * 1024 * 1024; // 12MiB
		const text = resultText(await h.run("Bash", { command: `echo BEGIN; head -c ${n} /dev/zero | tr '\\0' a; echo; echo END` }));
		const path = /Full output saved to: (\S+)/.exec(text)?.[1] ?? "";
		expect(text.startsWith("<persisted-output>\nOutput too large (12MB). Full output saved to: ")).toBe(true);
		expect(text).toContain("\n\nPreview (first 2KB):\nBEGIN\naaaa");
		expect(text.endsWith("\n...\n</persisted-output>")).toBe(true);
		expect(text.length).toBeLessThan(3000);
		const st = statSync(path);
		expect(st.size).toBe(6 + n + 1 + 4);
		const fd = fs.openSync(path, "r");
		const head = Buffer.alloc(6);
		fs.readSync(fd, head, 0, 6, 0);
		const tail = Buffer.alloc(4);
		fs.readSync(fd, tail, 0, 4, st.size - 4);
		fs.closeSync(fd);
		expect(head.toString()).toBe("BEGIN\n");
		expect(tail.toString()).toBe("END\n");
		if (uid !== undefined) expect(mode(path)).toBe(0o600);
	}, 30_000);

	it("ordinary commands leave no output files behind", async () => {
		const h = setup();
		expect(resultText(await h.run("Bash", { command: "echo hi" }))).toBe("hi");
		await expect(h.run("Bash", { command: "echo bad; exit 3" })).rejects.toThrow("Exit code 3\nbad");
		expect(readdirSync(h.cc.tasks.outputDir())).toEqual([]);
	});
});

describe("#10 private background output directory", () => {
	it("writes task output under <tmpdir>/pi-cc-<uid> with 0700 directories and 0600 files", async () => {
		const h = setup();
		const prev = process.umask(0o022);
		try {
			const r = await h.run("Bash", { command: "echo SECRET", run_in_background: true });
			const path = pathOf(resultText(r));
			await waitFor(() => h.messages.length > 0);
			expect(readFileSync(path, "utf8")).toBe("SECRET\n\n[exited with code 0]\n");
			if (uid === undefined) return;
			expect(path).toContain(`/pi-cc-${uid}/`);
			expect(mode(path)).toBe(0o600);
			const tasksDir = dirname(path);
			expect(mode(tasksDir)).toBe(0o700);
			expect(mode(dirname(tasksDir))).toBe(0o700);
			expect(mode(dirname(dirname(tasksDir)))).toBe(0o700);
			expect(dirname(dirname(tasksDir)).endsWith(`pi-cc-${uid}`)).toBe(true);
		} finally {
			process.umask(prev);
		}
	});
});

describe("#12 background output file failures", () => {
	it("recreates a deleted output directory (Claude Code does too)", async () => {
		const h = setup();
		const r1 = await h.run("Bash", { command: "echo one", run_in_background: true });
		await waitFor(() => h.messages.length > 0);
		rmSync(dirname(pathOf(resultText(r1))), { recursive: true, force: true });
		const r2 = await h.run("Bash", { command: "echo two", run_in_background: true });
		await waitFor(() => h.messages.length > 1);
		expect(readFileSync(pathOf(resultText(r2)), "utf8")).toBe("two\n\n[exited with code 0]\n");
	});

	it("does not start the command when its output file cannot be created", async () => {
		const h = setup();
		const marker = join(h.cwd, "ran");
		h.cc.tasks.createOutputFile = () => {
			throw new Error("EACCES: permission denied");
		};
		await expect(h.run("Bash", { command: `touch ${marker}`, run_in_background: true })).rejects.toThrow("EACCES");
		await sleep(300);
		expect(existsSync(marker)).toBe(false);
		expect(h.cc.tasks.list()).toEqual([]);
		expect(h.events.filter((e) => e.type === "background_shell_started")).toHaveLength(0);
		// a foreground command still works without an output file
		expect(resultText(await h.run("Bash", { command: "echo fine" }))).toBe("fine");
	});

	it.runIf(existsSync("/proc/self/fd"))("closes the output file descriptor when writing to it fails", async () => {
		const h = setup();
		const r = await h.run("Bash", { command: "sleep 0.4; echo hi", run_in_background: true });
		const path = pathOf(resultText(r));
		const openOnFile = () =>
			readdirSync("/proc/self/fd").filter((fd) => {
				try {
					return readlinkSync(`/proc/self/fd/${fd}`) === path;
				} catch {
					return false;
				}
			}).length;
		expect(openOnFile()).toBe(1);
		const orig = fs.writeSync;
		(fs as any).writeSync = (fd: number, ...rest: any[]) => {
			if (fd > 2) {
				const e: NodeJS.ErrnoException = new Error("ENOSPC: no space left on device, write");
				e.code = "ENOSPC";
				throw e;
			}
			return (orig as any)(fd, ...rest);
		};
		syncBuiltinESMExports();
		try {
			await waitFor(() => h.events.some((e) => e.type === "background_shell_exited"));
		} finally {
			(fs as any).writeSync = orig;
			syncBuiltinESMExports();
		}
		expect(openOnFile()).toBe(0);
		// the patched writeSync really was hit: nothing reached the file
		expect(readFileSync(path, "utf8")).toBe("");
		await waitFor(() => h.messages.length > 0);
		expect(h.messages[0].message.content).toContain("<status>completed</status>");
	});
});

describe("#13 cancelled calls and shutdown", () => {
	it("an already-aborted signal does not start a background command", async () => {
		const h = setup();
		const ac = new AbortController();
		ac.abort();
		const marker = join(h.cwd, "bg_ran");
		await expect(h.run("Bash", { command: `touch ${marker}`, run_in_background: true }, { signal: ac.signal })).rejects.toThrow(
			"<error>Command was aborted before completion</error>",
		);
		await sleep(300);
		expect(existsSync(marker)).toBe(false);
		expect(h.cc.tasks.list()).toEqual([]);
	});

	it("no notification is sent and no turn started after session_shutdown", async () => {
		const h = setup();
		await h.fire("agent_start");
		await h.run("Bash", { command: "sleep 0.3", run_in_background: true });
		await h.fire("session_shutdown");
		await h.fire("agent_end");
		await sleep(600);
		expect(h.messages).toEqual([]);
	});
});

describe("#14 finished tasks are evicted", () => {
	it("removes a completed task from the registry; TaskStop still says No task found", async () => {
		const h = setup();
		const r = await h.run("Bash", { command: "echo done", run_in_background: true });
		const id = idOf(resultText(r));
		expect(h.cc.tasks.get(id)?.status).toBe("running");
		await waitFor(() => h.messages.length > 0);
		expect(h.messages[0].message.content).toContain(`<task-id>${id}</task-id>`);
		expect(h.cc.tasks.get(id)).toBeUndefined();
		expect(h.cc.tasks.list()).toEqual([]);
		await expect(h.run("TaskStop", { task_id: id })).rejects.toThrow(`<tool_use_error>No task found with ID: ${id}</tool_use_error>`);
	});

	it("removes a task stopped with TaskStop", async () => {
		const h = setup();
		const id = idOf(resultText(await h.run("Bash", { command: "sleep 5", run_in_background: true })));
		await h.run("TaskStop", { task_id: id });
		expect(h.cc.tasks.list()).toEqual([]);
		await expect(h.run("TaskStop", { task_id: id })).rejects.toThrow(`No task found with ID: ${id}`);
	});
});

describe("quirk bashErrexit (#1)", () => {
	const script = "set -e; false; touch marker; printf continued";

	it("default: like Claude Code, set -e is ignored", async () => {
		const h = setup();
		expect(resultText(await h.run("Bash", { command: script }))).toBe("continued");
		expect(existsSync(join(h.cwd, "marker"))).toBe(true);
	});

	it("fixed: set -e stops at the first failure with its exit code", async () => {
		const h = setup({ quirks: { bashErrexit: "fixed" } });
		await expect(h.run("Bash", { command: script })).rejects.toThrow(/^Exit code 1$/);
		expect(existsSync(join(h.cwd, "marker"))).toBe(false);
		await expect(h.run("Bash", { command: "set -e; echo before; exit 4; echo after" })).rejects.toThrow(/^Exit code 4\nbefore$/);
	});

	it("fixed: the cwd is still captured only on success, and errors are reported on line 1", async () => {
		const h = setup({ compat: "fixed" });
		mkdirSync(join(h.cwd, "sub"));
		mkdirSync(join(h.cwd, "other"));
		expect(resultText(await h.run("Bash", { command: "cd sub" }))).toContain(`Primary working directory: ${h.cwd}/sub`);
		expect(resultText(await h.run("Bash", { command: "pwd" }))).toBe(`${h.cwd}/sub`);
		await expect(h.run("Bash", { command: "cd ../other; false" })).rejects.toThrow("Exit code 1");
		expect(resultText(await h.run("Bash", { command: "pwd" }))).toBe(`${h.cwd}/sub`);
		await expect(h.run("Bash", { command: "set -e; cd ../other; false; echo x" })).rejects.toThrow(/^Exit code 1$/);
		expect(resultText(await h.run("Bash", { command: "pwd" }))).toBe(`${h.cwd}/sub`);
		const err = await h.run("Bash", { command: "nonexistent_cmd_pi_cc" }).catch((e) => e);
		expect(err.message).toMatch(/^Exit code 127\n.*line 1: nonexistent_cmd_pi_cc: command not found$/);
		const syntax = await h.run("Bash", { command: "if then" }).catch((e) => e);
		expect(syntax.message).toMatch(/^Exit code 2\n.*line 1: syntax error/);
	});

	it("buildScript keeps everything on one line in both modes", () => {
		expect(buildScript("echo hi", "/tmp/cwd")).toBe("exec 2>&1; eval 'echo hi' && pwd -P >| '/tmp/cwd'");
		const fixed = buildScript("echo hi", "/tmp/cwd", { errexit: true });
		expect(fixed.split("\n")).toHaveLength(1);
		expect(fixed).toBe(
			`exec 2>&1; eval 'echo hi'; __pi_cc_status=$?; if [ "$__pi_cc_status" -eq 0 ]; then pwd -P >| '/tmp/cwd'; fi; exit "$__pi_cc_status"`,
		);
		expect(buildScript("echo hi", undefined, { errexit: true })).toBe("exec 2>&1; eval 'echo hi'");
	});
});

describe("quirk orphanProcesses (#11)", () => {
	it("default: like Claude Code, `&` children outlive the command", async () => {
		const h = setup();
		const marker = join(h.cwd, "orphan");
		expect(resultText(await h.run("Bash", { command: `(sleep 0.5; touch ${marker}) & echo quick` }))).toBe("quick");
		await waitFor(() => existsSync(marker), 3000);
	});

	it("fixed: the process group is killed when a foreground command finishes", async () => {
		const h = setup({ quirks: { orphanProcesses: "fixed" } });
		const marker = join(h.cwd, "orphan");
		const start = Date.now();
		expect(resultText(await h.run("Bash", { command: `(sleep 0.5; touch ${marker}) & echo quick` }))).toBe("quick");
		expect(Date.now() - start).toBeLessThan(2000);
		await sleep(1000);
		expect(existsSync(marker)).toBe(false);
	});

	it("fixed: the process group is killed when a background command finishes", async () => {
		const h = setup({ compat: "fixed" });
		const marker = join(h.cwd, "orphan");
		await h.run("Bash", { command: `(sleep 0.5; touch ${marker}) & echo started`, run_in_background: true });
		await waitFor(() => h.messages.length > 0);
		await sleep(1000);
		expect(existsSync(marker)).toBe(false);
	});
});

describe("output directory ownership", () => {
	it.runIf(uid !== undefined)("tightens an existing root to 0700 and refuses a symlinked root", async () => {
		const { privateTempRoot } = await import("../src/shared/background.js");
		const base = tempDir("pi-cc-root-");
		try {
			const root = join(base, `pi-cc-${uid}`);
			mkdirSync(root, { mode: 0o755 });
			chmodSync(root, 0o755);
			expect(privateTempRoot(base)).toBe(root);
			expect(mode(root)).toBe(0o700);
			rmSync(root, { recursive: true });
			const elsewhere = join(base, "elsewhere");
			mkdirSync(elsewhere);
			fs.symlinkSync(elsewhere, root);
			expect(() => privateTempRoot(base)).toThrow("is not a directory");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it.runIf(uid === 0)("refuses a root owned by another user", async () => {
		const { privateTempRoot } = await import("../src/shared/background.js");
		const base = tempDir("pi-cc-root-");
		try {
			const root = join(base, `pi-cc-${uid}`);
			mkdirSync(root, { mode: 0o700 });
			fs.chownSync(root, 65534, 65534);
			expect(() => privateTempRoot(base)).toThrow("is not owned by the current user");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

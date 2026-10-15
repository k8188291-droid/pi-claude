import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createCCContext } from "../src/shared/context.js";
import type { ClaudeCodeHostEvent, ClaudeCodeToolsOptions } from "../src/shared/types.js";
import { registerBash } from "../src/tools/bash.js";
import { OutputBuffer, buildScript, formatDuration, normalizeOutput } from "../src/tools/bash-process.js";
import { createTestSession, fakeCtx, fauxAssistantMessage, fauxToolCall, resultText, tempDir } from "./helpers.js";

interface Harness {
	tools: Map<string, ToolDefinition>;
	events: ClaudeCodeHostEvent[];
	messages: Array<{ message: any; options: any }>;
	cwd: string;
	run(name: string, params: any, opts?: { signal?: AbortSignal; onUpdate?: (r: any) => void }): Promise<any>;
	shutdown(): Promise<void>;
}

const harnesses: Harness[] = [];

function setup(options: ClaudeCodeToolsOptions = {}): Harness {
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, Function[]>();
	const events: ClaudeCodeHostEvent[] = [];
	const messages: Array<{ message: any; options: any }> = [];
	const fakePi = {
		registerTool: (def: ToolDefinition) => tools.set(def.name, def),
		on: (ev: string, h: Function) => handlers.set(ev, [...(handlers.get(ev) ?? []), h]),
		sendMessage: (message: any, options: any) => messages.push({ message, options }),
	} as unknown as ExtensionAPI;
	const cc = createCCContext({ ...options, onEvent: (e) => events.push(e) });
	registerBash(fakePi, cc);
	const cwd = realpathSync(tempDir("pi-cc-bash-"));
	const h: Harness = {
		tools,
		events,
		messages,
		cwd,
		run(name, params, opts = {}) {
			return tools.get(name)!.execute("call-1", params, opts.signal, opts.onUpdate, fakeCtx(cwd));
		},
		async shutdown() {
			for (const fn of handlers.get("session_shutdown") ?? []) await fn({ type: "session_shutdown" }, fakeCtx(cwd));
		},
	};
	harnesses.push(h);
	return h;
}

afterEach(async () => {
	for (const h of harnesses.splice(0)) {
		await h.shutdown();
		rmSync(h.cwd, { recursive: true, force: true });
	}
});

async function runText(h: Harness, params: any): Promise<string> {
	return resultText(await h.run("Bash", params));
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 20));
	}
}

describe("Bash schema", () => {
	it("registers tools with Claude Code names and params", () => {
		const h = setup();
		expect([...h.tools.keys()]).toEqual(["Bash", "BashOutput", "KillShell"]);
		const bash = h.tools.get("Bash")!.parameters as any;
		expect(Object.keys(bash.properties)).toEqual(["command", "timeout", "description", "run_in_background"]);
		expect(bash.required).toEqual(["command"]);
		expect((h.tools.get("BashOutput")!.parameters as any).required).toEqual(["bash_id"]);
		expect(Object.keys((h.tools.get("BashOutput")!.parameters as any).properties)).toEqual(["bash_id", "filter"]);
		expect((h.tools.get("KillShell")!.parameters as any).required).toEqual(["shell_id"]);
		expect(h.tools.get("Bash")!.description).toContain("120000ms");
		expect(h.tools.get("Bash")!.description).toContain("600000ms");
	});

	it("reflects configured timeouts in the description", () => {
		const h = setup({ bash: { defaultTimeoutMs: 30000, maxTimeoutMs: 60000 } });
		expect(h.tools.get("Bash")!.description).toContain("30000ms");
		expect(h.tools.get("Bash")!.description).toContain("60000ms");
	});
});

describe("Bash foreground", () => {
	it("runs a command in ctx.cwd and returns output", async () => {
		const h = setup();
		const r = await h.run("Bash", { command: "echo hello && pwd" });
		expect(resultText(r)).toBe(`hello\n${h.cwd}`);
		expect(r.details.exitCode).toBe(0);
	});

	it("persists the working directory across calls", async () => {
		const h = setup();
		mkdirSync(join(h.cwd, "sub", "deeper"), { recursive: true });
		await h.run("Bash", { command: "cd sub" });
		expect(await runText(h, { command: "pwd" })).toBe(join(h.cwd, "sub"));
		await h.run("Bash", { command: "cd deeper && echo x" });
		expect(await runText(h, { command: "pwd" })).toBe(join(h.cwd, "sub", "deeper"));
		await h.run("Bash", { command: "cd .." });
		expect(await runText(h, { command: "pwd" })).toBe(join(h.cwd, "sub"));
	});

	it("updates the cwd even if the command fails or calls exit afterwards", async () => {
		const h = setup();
		mkdirSync(join(h.cwd, "a"));
		mkdirSync(join(h.cwd, "b"));
		await expect(h.run("Bash", { command: "cd a; false" })).rejects.toThrow("Exit code 1");
		expect(await runText(h, { command: "pwd" })).toBe(join(h.cwd, "a"));
		await expect(h.run("Bash", { command: "cd ../b; exit 4" })).rejects.toThrow("Exit code 4");
		expect(await runText(h, { command: "pwd" })).toBe(join(h.cwd, "b"));
	});

	it("falls back to ctx.cwd when the stored cwd was deleted", async () => {
		const h = setup();
		mkdirSync(join(h.cwd, "gone"));
		await h.run("Bash", { command: "cd gone" });
		rmSync(join(h.cwd, "gone"), { recursive: true });
		const text = await runText(h, { command: "pwd" });
		expect(text.split("\n")[0]).toBe(h.cwd);
		expect(text).toContain("Shell cwd was reset");
		expect(await runText(h, { command: "pwd" })).toBe(h.cwd);
	});

	it("does not persist environment variables", async () => {
		const h = setup();
		await h.run("Bash", { command: "export PI_CC_TEST_VAR=abc; FOO_LOCAL=1" });
		expect(await runText(h, { command: 'echo "[${PI_CC_TEST_VAR:-unset}]"' })).toBe("[unset]");
	});

	it("non-zero exit is an error containing output and exit code", async () => {
		const h = setup();
		const err = await h.run("Bash", { command: "echo out; echo err >&2; exit 3" }).catch((e) => e);
		expect(err).toBeInstanceOf(Error);
		expect(err.message).toMatch(/^Exit code 3\n/);
		expect(err.message).toContain("out");
		expect(err.message).toContain("err");
	});

	it("captures stderr interleaved with stdout", async () => {
		const h = setup();
		expect(await runText(h, { command: "echo one; echo two >&2; echo three" })).toBe("one\ntwo\nthree");
	});

	it("reports syntax errors as errors", async () => {
		const h = setup();
		await expect(h.run("Bash", { command: "if then" })).rejects.toThrow(/Exit code 2[\s\S]*syntax error/);
	});

	it("handles quotes and special characters in the command", async () => {
		const h = setup();
		expect(await runText(h, { command: `echo 'single' "double" \`echo back\` $((1+2)) "it's"` })).toBe("single double back 3 it's");
		expect(await runText(h, { command: "cat <<'EOF'\nline $1\nEOF" })).toBe("line $1");
	});

	it("strips leading blank lines and trailing whitespace, reports empty output", async () => {
		const h = setup();
		expect(await runText(h, { command: "printf '\\n\\n  indented\\n\\n\\n'" })).toBe("  indented");
		expect(await runText(h, { command: "true" })).toBe("(No output)");
	});

	it("stdin is /dev/null (commands reading stdin do not hang)", async () => {
		const h = setup();
		expect(await runText(h, { command: "cat; echo done" })).toBe("done");
	});

	it("times out, kills the process tree and reports partial output", async () => {
		const h = setup();
		const marker = join(h.cwd, "child-alive");
		const start = Date.now();
		const err = await h
			.run("Bash", { command: `echo started; (sleep 1; touch ${marker}) & sleep 5`, timeout: 300 })
			.catch((e) => e);
		expect(Date.now() - start).toBeLessThan(3000);
		expect(err.message).toContain("started");
		expect(err.message).toContain("Command timed out after 300ms");
		await new Promise((r) => setTimeout(r, 1300));
		// the background subshell was part of the process group and must be dead
		expect(() => realpathSync(marker)).toThrow();
	});

	it("clamps the timeout to maxTimeoutMs and uses defaultTimeoutMs", async () => {
		const h = setup({ bash: { defaultTimeoutMs: 200, maxTimeoutMs: 400 } });
		let start = Date.now();
		await expect(h.run("Bash", { command: "sleep 5" })).rejects.toThrow("timed out after 200ms");
		expect(Date.now() - start).toBeLessThan(2500);
		start = Date.now();
		await expect(h.run("Bash", { command: "sleep 5", timeout: 999999 })).rejects.toThrow("timed out after 400ms");
		expect(Date.now() - start).toBeLessThan(2500);
	});

	it("abort signal kills the command", async () => {
		const h = setup();
		const ac = new AbortController();
		const start = Date.now();
		const p = h.run("Bash", { command: "echo begin; sleep 5" }, { signal: ac.signal });
		setTimeout(() => ac.abort(), 200);
		const err = await p.catch((e) => e);
		expect(Date.now() - start).toBeLessThan(3000);
		expect(err.message).toContain("begin");
		expect(err.message).toContain("aborted");
	});

	it("already-aborted signal does not run the command", async () => {
		const h = setup();
		const ac = new AbortController();
		ac.abort();
		await expect(h.run("Bash", { command: `touch ${join(h.cwd, "x")}` }, { signal: ac.signal })).rejects.toThrow("aborted");
		expect(() => realpathSync(join(h.cwd, "x"))).toThrow();
	});

	it("streams partial output via onUpdate", async () => {
		const h = setup();
		const updates: string[] = [];
		const r = await h.run(
			"Bash",
			{ command: "echo first; sleep 0.3; echo second" },
			{ onUpdate: (u) => updates.push(resultText(u)) },
		);
		expect(resultText(r)).toBe("first\nsecond");
		expect(updates.some((u) => u.includes("first") && !u.includes("second"))).toBe(true);
	});

	it("returns large output without truncating below the hard cap", async () => {
		const h = setup();
		const text = await runText(h, { command: "seq 1 200000" });
		const lines = text.split("\n");
		expect(lines.length).toBe(200000);
		expect(lines[0]).toBe("1");
		expect(lines.at(-1)).toBe("200000");
	});

	it("rejects an empty command", async () => {
		const h = setup();
		await expect(h.run("Bash", { command: "   " })).rejects.toThrow("non-empty");
	});

	it("does not hang when a command leaves a background process holding stdout", async () => {
		const h = setup();
		const start = Date.now();
		expect(await runText(h, { command: "sleep 3 & echo quick" })).toBe("quick");
		expect(Date.now() - start).toBeLessThan(2000);
	});
});

describe("Bash background + BashOutput + KillShell", () => {
	it("starts in background, reads output incrementally, notifies on completion", async () => {
		const h = setup();
		mkdirSync(join(h.cwd, "bgdir"));
		await h.run("Bash", { command: "cd bgdir" });
		const r = await h.run("Bash", {
			command: "pwd; echo one; sleep 0.4; echo two; exit 0",
			run_in_background: true,
		});
		expect(resultText(r)).toContain("bash_1");
		expect(resultText(r)).toContain("BashOutput");
		expect(r.details.backgroundTaskId).toBe("bash_1");
		expect(h.events[0]).toEqual({ type: "background_shell_started", shellId: "bash_1", command: expect.stringContaining("echo one") });

		await new Promise((res) => setTimeout(res, 200));
		const first = resultText(await h.run("BashOutput", { bash_id: "bash_1" }));
		expect(first).toContain("<status>running</status>");
		expect(first).toContain(join(h.cwd, "bgdir"));
		expect(first).toContain("one");
		expect(first).not.toContain("two");

		await waitFor(() => h.events.some((e) => e.type === "background_shell_exited"));
		expect(h.events.find((e) => e.type === "background_shell_exited")).toEqual({
			type: "background_shell_exited",
			shellId: "bash_1",
			exitCode: 0,
			signal: null,
		});
		expect(h.messages).toHaveLength(1);
		expect(h.messages[0].message.content).toContain("Background Bash bash_1");
		expect(h.messages[0].message.content).toContain("completed with exit code 0");
		expect(h.messages[0].message.content).toContain("<system-reminder>");
		expect(h.messages[0].options).toEqual({ deliverAs: "followUp", triggerTurn: true });

		const second = resultText(await h.run("BashOutput", { bash_id: "bash_1" }));
		expect(second).toContain("<status>completed</status>");
		expect(second).toContain("<exit_code>0</exit_code>");
		expect(second).toContain("two");
		expect(second).not.toContain("one");

		const third = resultText(await h.run("BashOutput", { bash_id: "bash_1" }));
		expect(third).toContain("(No new output)");
	});

	it("reports failed background commands", async () => {
		const h = setup();
		await h.run("Bash", { command: "echo bad >&2; exit 7", run_in_background: true });
		await waitFor(() => h.messages.length > 0);
		expect(h.messages[0].message.content).toContain("failed with exit code 7");
		const out = resultText(await h.run("BashOutput", { bash_id: "bash_1" }));
		expect(out).toContain("<status>failed</status>");
		expect(out).toContain("<exit_code>7</exit_code>");
		expect(out).toContain("bad");
	});

	it("filter returns only matching lines and consumes the rest", async () => {
		const h = setup();
		await h.run("Bash", { command: "printf 'ERROR a\\ninfo b\\nERROR c\\ninfo d\\n'", run_in_background: true });
		await waitFor(() => h.events.some((e) => e.type === "background_shell_exited"));
		const out = resultText(await h.run("BashOutput", { bash_id: "bash_1", filter: "^ERROR" }));
		expect(out).toContain("ERROR a\nERROR c");
		expect(out).not.toContain("info");
		expect(resultText(await h.run("BashOutput", { bash_id: "bash_1" }))).toContain("(No new output)");
	});

	it("filter holds back incomplete trailing lines while running", async () => {
		const h = setup();
		await h.run("Bash", { command: "printf 'match 1\\nmat'; sleep 0.4; printf 'ch 2\\n'", run_in_background: true });
		await new Promise((r) => setTimeout(r, 200));
		const first = resultText(await h.run("BashOutput", { bash_id: "bash_1", filter: "match" }));
		expect(first).toContain("match 1");
		expect(first).not.toContain("mat\n");
		await waitFor(() => h.events.some((e) => e.type === "background_shell_exited"));
		const second = resultText(await h.run("BashOutput", { bash_id: "bash_1", filter: "match" }));
		expect(second).toContain("match 2");
	});

	it("invalid filter regex is an error", async () => {
		const h = setup();
		await h.run("Bash", { command: "echo x", run_in_background: true });
		await expect(h.run("BashOutput", { bash_id: "bash_1", filter: "(" })).rejects.toThrow("Invalid filter regex");
	});

	it("unknown ids are errors listing known ids", async () => {
		const h = setup();
		await expect(h.run("BashOutput", { bash_id: "bash_9" })).rejects.toThrow("Known shell IDs: (none)");
		await h.run("Bash", { command: "sleep 2", run_in_background: true });
		await h.run("Bash", { command: "sleep 2", run_in_background: true });
		await expect(h.run("BashOutput", { bash_id: "nope" })).rejects.toThrow("Known shell IDs: bash_1, bash_2");
		await expect(h.run("KillShell", { shell_id: "nope" })).rejects.toThrow("bash_1, bash_2");
	});

	it("KillShell kills the process tree without waking the model", async () => {
		const h = setup();
		const marker = join(h.cwd, "alive");
		await h.run("Bash", { command: `echo started; (sleep 0.8; touch ${marker}) & sleep 5`, run_in_background: true });
		await new Promise((r) => setTimeout(r, 150));
		const r = await h.run("KillShell", { shell_id: "bash_1" });
		expect(resultText(r)).toContain("Successfully killed shell: bash_1");
		await waitFor(() => h.events.some((e) => e.type === "background_shell_exited"));
		const exited = h.events.find((e) => e.type === "background_shell_exited") as any;
		expect(exited.exitCode).toBeNull();
		expect(exited.signal).toBe("SIGKILL");
		expect(h.messages).toHaveLength(0);
		const out = resultText(await h.run("BashOutput", { bash_id: "bash_1" }));
		expect(out).toContain("<status>killed</status>");
		expect(out).toContain("started");
		await expect(h.run("KillShell", { shell_id: "bash_1" })).rejects.toThrow("already killed");
		await new Promise((r) => setTimeout(r, 900));
		expect(() => realpathSync(marker)).toThrow();
	});

	it("KillShell on a finished shell is an error saying so", async () => {
		const h = setup();
		await h.run("Bash", { command: "true", run_in_background: true });
		await waitFor(() => h.events.some((e) => e.type === "background_shell_exited"));
		await expect(h.run("KillShell", { shell_id: "bash_1" })).rejects.toThrow(/already finished.*completed.*exit code: 0/);
	});

	it("session_shutdown kills all running background shells", async () => {
		const h = setup();
		await h.run("Bash", { command: "sleep 10", run_in_background: true });
		await h.run("Bash", { command: "sleep 10", run_in_background: true });
		await h.shutdown();
		await waitFor(() => h.events.filter((e) => e.type === "background_shell_exited").length === 2);
		expect(h.messages).toHaveLength(0);
		const out = resultText(await h.run("BashOutput", { bash_id: "bash_2" }));
		expect(out).toContain("<status>killed</status>");
	});

	it("background shells do not change the persistent cwd", async () => {
		const h = setup();
		mkdirSync(join(h.cwd, "x"));
		await h.run("Bash", { command: "cd x", run_in_background: true });
		await waitFor(() => h.events.some((e) => e.type === "background_shell_exited"));
		expect(await runText(h, { command: "pwd" })).toBe(h.cwd);
	});
});

describe("bash-process helpers", () => {
	it("OutputBuffer drops oldest text beyond the cap but keeps absolute offsets", () => {
		const b = new OutputBuffer(100);
		b.append("a".repeat(80));
		const cursor = b.end;
		b.append("b".repeat(50));
		expect(b.toString().length).toBeLessThanOrEqual(100);
		expect(b.droppedChars).toBeGreaterThan(0);
		expect(b.end).toBe(130);
		expect(b.readFrom(cursor)).toEqual({ text: "b".repeat(50), lost: 0 });
		const r = b.readFrom(0);
		expect(r.lost).toBe(b.droppedChars);
		expect(r.text).toBe(b.toString());
	});

	it("normalizeOutput / formatDuration / buildScript", () => {
		expect(normalizeOutput("\n \n  x\n y  \n\n")).toBe("  x\n y");
		expect(formatDuration(300)).toBe("300ms");
		expect(formatDuration(2000)).toBe("2s");
		expect(formatDuration(120000)).toBe("2m");
		expect(formatDuration(90000)).toBe("1m 30s");
		const s = buildScript("echo 'hi'", "/tmp/it's");
		expect(s).toContain("exec 2>&1");
		expect(s).toContain("eval 'echo '\\''hi'\\'''");
	});
});

describe("Bash end-to-end", () => {
	it("works through a real session with persistent cwd and error results", async () => {
		const t = await createTestSession({
			responses: [
				fauxAssistantMessage(fauxToolCall("Bash", { command: "mkdir -p sub && cd sub", description: "Enter sub" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("Bash", { command: "pwd" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("Bash", { command: "exit 5" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			],
		});
		try {
			await t.session.prompt("go");
			const results = t.toolResults();
			expect(results.map((r) => r.toolName)).toEqual(["Bash", "Bash", "Bash"]);
			expect(results[1].text).toBe(join(realpathSync(t.cwd), "sub"));
			expect(results[1].isError).toBe(false);
			expect(results[2].isError).toBe(true);
			expect(results[2].text).toContain("Exit code 5");
		} finally {
			t.dispose();
		}
	});
});


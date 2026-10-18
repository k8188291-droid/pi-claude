import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createCCContext, type CCContext } from "../src/shared/context.js";
import type { ClaudeCodeHostEvent, ClaudeCodeToolsOptions } from "../src/shared/types.js";
import { isErrorExit, registerBash, splitCommands, truncateError } from "../src/tools/bash.js";
import { OutputBuffer, buildScript, formatClaudeDuration } from "../src/tools/bash-process.js";
import { registerTaskStop } from "../src/tools/task-stop.js";
import { createTestSession, fakeCtx, fauxAssistantMessage, fauxToolCall, resultText, tempDir } from "./helpers.js";

interface Harness {
	tools: Map<string, ToolDefinition>;
	events: ClaudeCodeHostEvent[];
	/** Messages sent through pi.sendMessage (task notifications while idle). */
	messages: Array<{ message: any; options: any }>;
	cc: CCContext;
	cwd: string;
	run(name: string, params: any, opts?: { signal?: AbortSignal; onUpdate?: (r: any) => void; toolCallId?: string }): Promise<any>;
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
	const cc = createCCContext({ ...options, onEvent: (e) => events.push(e) }, fakePi);
	registerBash(fakePi, cc);
	registerTaskStop(fakePi, cc);
	const cwd = realpathSync(tempDir("pi-cc-bash-"));
	const h: Harness = {
		tools,
		events,
		messages,
		cc,
		cwd,
		run(name, params, opts = {}) {
			return tools.get(name)!.execute(opts.toolCallId ?? "call-1", params, opts.signal, opts.onUpdate, fakeCtx(cwd));
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

const idOf = (text: string) => /ID: (b[0-9a-z]{8})/.exec(text)?.[1] ?? "";
const pathOf = (text: string) => /Output is being written to: (\S+\.output)\./.exec(text)?.[1] ?? "";

describe("Bash schema", () => {
	it("registers Bash with Claude Code's params", () => {
		const h = setup();
		expect([...h.tools.keys()]).toEqual(["Bash", "TaskStop"]);
		const bash = h.tools.get("Bash")!.parameters as any;
		expect(Object.keys(bash.properties)).toEqual(["command", "timeout", "description", "run_in_background", "dangerouslyDisableSandbox"]);
		expect(bash.required).toEqual(["command"]);
		expect(bash.additionalProperties).toBe(false);
		const desc = h.tools.get("Bash")!.description;
		expect(desc).toContain("up to 600000ms / 10 minutes for a foreground command");
		expect(desc).toContain("timeout after 120000ms (2 minutes)");
		expect(desc).toContain("default 1800000ms / 30 minutes, max 7200000ms / 2 hours");
	});

	it("reflects configured timeouts in the description", () => {
		const h = setup({ bash: { defaultTimeoutMs: 30000, maxTimeoutMs: 60000 } });
		expect(h.tools.get("Bash")!.description).toContain("30000ms (0.5 minutes)");
		expect(h.tools.get("Bash")!.description).toContain("60000ms / 1 minute");
	});

	it("validates input like Claude Code", () => {
		const h = setup();
		const prepare = (h.tools.get("Bash") as any).prepareArguments;
		expect(() => prepare({ description: "x" })).toThrow("InputValidationError: Bash failed due to the following issue:\nThe required parameter `command` is missing");
		expect(() => prepare({ command: "ls", bogus: 1 })).toThrow("An unexpected parameter `bogus` was provided");
		expect(prepare({ command: "ls", dangerouslyDisableSandbox: true })).toEqual({ command: "ls", dangerouslyDisableSandbox: true });
	});
});

describe("Bash foreground", () => {
	it("runs a command in ctx.cwd and returns output", async () => {
		const h = setup();
		const r = await h.run("Bash", { command: "echo hello && pwd" });
		expect(resultText(r)).toBe(`hello\n${h.cwd}`);
		expect(r.details.exitCode).toBe(0);
	});

	it("persists the working directory and reports changes like Claude Code", async () => {
		const h = setup();
		mkdirSync(join(h.cwd, "sub", "deeper"), { recursive: true });
		expect(await runText(h, { command: "cd sub" })).toBe(
			`(Bash completed with no output)\n\n<system-reminder>\n# Environment update\n - Primary working directory: ${h.cwd}/sub (was ${h.cwd})\n</system-reminder>`,
		);
		expect(await runText(h, { command: "pwd" })).toBe(join(h.cwd, "sub"));
		await h.run("Bash", { command: "cd deeper && echo x" });
		expect(await runText(h, { command: "pwd" })).toBe(join(h.cwd, "sub", "deeper"));
		await h.run("Bash", { command: "cd .." });
		expect(await runText(h, { command: "pwd" })).toBe(join(h.cwd, "sub"));
	});

	it("reports a git repository change in the environment update", async () => {
		const h = setup();
		mkdirSync(join(h.cwd, "repo", ".git"), { recursive: true });
		const text = await runText(h, { command: "cd repo" });
		expect(text).toContain(` - Primary working directory: ${h.cwd}/repo (was ${h.cwd})\n - Is a git repository: true (was false)`);
	});

	it("only updates the cwd when the command succeeds", async () => {
		const h = setup();
		mkdirSync(join(h.cwd, "a"));
		await expect(h.run("Bash", { command: "cd a; false" })).rejects.toThrow("Exit code 1");
		expect(await runText(h, { command: "pwd" })).toBe(h.cwd);
		await expect(h.run("Bash", { command: "cd a; exit 4" })).rejects.toThrow("Exit code 4");
		expect(await runText(h, { command: "pwd" })).toBe(h.cwd);
	});

	it("resets the cwd when a command leaves the project", async () => {
		const h = setup();
		expect(await runText(h, { command: "cd .. && echo moved" })).toBe(`moved\nShell cwd was reset to ${h.cwd}`);
		expect(await runText(h, { command: "pwd" })).toBe(h.cwd);
	});

	it("falls back to ctx.cwd when the stored cwd was deleted", async () => {
		const h = setup();
		mkdirSync(join(h.cwd, "gone"));
		await h.run("Bash", { command: "cd gone" });
		rmSync(join(h.cwd, "gone"), { recursive: true });
		const text = await runText(h, { command: "pwd" });
		expect(text.split("\n")[0]).toBe(h.cwd);
		expect(text).toContain(`Primary working directory: ${h.cwd} (was ${h.cwd}/gone)`);
		expect(await runText(h, { command: "pwd" })).toBe(h.cwd);
	});

	it("does not persist environment variables", async () => {
		const h = setup();
		await h.run("Bash", { command: "export PI_CC_TEST_VAR=abc; FOO_LOCAL=1" });
		expect(await runText(h, { command: 'echo "[${PI_CC_TEST_VAR:-unset}]"' })).toBe("[unset]");
	});

	it("non-zero exit is an error: exit code line, then the output", async () => {
		const h = setup();
		await expect(h.run("Bash", { command: "echo out; echo err >&2; exit 3" })).rejects.toThrow(/^Exit code 3\nout\nerr$/);
		await expect(h.run("Bash", { command: "false" })).rejects.toThrow(/^Exit code 1$/);
		await expect(h.run("Bash", { command: "printf '\\n  lead\\n'; exit 1" })).rejects.toThrow(/^Exit code 1\n\n {2}lead$/);
	});

	it("exit 1 of grep/diff/test is not an error", async () => {
		const h = setup();
		expect(await runText(h, { command: "grep zzz /dev/null" })).toBe("(Bash completed with no output)");
		expect(await runText(h, { command: "echo abc | grep zzz" })).toBe("(Bash completed with no output)");
		await expect(h.run("Bash", { command: "grep zzz /nonexistent_xyz" })).rejects.toThrow(/^Exit code 2\n/);
	});

	it("reports bash errors on line 1", async () => {
		const h = setup();
		await expect(h.run("Bash", { command: "definitely_not_a_command_xyz" })).rejects.toThrow(
			"Exit code 127\n/bin/bash: line 1: definitely_not_a_command_xyz: command not found",
		);
		await expect(h.run("Bash", { command: "if then" })).rejects.toThrow(/Exit code 2\n\/bin\/bash: eval: line 1: syntax error/);
	});

	it("a shell killed by a signal reports exit code 1", async () => {
		const h = setup();
		await expect(h.run("Bash", { command: "echo pre; kill -9 $$" })).rejects.toThrow(/^Exit code 1\npre$/);
	});

	it("captures stderr interleaved with stdout", async () => {
		const h = setup();
		expect(await runText(h, { command: "echo one; echo two >&2; echo three" })).toBe("one\ntwo\nthree");
	});

	it("handles quotes and special characters in the command", async () => {
		const h = setup();
		expect(await runText(h, { command: `echo 'single' "double" \`echo back\` $((1+2)) "it's"` })).toBe("single double back 3 it's");
		expect(await runText(h, { command: "cat <<'EOF'\nline $1\nEOF" })).toBe("line $1");
	});

	it("trims output and reports empty output", async () => {
		const h = setup();
		expect(await runText(h, { command: "printf '\\n\\n  indented\\n    more\\n\\n'" })).toBe("indented\n    more");
		expect(await runText(h, { command: "true" })).toBe("(Bash completed with no output)");
		expect(await runText(h, { command: "" })).toBe("(Bash completed with no output)");
	});

	it("stdin is /dev/null (commands reading stdin do not hang)", async () => {
		const h = setup();
		expect(await runText(h, { command: "cat; echo done" })).toBe("done");
	});

	it("truncates long error output like Claude Code", async () => {
		const h = setup();
		const err = await h.run("Bash", { command: "seq 1 20000; exit 4" }).catch((e) => e);
		expect(err.message.length).toBe(10040);
		expect(err.message.startsWith("Exit code 4\n1\n2\n")).toBe(true);
		expect(err.message).toContain("\n\n... [20012 characters truncated] ...\n\n");
		expect(err.message.endsWith("6221\n62")).toBe(true);
	});

	it("moves a command to the background at its timeout instead of killing it", async () => {
		const h = setup();
		const r = await h.run("Bash", { command: "echo start; sleep 0.6; echo end", timeout: 200 }, { toolCallId: "tc-1" });
		const text = resultText(r);
		const id = idOf(text);
		const path = pathOf(text);
		expect(text).toBe(
			`Command did not complete within its 1s timeout and was moved to the background (ID: ${id}). Output is being written to: ${path}. You will be notified when it completes. If it is still running after 30m in the background, it will be stopped and you will be notified. To check interim output, use Read on that file path.`,
		);
		expect(readFileSync(path, "utf8")).toBe("start\n");
		await waitFor(() => h.messages.length > 0);
		expect(readFileSync(path, "utf8")).toBe("start\nend\n\n[exited with code 0]\n");
		const msg = h.messages[0].message.content as string;
		expect(msg).toContain(`<task-id>${id}</task-id>\n<tool-use-id>tc-1</tool-use-id>\n<output-file>${path}</output-file>\n<status>completed</status>`);
		expect(msg).toContain(`<summary>Background command "echo start; sleep 0.6; echo end" completed (exit code 0)</summary>`);
	});

	it("kills commands starting with sleep at their timeout", async () => {
		const h = setup();
		const marker = join(h.cwd, "child-alive");
		const start = Date.now();
		const err = await h.run("Bash", { command: `sleep 0.1; echo started; (sleep 1; touch ${marker}) & sleep 5`, timeout: 500 }).catch((e) => e);
		expect(Date.now() - start).toBeLessThan(3000);
		expect(err.message).toBe("Exit code 143\nCommand timed out after 0s\nstarted");
		await new Promise((r) => setTimeout(r, 1300));
		expect(existsSync(marker)).toBe(false);
	});

	it("clamps the timeout to maxTimeoutMs and uses defaultTimeoutMs", async () => {
		const h = setup({ bash: { defaultTimeoutMs: 200, maxTimeoutMs: 400 } });
		let start = Date.now();
		await expect(h.run("Bash", { command: "sleep 5" })).rejects.toThrow("Command timed out after 0s");
		expect(Date.now() - start).toBeLessThan(2500);
		start = Date.now();
		await expect(h.run("Bash", { command: "sleep 5", timeout: 999999 })).rejects.toThrow("Exit code 143");
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
		expect(err.message).toBe("begin\n<error>Command was aborted before completion</error>");
	});

	it("already-aborted signal does not run the command", async () => {
		const h = setup();
		const ac = new AbortController();
		ac.abort();
		await expect(h.run("Bash", { command: `touch ${join(h.cwd, "x")}` }, { signal: ac.signal })).rejects.toThrow("aborted");
		expect(existsSync(join(h.cwd, "x"))).toBe(false);
	});

	it("streams partial output via onUpdate", async () => {
		const h = setup();
		const updates: string[] = [];
		const r = await h.run("Bash", { command: "echo first; sleep 0.3; echo second" }, { onUpdate: (u) => updates.push(resultText(u)) });
		expect(resultText(r)).toBe("first\nsecond");
		expect(updates.some((u) => u.includes("first") && !u.includes("second"))).toBe(true);
	});

	it("returns large successful output in full (spilling is done by output-spill)", async () => {
		const h = setup();
		const lines = (await runText(h, { command: "seq 1 200000" })).split("\n");
		expect(lines.length).toBe(200000);
		expect(lines.at(-1)).toBe("200000");
	});

	it("does not hang when a command leaves a background process holding stdout", async () => {
		const h = setup();
		const start = Date.now();
		expect(await runText(h, { command: "sleep 3 & echo quick" })).toBe("quick");
		expect(Date.now() - start).toBeLessThan(2000);
	});

	it("names previously read files a formatter modified", async () => {
		const h = setup();
		const file = join(h.cwd, "f.txt");
		writeFileSync(file, "a\n");
		h.cc.fileState.recordRead(file, "a\n");
		expect(await runText(h, { command: "sleep 1; sed --in-place 's/a/b/' f.txt" })).toBe(
			"[This command modified 1 file you've previously read: f.txt. Call Read before editing.]",
		);
	});
});

describe("Bash background + TaskStop", () => {
	it("writes output to a file and notifies on completion", async () => {
		const h = setup();
		const r = await h.run("Bash", { command: "echo one; sleep 0.4; echo two", run_in_background: true }, { toolCallId: "tc-bg" });
		const text = resultText(r);
		const id = idOf(text);
		const path = pathOf(text);
		expect(id).toMatch(/^b[0-9a-z]{8}$/);
		expect(text).toBe(
			`Command running in background with ID: ${id}. Output is being written to: ${path}. You will be notified when it completes. To check interim output, use Read on that file path.`,
		);
		expect(r.details.backgroundTaskId).toBe(id);
		expect(h.events[0]).toEqual({ type: "background_shell_started", shellId: id, command: "echo one; sleep 0.4; echo two" });
		await new Promise((res) => setTimeout(res, 200));
		expect(readFileSync(path, "utf8")).toBe("one\n");
		await waitFor(() => h.messages.length > 0);
		expect(readFileSync(path, "utf8")).toBe("one\ntwo\n\n[exited with code 0]\n");
		expect(h.events.at(-1)).toEqual({ type: "background_shell_exited", shellId: id, exitCode: 0, signal: null });
		expect(h.messages[0].options).toEqual({ deliverAs: "followUp", triggerTurn: true });
		const msg = h.messages[0].message.content as string;
		expect(msg).toContain("[SYSTEM NOTIFICATION - NOT USER INPUT]");
		expect(msg).toContain(`<task-id>${id}</task-id>\n<tool-use-id>tc-bg</tool-use-id>\n<output-file>${path}</output-file>\n<status>completed</status>`);
		expect(msg).toContain(`<summary>Background command "echo one; sleep 0.4; echo two" completed (exit code 0)</summary>`);
	});

	it("reports failures with the description, XML-escaped", async () => {
		const h = setup();
		const r = await h.run("Bash", { command: "echo bad >&2; exit 7", description: "Fail <now> & quit", run_in_background: true });
		await waitFor(() => h.messages.length > 0);
		const msg = h.messages[0].message.content as string;
		expect(msg).toContain("<status>failed</status>");
		expect(msg).toContain(`<summary>Background command "Fail &lt;now&gt; &amp; quit" failed with exit code 7</summary>`);
		expect(readFileSync(pathOf(resultText(r)), "utf8")).toBe("bad\n\n[exited with code 7]\n");
	});

	it("stops a background command at its background time limit", async () => {
		const h = setup();
		const r = await h.run("Bash", { command: "echo x; sleep 5", run_in_background: true, timeout: 300 });
		await waitFor(() => h.messages.length > 0);
		const msg = h.messages[0].message.content as string;
		expect(msg).toContain("<status>killed</status>");
		expect(msg).toContain(`<summary>Background command "echo x; sleep 5" was stopped after reaching its background time limit</summary>\n<note>If the work`);
		expect(readFileSync(pathOf(resultText(r)), "utf8")).toBe("x\n\n[killed]\n");
	});

	it("TaskStop kills the process tree without a notification", async () => {
		const h = setup();
		const marker = join(h.cwd, "alive");
		const r = await h.run("Bash", { command: `echo started; (sleep 0.8; touch ${marker}) & sleep 5`, run_in_background: true });
		const id = idOf(resultText(r));
		await new Promise((res) => setTimeout(res, 150));
		const stop = await h.run("TaskStop", { task_id: id });
		expect(JSON.parse(resultText(stop))).toEqual({
			message: `Successfully stopped task: ${id} (echo started; (sleep 0.8; touch ${marker}) & sleep 5)`,
			task_id: id,
			task_type: "local_bash",
			command: `echo started; (sleep 0.8; touch ${marker}) & sleep 5`,
		});
		expect(readFileSync(pathOf(resultText(r)), "utf8")).toBe("started\n\n[killed]\n");
		await expect(h.run("TaskStop", { task_id: id })).rejects.toThrow(`<tool_use_error>No task found with ID: ${id}</tool_use_error>`);
		await new Promise((res) => setTimeout(res, 900));
		expect(existsSync(marker)).toBe(false);
		expect(h.messages).toHaveLength(0);
	});

	it("TaskStop errors match Claude Code", async () => {
		const h = setup();
		await expect(h.run("TaskStop", {})).rejects.toThrow("<tool_use_error>Missing required parameter: task_id</tool_use_error>");
		await expect(h.run("TaskStop", { shell_id: "bnope" })).rejects.toThrow("<tool_use_error>No task found with ID: bnope</tool_use_error>");
		const r = await h.run("Bash", { command: "true", run_in_background: true });
		await waitFor(() => h.messages.length > 0);
		const id = idOf(resultText(r));
		await expect(h.run("TaskStop", { task_id: id })).rejects.toThrow(`No task found with ID: ${id}`);
	});

	it("session_shutdown kills all running background commands without notifications", async () => {
		const h = setup();
		await h.run("Bash", { command: "sleep 10", run_in_background: true });
		await h.run("Bash", { command: "sleep 10", run_in_background: true });
		await h.shutdown();
		await waitFor(() => h.events.filter((e) => e.type === "background_shell_exited").length === 2);
		expect(h.messages).toHaveLength(0);
		expect(h.cc.tasks.list().map((t) => t.status)).toEqual(["killed", "killed"]);
	});

	it("background commands do not change the persistent cwd", async () => {
		const h = setup();
		mkdirSync(join(h.cwd, "x"));
		const r = await h.run("Bash", { command: "cd x", run_in_background: true });
		expect(resultText(r)).toContain(`\nSession cwd remains ${h.cwd}; directory changes made by the backgrounded command do not apply to subsequent commands.`);
		await waitFor(() => h.events.some((e) => e.type === "background_shell_exited"));
		expect(await runText(h, { command: "pwd" })).toBe(h.cwd);
	});
});

describe("bash helpers", () => {
	it("OutputBuffer drops oldest text beyond the cap but keeps absolute offsets", () => {
		const b = new OutputBuffer(100);
		b.append("a".repeat(80));
		const cursor = b.end;
		b.append("b".repeat(50));
		expect(b.toString().length).toBeLessThanOrEqual(100);
		expect(b.end).toBe(130);
		expect(b.readFrom(cursor)).toEqual({ text: "b".repeat(50), lost: 0 });
	});

	it("buildScript runs the command on line 1", () => {
		const s = buildScript("echo 'hi'", "/tmp/it's");
		expect(s.split("\n")).toHaveLength(1);
		expect(s).toBe("exec 2>&1; eval 'echo '\\''hi'\\''' && pwd -P >| '/tmp/it'\\''s'");
	});

	it("formatClaudeDuration / truncateError / splitCommands / isErrorExit", () => {
		expect(formatClaudeDuration(500)).toBe("0s");
		expect(formatClaudeDuration(1500)).toBe("1s");
		expect(formatClaudeDuration(1_800_000, true)).toBe("30m");
		expect(formatClaudeDuration(90_000)).toBe("1m 30s");
		expect(truncateError("x".repeat(10))).toBe("x".repeat(10));
		expect(truncateError("a".repeat(6000) + "b".repeat(6000))).toBe(`${"a".repeat(5000)}\n\n... [2000 characters truncated] ...\n\n${"b".repeat(5000)}`);
		expect(splitCommands("a && b || c; d | e & f\ng 'x;y' \"p|q\"")).toEqual(["a", "b", "c", "d", "e", "f", "g 'x;y' \"p|q\""]);
		expect(isErrorExit("grep x f", 1)).toBe(false);
		expect(isErrorExit("grep x f", 2)).toBe(true);
		expect(isErrorExit("cat f | grep x", 1)).toBe(false);
		expect(isErrorExit("grep x f | cat", 1)).toBe(true);
		expect(isErrorExit("git -C dir diff --quiet", 1)).toBe(false);
		expect(isErrorExit("git status", 1)).toBe(true);
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
			expect(results[0].text).toContain("# Environment update");
			expect(results[1].text).toBe(join(realpathSync(t.cwd), "sub"));
			expect(results[1].isError).toBe(false);
			expect(results[2].isError).toBe(true);
			expect(results[2].text).toBe("Exit code 5");
		} finally {
			t.dispose();
		}
	});
});

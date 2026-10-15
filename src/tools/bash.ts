import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import type { CCContext } from "../shared/context.js";
import { sendReminder } from "../shared/reminders.js";
import { textResult } from "../shared/text.js";
import {
	OutputBuffer,
	buildScript,
	formatDuration,
	normalizeOutput,
	spawnShell,
	type SpawnedShell,
} from "./bash-process.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const UPDATE_THROTTLE_MS = 100;
/** Max characters sent in a single streaming progress update. */
const UPDATE_TAIL_CHARS = 50_000;

export type BackgroundShellStatus = "running" | "completed" | "failed" | "killed";

export interface BackgroundShell {
	id: string;
	command: string;
	description?: string;
	cwd: string;
	startTime: number;
	endTime?: number;
	status: BackgroundShellStatus;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	output: OutputBuffer;
	/** Absolute offset into `output` up to which the model has read. */
	cursor: number;
	/** The model has seen the final status via BashOutput (no completion notice needed). */
	finalSeen?: boolean;
	/** Exited while the agent was running; notify at agent_end unless finalSeen by then. */
	notifyPending?: boolean;
	proc: SpawnedShell;
}

export interface BashDetails {
	exitCode?: number | null;
	signal?: string | null;
	cwd?: string;
	timedOut?: boolean;
	interrupted?: boolean;
	backgroundTaskId?: string;
	droppedChars?: number;
}

function isDir(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

const BASH_DESCRIPTION = `Executes a given bash command and returns its output (stdout and stderr combined).

The working directory persists between commands, but shell state does not: environment variables, aliases and functions set in one command are NOT available in the next. The shell environment is initialized from the process environment.

IMPORTANT: Avoid using this tool to run \`find\`, \`grep\`, \`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\` commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience:
- File search: Use Glob (NOT find or ls)
- Content search: Use Grep (NOT grep or rg)
- Read files: Use Read (NOT cat/head/tail)
- Edit files: Use Edit (NOT sed/awk)
- Write files: Use Write (NOT echo >/cat <<EOF)
- Communication: Output text directly (NOT echo/printf)

# Instructions
- If your command will create new directories or files, first verify the parent directory exists and is the correct location.
- Always quote file paths that contain spaces with double quotes (e.g. cd "path with spaces/file.txt").
- Try to maintain your current working directory throughout the session by using absolute paths and avoiding usage of \`cd\`. You may use \`cd\` if the user explicitly requests it.
- You may specify an optional timeout in milliseconds (up to {MAX}ms / {MAXMIN} minutes). By default, your command will timeout after {DEF}ms ({DEFMIN} minutes).
- Commands run non-interactively with stdin connected to /dev/null. Interactive flags (e.g. \`git rebase -i\`, \`git add -i\`) are not supported.
- If the output is very long it may be saved to a file and only a preview returned; read the file for the full output.
- You can use the \`run_in_background\` parameter to run the command in the background. Only use this if you don't need the result immediately and are OK being notified when the command completes later. You do not need to check the output right away - you'll be notified when it finishes. Use BashOutput to read the output and KillShell to stop it. You do not need to use '&' at the end of the command when using this parameter.
- Write a clear, concise description of what your command does in the \`description\` parameter.
- When issuing multiple commands:
  - If the commands are independent and can run in parallel, make multiple Bash tool calls in a single message.
  - If the commands depend on each other and must run sequentially, use a single Bash call with '&&' to chain them together.
  - Use ';' only when you need to run commands sequentially but don't care if earlier commands fail.
  - DO NOT use newlines to separate commands (newlines are ok in quoted strings).
- A non-zero exit code is reported as an error, together with the command's output.
- Avoid unnecessary \`sleep\` commands: do not sleep between commands that can run immediately, and do not retry failing commands in a sleep loop - diagnose the root cause instead.

# Git
- Commit or push only when the user asks. Prefer creating a new commit rather than amending an existing one.
- Never run destructive git commands (push --force, reset --hard, checkout ., clean -f, branch -D) unless the user explicitly requests them, and never skip hooks (--no-verify) unless asked.
- When staging files, prefer adding specific files by name rather than "git add -A" or "git add .".
- Use the gh CLI for GitHub tasks (pull requests, issues, checks, releases).`;

function bashDescription(defMs: number, maxMs: number): string {
	const min = (ms: number) => String(Math.round((ms / 60000) * 10) / 10);
	return BASH_DESCRIPTION.replace("{MAX}", String(maxMs))
		.replace("{MAXMIN}", min(maxMs))
		.replace("{DEF}", String(defMs))
		.replace("{DEFMIN}", min(defMs));
}

const BASH_OUTPUT_DESCRIPTION = `- Retrieves output from a running or completed background bash shell
- Takes a bash_id parameter identifying the shell
- Always returns only new output since the last check
- Returns the output (stdout and stderr combined) along with shell status and exit code
- Supports optional regex filtering to show only lines matching a pattern
- Use this tool when you need to monitor or check the output of a long-running shell
- Shell IDs are returned by the Bash tool when run_in_background is true`;

const KILL_SHELL_DESCRIPTION = `- Kills a running background bash shell by its ID
- Takes a shell_id parameter identifying the shell to kill
- Returns a success or failure status
- Use this tool when you need to terminate a long-running shell
- Shell IDs are returned by the Bash tool when run_in_background is true`;

export function registerBash(pi: ExtensionAPI, cc: CCContext): void {
	const maxTimeout = Math.max(cc.options.bash?.maxTimeoutMs ?? MAX_TIMEOUT_MS, 1);
	const defaultTimeout = Math.min(cc.options.bash?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS, maxTimeout);

	/** Persistent shell cwd for this session (undefined until the first command). */
	let shellCwd: string | undefined;
	const shells = new Map<string, BackgroundShell>();
	let nextShellId = 1;
	let shuttingDown = false;
	let agentRunning = false;

	function resolveCwd(baseCwd: string): { cwd: string; resetNote?: string } {
		if (shellCwd && isDir(shellCwd)) return { cwd: shellCwd };
		const prev = shellCwd;
		shellCwd = baseCwd;
		return { cwd: baseCwd, resetNote: prev ? `Shell cwd was reset to ${baseCwd} (previous directory ${prev} no longer exists)` : undefined };
	}

	function clampTimeout(t: number | undefined): number {
		if (t === undefined || !Number.isFinite(t) || t <= 0) return defaultTimeout;
		return Math.min(Math.max(Math.floor(t), 1), maxTimeout);
	}

	function knownIds(): string {
		return shells.size ? [...shells.keys()].join(", ") : "(none)";
	}

	// ---------------------------------------------------------------- Bash (foreground)
	async function runForeground(
		command: string,
		timeoutMs: number,
		baseCwd: string,
		signal: AbortSignal | undefined,
		onUpdate: ((r: AgentToolResult<BashDetails>) => void) | undefined,
	): Promise<AgentToolResult<BashDetails>> {
		if (signal?.aborted) throw new Error("Command was aborted before execution");
		const { cwd, resetNote } = resolveCwd(baseCwd);
		const cwdFile = join(tmpdir(), `pi-cc-cwd-${process.pid}-${randomBytes(6).toString("hex")}`);
		const output = new OutputBuffer();

		let updateTimer: NodeJS.Timeout | undefined;
		let lastUpdate = 0;
		const flushUpdate = () => {
			updateTimer = undefined;
			lastUpdate = Date.now();
			try {
				onUpdate?.({ content: [{ type: "text", text: output.tail(UPDATE_TAIL_CHARS) }], details: { cwd } });
			} catch {
				// progress consumers must not break execution
			}
		};
		const onData = (text: string) => {
			output.append(text);
			if (!onUpdate || updateTimer) return;
			const delay = UPDATE_THROTTLE_MS - (Date.now() - lastUpdate);
			if (delay <= 0) flushUpdate();
			else updateTimer = setTimeout(flushUpdate, delay);
		};

		const proc = spawnShell(buildScript(command, cwdFile), cwd, onData);
		let timedOut = false;
		let interrupted = false;
		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill();
		}, timeoutMs);
		const onAbort = () => {
			interrupted = true;
			proc.kill();
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		let exit: { exitCode: number | null; signal: NodeJS.Signals | null };
		try {
			exit = await proc.done;
		} finally {
			clearTimeout(timer);
			if (updateTimer) clearTimeout(updateTimer);
			signal?.removeEventListener("abort", onAbort);
		}

		// Update the persistent cwd from the side channel (written by the EXIT trap).
		try {
			if (existsSync(cwdFile)) {
				const newCwd = readFileSync(cwdFile, "utf8").trim();
				if (newCwd && isDir(newCwd)) shellCwd = newCwd;
			}
		} catch {
			// ignore
		} finally {
			try {
				rmSync(cwdFile, { force: true });
			} catch {
				// ignore
			}
		}

		let text = normalizeOutput(output.toString());
		if (output.droppedChars > 0) {
			text = `[... ${output.droppedChars} characters of earlier output dropped (in-memory limit) ...]\n${text}`;
		}
		const notes = resetNote ? [resetNote] : [];

		if (interrupted) throw new Error(joinParts(text, "Command was aborted before completion", ...notes));
		if (timedOut) throw new Error(joinParts(text, `Command timed out after ${formatDuration(timeoutMs)}`, ...notes));
		if (exit.exitCode !== 0) {
			const status = exit.exitCode === null ? `Command terminated by signal ${exit.signal ?? "unknown"}` : `Exit code ${exit.exitCode}`;
			throw new Error([status, text, ...notes].filter(Boolean).join("\n"));
		}
		return textResult<BashDetails>(joinParts(text, ...notes) || "(No output)", {
			exitCode: exit.exitCode,
			cwd: shellCwd,
			droppedChars: output.droppedChars || undefined,
		});
	}

	// ---------------------------------------------------------------- Bash (background)
	function startBackground(command: string, description: string | undefined, baseCwd: string): AgentToolResult<BashDetails> {
		const { cwd } = resolveCwd(baseCwd);
		const id = `bash_${nextShellId++}`;
		const output = new OutputBuffer();
		const proc = spawnShell(buildScript(command), cwd, (t) => output.append(t));
		const shell: BackgroundShell = {
			id,
			command,
			description,
			cwd,
			startTime: Date.now(),
			status: "running",
			exitCode: null,
			signal: null,
			output,
			cursor: 0,
			proc,
		};
		shells.set(id, shell);
		cc.emit({ type: "background_shell_started", shellId: id, command });

		proc.done.then(
			({ exitCode, signal }) => onBackgroundExit(shell, exitCode, signal),
			(err: Error) => {
				output.append(`\n${err.message}\n`);
				onBackgroundExit(shell, null, null);
			},
		);

		return textResult<BashDetails>(
			`Command running in background with ID: ${id}. Use the BashOutput tool with bash_id "${id}" to read its output, and KillShell to stop it. You will be notified when it completes.`,
			{ backgroundTaskId: id, cwd },
		);
	}

	function onBackgroundExit(shell: BackgroundShell, exitCode: number | null, signal: NodeJS.Signals | null): void {
		shell.endTime = Date.now();
		shell.exitCode = exitCode;
		shell.signal = signal;
		const wasKilled = shell.status === "killed";
		if (!wasKilled) shell.status = exitCode === 0 ? "completed" : "failed";
		cc.emit({ type: "background_shell_exited", shellId: shell.id, exitCode, signal });
		// No wake-up for shells the model (or shutdown) killed on purpose.
		if (wasKilled || shuttingDown) return;
		// While the agent is running, the model may still pick up the result with BashOutput;
		// defer the wake-up to agent_end so we don't trigger a redundant extra turn.
		if (agentRunning) {
			shell.notifyPending = true;
			return;
		}
		notifyExit(shell);
	}

	function notifyExit(shell: BackgroundShell): void {
		shell.notifyPending = false;
		const { exitCode, signal } = shell;
		const how =
			exitCode === null
				? `was terminated by signal ${signal ?? "unknown"}`
				: `has ${exitCode === 0 ? "completed" : "failed"} with exit code ${exitCode}`;
		try {
			sendReminder(
				pi,
				`Background Bash ${shell.id} (command: ${truncateCmd(shell.command)}) ${how}. Use BashOutput with bash_id "${shell.id}" to read the output.`,
				{ wake: true, details: { shellId: shell.id, exitCode, signal } },
			);
		} catch {
			// session may already be gone
		}
	}

	pi.registerTool({
		name: "Bash",
		label: "Bash",
		description: bashDescription(defaultTimeout, maxTimeout),
		promptSnippet: "Execute shell commands (persistent working directory, optional background execution)",
		parameters: Type.Object({
			command: Type.String({ description: "The command to execute" }),
			timeout: Type.Optional(Type.Number({ description: `Optional timeout in milliseconds (max ${maxTimeout})` })),
			description: Type.Optional(
				Type.String({
					description: `Clear, concise description of what this command does in active voice. Never use words like "complex" or "risk" in the description - just describe what it does.

For simple commands (git, npm, standard CLI tools), keep it brief (5-10 words):
- ls → "List files in current directory"
- git status → "Show working tree status"
- npm install → "Install package dependencies"

For commands that are harder to parse at a glance (piped commands, obscure flags, etc.), add enough context to clarify what it does:
- find . -name "*.tmp" -exec rm {} \\; → "Find and delete all .tmp files recursively"
- git reset --hard origin/main → "Discard all local changes and match remote main"
- curl -s url | jq '.data[]' → "Fetch JSON from URL and extract data array elements"`,
				}),
			),
			run_in_background: Type.Optional(
				Type.Boolean({ description: "Set to true to run this command in the background. Use BashOutput to read the output later." }),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const command = params.command;
			if (typeof command !== "string" || !command.trim()) throw new Error("command must be a non-empty string");
			if (params.run_in_background) return startBackground(command, params.description, ctx.cwd);
			return runForeground(command, clampTimeout(params.timeout), ctx.cwd, signal, onUpdate as any);
		},
	});

	// ---------------------------------------------------------------- BashOutput
	pi.registerTool({
		name: "BashOutput",
		label: "BashOutput",
		description: BASH_OUTPUT_DESCRIPTION,
		parameters: Type.Object({
			bash_id: Type.String({ description: "The ID of the background shell to retrieve output from" }),
			filter: Type.Optional(
				Type.String({
					description:
						"Optional regular expression to filter the output lines. Only lines matching this regex will be included in the result. Any lines that do not match will no longer be available to read.",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const shell = shells.get(params.bash_id);
			if (!shell) throw new Error(`No background shell found with ID: ${params.bash_id}. Known shell IDs: ${knownIds()}`);

			let regex: RegExp | undefined;
			if (params.filter) {
				try {
					regex = new RegExp(params.filter);
				} catch (e) {
					throw new Error(`Invalid filter regex: ${(e as Error).message}`);
				}
			}

			// Snapshot status before reading so "completed" always comes with the complete output.
			const status = shell.status;
			const { text: raw, lost } = shell.output.readFrom(shell.cursor);
			let consumed = raw;
			if (regex && status === "running") {
				// Hold back an incomplete trailing line so a partially written line isn't filtered prematurely.
				const nl = raw.lastIndexOf("\n");
				consumed = nl === -1 ? "" : raw.slice(0, nl + 1);
			}
			shell.cursor = shell.output.end - (raw.length - consumed.length);

			let newOutput = consumed;
			if (regex) {
				const lines = consumed.split("\n");
				if (lines.at(-1) === "") lines.pop();
				newOutput = lines.filter((line) => regex!.test(line)).join("\n");
			}
			newOutput = newOutput.replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd();

			const parts = [`<status>${status}</status>`];
			if (status !== "running") {
				shell.finalSeen = true;
				shell.notifyPending = false;
				parts.push(shell.exitCode === null ? `<signal>${shell.signal ?? "unknown"}</signal>` : `<exit_code>${shell.exitCode}</exit_code>`);
			}
			if (lost > 0) parts.push(`<warning>${lost} characters of output were dropped before they could be read (in-memory limit)</warning>`);
			parts.push(newOutput ? `<output>\n${newOutput}\n</output>` : "<output>(No new output)</output>");
			parts.push(`<timestamp>${new Date().toISOString()}</timestamp>`);
			return textResult(parts.join("\n\n"), {
				shellId: shell.id,
				status,
				exitCode: shell.exitCode,
				command: shell.command,
			});
		},
	});

	// ---------------------------------------------------------------- KillShell
	pi.registerTool({
		name: "KillShell",
		label: "KillShell",
		description: KILL_SHELL_DESCRIPTION,
		parameters: Type.Object({
			shell_id: Type.String({ description: "The ID of the background shell to kill" }),
		}),
		async execute(_toolCallId, params) {
			const shell = shells.get(params.shell_id);
			if (!shell) throw new Error(`No background shell found with ID: ${params.shell_id}. Known shell IDs: ${knownIds()}`);
			if (shell.status !== "running") {
				const how =
					shell.status === "killed"
						? "was already killed"
						: `has already finished (status: ${shell.status}, ${shell.exitCode === null ? `signal: ${shell.signal}` : `exit code: ${shell.exitCode}`})`;
				throw new Error(`Shell ${shell.id} is not running: it ${how}.`);
			}
			shell.status = "killed";
			shell.proc.kill();
			return textResult(`Successfully killed shell: ${shell.id} (${truncateCmd(shell.command)})`, { shellId: shell.id });
		},
	});

	pi.on("agent_start", async () => {
		agentRunning = true;
	});
	pi.on("agent_end", async () => {
		agentRunning = false;
		// Defer so the agent loop has fully settled (idle) before we possibly start a new turn.
		setTimeout(() => {
			if (shuttingDown || agentRunning) return;
			for (const shell of shells.values()) {
				if (shell.notifyPending && !shell.finalSeen) notifyExit(shell);
			}
		}, 0);
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		for (const shell of shells.values()) {
			if (shell.status === "running") {
				shell.status = "killed";
				shell.proc.kill();
			}
		}
	});
}

function joinParts(...parts: Array<string | undefined>): string {
	return parts.filter(Boolean).join("\n\n");
}

function truncateCmd(cmd: string, max = 200): string {
	const one = cmd.replace(/\s+/g, " ").trim();
	return one.length > max ? `${one.slice(0, max)}…` : one;
}

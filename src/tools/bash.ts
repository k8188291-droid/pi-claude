import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { HostFileSystem, HostProcess, HostProcessExit } from "../host/types.js";
import { asBuffer, FileAppender, newTaskId, type BackgroundTask } from "../shared/background.js";
import type { CCContext } from "../shared/context.js";
import { formatTaskNotification } from "../shared/notifications.js";
import { isFixed } from "../shared/quirks.js";
import { formatPersistedOutput, makePreview } from "../output-spill.js";
import { textResult } from "../shared/text.js";
import { claudeInputValidator, type Spec } from "./input-validation.js";
import { OutputBuffer, buildScript, formatClaudeDuration } from "./bash-process.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** With run_in_background, `timeout` is how long the command may run in the background. */
const BACKGROUND_DEFAULT_TIMEOUT_MS = 1_800_000;
const BACKGROUND_MAX_TIMEOUT_MS = 7_200_000;
/** Output kept in memory for a failed command's result (Claude Code's BASH_MAX_OUTPUT_LENGTH). */
const MAX_OUTPUT_CHARS = 30_000;
/** Claude Code truncates tool error text to this many characters (head + tail). */
const MAX_ERROR_CHARS = 10_000;
/** Exit code Claude Code reports for a foreground command killed at its timeout. */
const TIMEOUT_EXIT_CODE = 143;
const UPDATE_THROTTLE_MS = 100;
/** Max characters sent in a single streaming progress update. */
const UPDATE_TAIL_CHARS = 50_000;

const NO_OUTPUT = "(Bash completed with no output)";
const ABORTED = "<error>Command was aborted before completion</error>";
const BG_CWD_NOTE = "directory changes made by the backgrounded command do not apply to subsequent commands.";
const DEADLINE_NOTE =
	"If the work in progress still needs it, start it again with `run_in_background` and a longer `timeout`. If it already had the longest `timeout` allowed, do not restart it. Either way, report that it was stopped.";

/** Commands whose first word keeps them from being moved to the background at their timeout. */
const NO_AUTO_BACKGROUND = new Set(["sleep"]);
/** Commands for which exit code 1 is not an error (only >= 2 is). Keyed by the last command's first word. */
const EXIT_1_OK = new Set(["grep", "rg", "egrep", "fgrep", "find", "diff", "test", "["]);
const CD_COMMANDS = new Set(["cd", "pushd", "popd", "chdir"]);
/** Formatter/fixer commands after which Claude Code checks for previously read files they modified. */
const FORMATTER_RE = new RegExp(
	[
		"--write", "--fix", "--in-place", "--auto-correct", "\\brun\\s+format\\b", "\\brun\\s+fix\\b", "\\b(yarn|pnpm)\\s+format\\b",
		"\\blint:file\\b", "\\blint:fix\\b", "\\bblack\\b", "\\bisort\\b", "\\bruff\\s+format\\b", "\\bcargo\\s+(fmt|fix)\\b",
		"\\brustfmt\\b", "\\bgo\\s+fmt\\b", "\\bterraform\\s+fmt\\b", "\\bdprint\\s+fmt\\b", "\\bswiftformat\\b", "\\bphpcbf\\b",
	].join("|"),
);

/** Claude Code's zod schema for Bash input (strict: unknown keys are rejected). */
const BashSpec: Spec = {
	kind: "object",
	strict: true,
	props: {
		command: { spec: { kind: "string" } },
		timeout: { spec: { kind: "unknown" }, optional: true },
		description: { spec: { kind: "string" }, optional: true },
		run_in_background: { spec: { kind: "boolean" }, optional: true },
		dangerouslyDisableSandbox: { spec: { kind: "boolean" }, optional: true },
	},
};

interface BashInput {
	command: string;
	timeout?: unknown;
	description?: string;
	run_in_background?: boolean;
	dangerouslyDisableSandbox?: boolean;
}

export interface BashDetails {
	exitCode?: number | null;
	signal?: string | null;
	cwd?: string;
	timedOut?: boolean;
	interrupted?: boolean;
	backgroundTaskId?: string;
	outputFile?: string;
}

const BASH_DESCRIPTION = `Executes a given bash command and returns its output.

The working directory persists between commands, but shell state does not. The shell environment is initialized from the user's profile (bash or zsh).

IMPORTANT: Avoid using this tool to run \`find\`, \`grep\`, \`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\` commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user:

 - File search: Use Glob (NOT find or ls)
 - Content search: Use Grep (NOT grep or rg)
 - Read files: Use Read (NOT cat/head/tail)
 - Edit files: Use Edit (NOT sed/awk)
 - Write files: Use Write (NOT echo >/cat <<EOF)
 - Communication: Output text directly (NOT echo/printf)
While the Bash tool can do similar things, it’s better to use the built-in tools as they provide a better user experience and make it easier to review tool calls and give permission.

# Instructions
 - If your command will create new directories or files, first use this tool to run \`ls\` to verify the parent directory exists and is the correct location.
 - Always quote file paths that contain spaces with double quotes in your command (e.g., cd "path with spaces/file.txt")
 - Try to maintain your current working directory throughout the session by using absolute paths and avoiding usage of \`cd\`. You may use \`cd\` if the User explicitly requests it. In particular, never prepend \`cd <current-directory>\` to a \`git\` command — \`git\` already operates on the current working tree, and the compound triggers a permission prompt.
 - You may specify an optional timeout in milliseconds (up to {MAX} for a foreground command). By default, your command will timeout after {DEF}.
 - You can use the \`run_in_background\` parameter to run the command in the background. Only use this if you don't need the result immediately and are OK being notified when the command completes later. You do not need to check the output right away - you'll be notified when it finishes. You do not need to use '&' at the end of the command when using this parameter. With \`run_in_background\` the timeout is instead how long the command may run in the background (default {BGDEF}, max {BGMAX}); at that limit it is stopped and you are notified.
 - For git commands:
  - Prefer to create a new commit rather than amending an existing commit.
  - Before running destructive operations (e.g., git reset --hard, git push --force, git checkout --), consider whether there is a safer alternative that achieves the same goal. Only use destructive operations when they are truly the best approach.
  - Never skip hooks (--no-verify) or bypass signing (--no-gpg-sign, -c commit.gpgsign=false) unless the user has explicitly asked for it. If a hook fails, investigate and fix the underlying issue.
 - Avoid unnecessary \`sleep\` commands:
  - Do not sleep between commands that can run immediately — just run them.
  - If your command is long running and you would like to be notified when it finishes — use \`run_in_background\`. No sleep needed.
  - Do not retry failing commands in a sleep loop — diagnose the root cause.
  - If waiting for a background task you started with \`run_in_background\`, you will be notified when it completes — do not poll.
  - If you must poll an external process, use a check command (e.g. \`gh run view\`) rather than sleeping first.
  - If you must sleep, keep the duration short to avoid blocking the user.


# Committing changes with git

Only create commits when requested by the user. If unclear, ask first. When the user asks you to create a new git commit, follow these steps carefully:

You can call multiple tools in a single response. When multiple independent pieces of information are requested and all commands are likely to succeed, run multiple tool calls in parallel for optimal performance. The numbered steps below indicate which commands should be batched in parallel.

Git Safety Protocol:
- NEVER update the git config
- NEVER run destructive git commands (push --force, reset --hard, checkout ., restore ., clean -f, branch -D) unless the user explicitly requests these actions. Taking unauthorized destructive actions is unhelpful and can result in lost work, so it's best to ONLY run these commands when given direct instructions 
- NEVER skip hooks (--no-verify, --no-gpg-sign, etc) unless the user explicitly requests it
- NEVER run force push to main/master, warn the user if they request it
- CRITICAL: Always create NEW commits rather than amending, unless the user explicitly requests a git amend. When a pre-commit hook fails, the commit did NOT happen — so --amend would modify the PREVIOUS commit, which may result in destroying work or losing previous changes. Instead, after hook failure, fix the issue, re-stage, and create a NEW commit
- When staging files, prefer adding specific files by name rather than using "git add -A" or "git add .", which can accidentally include sensitive files (.env, credentials) or large binaries
- NEVER commit changes unless the user explicitly asks you to. It is VERY IMPORTANT to only commit when explicitly asked, otherwise the user will feel that you are being too proactive

1. Run the following bash commands in parallel, each using the Bash tool:
  - Run a git status command to see all untracked files. IMPORTANT: Never use the -uall flag as it can cause memory issues on large repos.
  - Run a git diff command to see both staged and unstaged changes that will be committed.
  - Run a git log command to see recent commit messages, so that you can follow this repository's commit message style.
2. Analyze all staged changes (both previously staged and newly added) and draft a commit message:
  - Summarize the nature of the changes (eg. new feature, enhancement to an existing feature, bug fix, refactoring, test, docs, etc.). Ensure the message accurately reflects the changes and their purpose (i.e. "add" means a wholly new feature, "update" means an enhancement to an existing feature, "fix" means a bug fix, etc.).
  - Do not commit files that likely contain secrets (.env, credentials.json, etc). Warn the user if they specifically request to commit those files
  - Draft a concise (1-2 sentences) commit message that focuses on the "why" rather than the "what"
  - Ensure it accurately reflects the changes and their purpose
3. Run the following commands in parallel:
   - Add relevant untracked files to the staging area.
   - Create the commit with a message, ending with the attribution lines given in the conversation's system-reminder, when one is present.
   - Run git status after the commit completes to verify success.
   Note: git status depends on the commit completing, so run it sequentially after the commit.
4. If the commit fails due to pre-commit hook: fix the issue and create a NEW commit

Important notes:
- NEVER run additional commands to read or explore code, besides git bash commands
- NEVER use the TaskCreate or Agent tools
- DO NOT push to the remote repository unless the user explicitly asks you to do so
- IMPORTANT: Never use git commands with the -i flag (like git rebase -i or git add -i) since they require interactive input which is not supported.
- IMPORTANT: Do not use --no-edit with git rebase commands, as the --no-edit flag is not a valid option for git rebase.
- If there are no changes to commit (i.e., no untracked files and no modifications), do not create an empty commit
- In order to ensure good formatting, ALWAYS pass the commit message via a HEREDOC, a la this example:
<example>
git commit -m "$(cat <<'EOF'
   Commit message here.
   EOF
   )"
</example>

# Creating pull requests
Use the gh command via the Bash tool for ALL GitHub-related tasks including working with issues, pull requests, checks, and releases. If given a Github URL use the gh command to get the information needed.

IMPORTANT: When the user asks you to create a pull request, follow these steps carefully:

1. Run the following bash commands in parallel using the Bash tool, in order to understand the current state of the branch since it diverged from the main branch:
   - Run a git status command to see all untracked files (never use -uall flag)
   - Run a git diff command to see both staged and unstaged changes that will be committed
   - Check if the current branch tracks a remote branch and is up to date with the remote, so you know if you need to push to the remote
   - Run a git log command and \`git diff [base-branch]...HEAD\` to understand the full commit history for the current branch (from the time it diverged from the base branch)
2. Analyze all changes that will be included in the pull request, making sure to look at all relevant commits (NOT just the latest commit, but ALL commits that will be included in the pull request!!!), and draft a pull request title and summary:
   - Keep the PR title short (under 70 characters)
   - Use the description/body for details, not the title
3. Run the following commands in parallel:
   - Create new branch if needed
   - Push to remote with -u flag if needed
   - Create PR using gh pr create with the format below. Use a HEREDOC to pass the body to ensure correct formatting. End the body with the attribution lines given in the conversation's system-reminder, when one is present.
<example>
gh pr create --title "the pr title" --body "$(cat <<'EOF'
## Summary
<1-3 bullet points>

## Test plan
[Bulleted markdown checklist of TODOs for testing the pull request...]
EOF
)"
</example>

Important:
- DO NOT use the TaskCreate or Agent tools
- Return the PR URL when you're done, so the user can see it

# Other common operations
- View comments on a Github PR: gh api repos/foo/bar/pulls/123/comments`;

function minutesLabel(ms: number): string {
	const min = ms / 60000;
	if (min >= 60 && min % 60 === 0) return `${min / 60} ${min === 60 ? "hour" : "hours"}`;
	const n = Number.isInteger(min) ? String(min) : String(Math.round(min * 10) / 10);
	return `${n} ${min === 1 ? "minute" : "minutes"}`;
}

function bashDescription(defMs: number, maxMs: number): string {
	return BASH_DESCRIPTION.replace("{MAX}", `${maxMs}ms / ${minutesLabel(maxMs)}`)
		.replace("{DEF}", `${defMs}ms (${minutesLabel(defMs)})`)
		.replace("{BGDEF}", `${BACKGROUND_DEFAULT_TIMEOUT_MS}ms / ${minutesLabel(BACKGROUND_DEFAULT_TIMEOUT_MS)}`)
		.replace("{BGMAX}", `${BACKGROUND_MAX_TIMEOUT_MS}ms / ${minutesLabel(BACKGROUND_MAX_TIMEOUT_MS)}`);
}

const DESCRIPTION_PARAM = `Clear, concise description of what this command does in active voice. Never use words like "complex" or "risk" in the description - just describe what it does.

Say what the command does in plain words: do not echo the command's text, its flags, or file paths - the user reads this description, often without seeing the command.

For simple commands (git, npm, standard CLI tools), keep it brief (5-10 words):
- ls → "List files in current directory"
- git status → "Show working tree status"
- npm install → "Install package dependencies"

For commands that are harder to parse at a glance (piped commands, obscure flags, etc.), add enough context to clarify what it does:
- find . -name "*.tmp" -exec rm {} \; → "Find and delete all .tmp files recursively"
- git reset --hard origin/main → "Discard all local changes and match remote main"
- curl -s url | jq '.data[]' → "Fetch JSON from URL and extract data array elements"`;

// ------------------------------------------------------------------ command analysis

/** Split a command line into simple commands at unquoted `&&`, `||`, `;`, `|`, `&` and newlines. */
export function splitCommands(command: string): string[] {
	const parts: string[] = [];
	let cur = "";
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			cur += ch;
			if (ch === "\\" && quote === '"' && i + 1 < command.length) cur += command[++i];
			else if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			cur += ch + command[++i];
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			cur += ch;
			continue;
		}
		if (ch === ";" || ch === "|" || ch === "&" || ch === "\n" || ch === "\r") {
			if ((ch === "|" || ch === "&") && command[i + 1] === ch) i++;
			if (cur.trim()) parts.push(cur.trim());
			cur = "";
			continue;
		}
		cur += ch;
	}
	if (cur.trim()) parts.push(cur.trim());
	return parts;
}

const firstWord = (s: string) => s.trim().split(/\s+/)[0] ?? "";

/** Claude Code's exit-code interpretation: for grep/find/diff/test (and git diff/grep), exit 1 is not an error. */
export function isErrorExit(command: string, exitCode: number): boolean {
	if (exitCode === 0) return false;
	const last = splitCommands(command).at(-1) ?? command;
	const words = last.trim().split(/\s+/);
	let exit1Ok = EXIT_1_OK.has(words[0] ?? "");
	if (words[0] === "git") {
		for (let i = 1; i < words.length; i++) {
			const w = words[i];
			if (w.startsWith("-")) {
				if (w === "-C" || w === "-c") i++;
				continue;
			}
			exit1Ok = w === "diff" || w === "grep";
			break;
		}
	}
	return exit1Ok ? exitCode >= 2 : true;
}

function canAutoBackground(command: string): boolean {
	const first = splitCommands(command)[0];
	return first === undefined || !NO_AUTO_BACKGROUND.has(firstWord(first));
}

function changesDirectory(command: string): boolean {
	return splitCommands(command).some((c) => CD_COMMANDS.has(firstWord(c)));
}

/** Claude Code's tool-error truncation: keep the first and last 5000 characters. */
export function truncateError(text: string, max = MAX_ERROR_CHARS): string {
	if (text.length <= max) return text;
	const half = Math.floor(max / 2);
	return `${text.slice(0, half)}\n\n... [${text.length - max} characters truncated] ...\n\n${text.slice(-half)}`;
}

function escapeXml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Claude Code's exit code for a process that ended by signal. */
function exitCodeOf(exit: HostProcessExit): number {
	if (exit.exitCode !== null) return exit.exitCode;
	return exit.signal === "SIGTERM" ? 144 : 1;
}

async function isDir(fs: HostFileSystem, p: string): Promise<boolean> {
	try {
		return (await fs.stat(p)).isDirectory;
	} catch {
		return false;
	}
}

async function exists(fs: HostFileSystem, p: string): Promise<boolean> {
	try {
		await fs.stat(p);
		return true;
	} catch {
		return false;
	}
}

async function isGitRepo(fs: HostFileSystem, dir: string): Promise<boolean> {
	for (let d = dir; ; d = dirname(d)) {
		if (await exists(fs, join(d, ".git"))) return true;
		if (dirname(d) === d) return false;
	}
}

async function realpathOr(fs: HostFileSystem, p: string): Promise<string> {
	try {
		return await fs.realpath(p);
	} catch {
		return p;
	}
}

function isWithin(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// ------------------------------------------------------------------ running commands

/**
 * A spawned command. Its complete output is streamed to `outputFile` from the start (so nothing is
 * ever lost, whatever its size); the in-memory buffer only serves the inline result and progress
 * updates of a foreground command.
 */
interface ShellRun {
	/** Task id, allocated up front (the output file is named after it, like Claude Code). */
	id: string;
	proc: HostProcess;
	/** Retained tail of the output (foreground only; capped at OUTPUT_HARD_CAP). */
	output: OutputBuffer;
	/** First MAX_OUTPUT_CHARS characters of output (what a failed command's result shows). */
	head: string;
	/** File with the complete output (undefined if it could not be created for a foreground run). */
	outputFile?: string;
	/** Writes to `outputFile` while the command runs (queued, in order). */
	file?: FileAppender;
	/** A write to the output file failed: the file is incomplete. */
	fileFailed?: boolean;
	/** Running as a background task: output goes to the file only. */
	background: boolean;
	onData?: (text: string) => void;
	done: Promise<HostProcessExit>;
}

/** Stop writing the run's output file once what was written so far is in it (idempotent, never throws). */
async function closeRunFile(run: ShellRun): Promise<void> {
	const file = run.file;
	if (!file) return;
	await file.close();
	if (file.failed) run.fileFailed = true;
	if (run.file === file) run.file = undefined;
}

/** Append to the run's output file; after a write error the file is marked incomplete and left alone. */
function writeRunFile(run: ShellRun, text: string): void {
	if (!run.file || !text) return;
	if (run.file.failed) {
		run.fileFailed = true;
		run.file = undefined;
		return;
	}
	run.file.write(text);
}

async function removeFile(fs: HostFileSystem, path: string | undefined): Promise<void> {
	if (!path) return;
	try {
		await fs.rm(path, { force: true });
	} catch {
		// ignore
	}
}

export function registerBash(pi: ExtensionAPI, cc: CCContext): void {
	const maxTimeout = Math.max(cc.options.bash?.maxTimeoutMs ?? MAX_TIMEOUT_MS, 1);
	const defaultTimeout = Math.min(cc.options.bash?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS, maxTimeout);

	/** Persistent shell cwd for this session (undefined until the first command). */
	let shellCwd: string | undefined;
	/** Working directory the model was last told about (environment-update reminders). */
	let announcedCwd: string | undefined;
	const live = new Set<ShellRun>();
	let shuttingDown = false;
	const errexit = isFixed(cc, "bashErrexit");
	const killGroupOnExit = isFixed(cc, "orphanProcesses");
	const spillOpts = cc.options.outputSpill;
	const host = cc.host;
	const fs = host.fs;
	const previewChars = Math.max(0, (spillOpts === false ? undefined : spillOpts?.previewChars) ?? 2_000);

	/**
	 * Create the output file, then spawn. A background run needs its file: if it cannot be created
	 * the error is thrown before anything is started. A foreground run falls back to memory only.
	 */
	async function startRun(
		command: string,
		cwd: string,
		opts: { background: boolean; cwdFile?: string; cancelled: () => boolean },
	): Promise<ShellRun> {
		const id = newTaskId("local_bash");
		const run = { id, output: new OutputBuffer(), head: "", background: opts.background } as ShellRun;
		try {
			const file = await cc.tasks.createOutputFile(id);
			run.outputFile = file.path;
			run.file = new FileAppender(fs, file.path);
		} catch (err) {
			if (opts.background) throw err;
		}
		const onData = (text: string) => {
			writeRunFile(run, text);
			if (!run.background) {
				run.output.append(text);
				if (run.head.length < MAX_OUTPUT_CHARS) run.head += text.slice(0, MAX_OUTPUT_CHARS - run.head.length);
			}
			run.onData?.(text);
		};
		try {
			// the call was cancelled while its output file was being created: start nothing
			if (opts.cancelled()) throw new Error(ABORTED);
			run.proc = host.shell.spawn(buildScript(command, opts.cwdFile, { errexit }), { cwd, env: host.env, killGroupOnExit });
		} catch (err) {
			await closeRunFile(run);
			await removeFile(fs, run.outputFile);
			throw err;
		}
		run.proc.onStdout(onData);
		run.proc.onStderr(onData);
		run.done = run.proc.exited.catch((err: Error) => {
			onData(`${err.message}\n`);
			return { exitCode: 127, signal: null };
		});
		return run;
	}

	/**
	 * Private side-channel file for the final working directory (falls back to the host's temp
	 * directory; undefined, so the cwd is not tracked, when there is none).
	 */
	async function cwdFilePath(id: string): Promise<string | undefined> {
		try {
			return join(await cc.tasks.outputDir(), `${id}.cwd`);
		} catch {
			try {
				return join(host.tmpDir, `pi-cc-cwd-${process.pid}-${randomBytes(6).toString("hex")}`);
			} catch {
				return undefined;
			}
		}
	}

	async function resolveCwd(baseCwd: string): Promise<string> {
		announcedCwd ??= baseCwd;
		if (!shellCwd || !(await isDir(fs, shellCwd))) shellCwd = baseCwd;
		return shellCwd;
	}

	function clampTimeout(t: number | undefined, def: number, max: number): number {
		if (t === undefined || !Number.isFinite(t) || t <= 0) return Math.min(def, max);
		return Math.min(Math.max(Math.floor(t), 1), max);
	}

	/** "# Environment update" reminder when the shell cwd changed since the model was last told. */
	async function environmentUpdate(): Promise<string | undefined> {
		if (!shellCwd || !announcedCwd || shellCwd === announcedCwd) return undefined;
		const now = shellCwd;
		const lines = [` - Primary working directory: ${now} (was ${announcedCwd})`];
		const wasGit = await isGitRepo(fs, announcedCwd);
		const isGit = await isGitRepo(fs, now);
		if (wasGit !== isGit) lines.push(` - Is a git repository: ${isGit} (was ${wasGit})`);
		announcedCwd = now;
		return `<system-reminder>\n# Environment update\n${lines.join("\n")}\n</system-reminder>`;
	}

	/** After a formatter/fixer, name previously read files it modified (they must be re-read before editing). */
	async function staleReadHint(command: string, startedAt: number): Promise<string | undefined> {
		if (!FORMATTER_RE.test(command)) return undefined;
		const changed: string[] = [];
		for (const p of await cc.fileState.changedSinceRead({ contentCheck: isFixed(cc, "mtimeOnlyChangeDetection") })) {
			try {
				if ((await fs.stat(p)).mtimeMs > startedAt) changed.push(p);
			} catch {
				// gone: not a file to re-read
			}
		}
		if (changed.length === 0) return undefined;
		const base = shellCwd ?? process.cwd();
		const names = changed.slice(0, 5).map((p) => (isWithin(p, base) ? relative(base, p) || p : p));
		const more = changed.length > 5 ? ` and ${changed.length - 5} more` : "";
		return `[This command modified ${changed.length} ${changed.length === 1 ? "file" : "files"} you've previously read: ${names.join(", ")}${more}. Call Read before editing.]`;
	}

	/** Turn a running command into a background task (output file, TaskStop, completion notification). */
	async function adoptAsTask(
		run: ShellRun,
		opts: { command: string; description?: string; toolCallId: string; limitMs: number; cleanup?: () => Promise<void> },
	): Promise<BackgroundTask> {
		const id = run.id;
		if (run.file === undefined && !run.fileFailed) {
			// the foreground run had no output file: create it now with what was captured so far
			const file = await cc.tasks.createOutputFile(id);
			run.outputFile = file.path;
			run.file = new FileAppender(fs, file.path);
			writeRunFile(run, run.output.toString());
		}
		const outputFile = run.outputFile!;
		run.background = true;
		run.output = new OutputBuffer(0);
		run.head = "";
		let stopped = false;
		let deadlineHit = false;
		let finish!: () => void;
		const finished = new Promise<void>((r) => (finish = r));
		const task = cc.tasks.add({
			id,
			type: "local_bash",
			label: opts.command,
			status: "running",
			outputFile,
			toolUseId: opts.toolCallId,
			async stop() {
				stopped = true;
				run.proc.kill();
				await finished;
			},
		});
		live.add(run);
		cc.emit({ type: "background_shell_started", shellId: id, command: opts.command });
		const deadline = setTimeout(() => {
			deadlineHit = true;
			run.proc.kill();
		}, opts.limitMs);
		deadline.unref?.();

		void run.done.then(async (exit) => {
			clearTimeout(deadline);
			live.delete(run);
			const killed = stopped || deadlineHit || shuttingDown;
			const code = exitCodeOf(exit);
			try {
				await opts.cleanup?.();
				writeRunFile(run, killed ? "\n[killed]\n" : `\n[exited with code ${code}]\n`);
			} finally {
				await closeRunFile(run);
			}
			// a terminal status evicts the task from the registry (Claude Code's evictTerminalTask)
			const status = killed ? "killed" : code === 0 ? "completed" : "failed";
			task.status = status;
			cc.emit({ type: "background_shell_exited", shellId: id, exitCode: exit.exitCode, signal: exit.signal });
			finish();
			if (stopped || shuttingDown) return; // stopped on purpose: no notification
			const label = `Background command "${opts.description || opts.command}"`;
			const summary = deadlineHit
				? `${label} was stopped after reaching its background time limit`
				: code === 0
					? `${label} completed (exit code ${code})`
					: `${label} failed with exit code ${code}`;
			cc.notifications.enqueue(
				formatTaskNotification({
					taskId: id,
					toolUseId: opts.toolCallId,
					outputFile,
					status,
					summary: escapeXml(summary),
					note: deadlineHit ? escapeXml(DEADLINE_NOTE) : undefined,
				}),
			);
		});
		return task;
	}

	// ---------------------------------------------------------------- foreground
	async function runForeground(
		params: { command: string; description?: string; timeout?: number },
		toolCallId: string,
		baseCwd: string,
		signal: AbortSignal | undefined,
		onUpdate: ((r: AgentToolResult<BashDetails>) => void) | undefined,
	): Promise<AgentToolResult<BashDetails>> {
		const { command } = params;
		if (signal?.aborted) throw new Error(ABORTED);
		const timeoutMs = clampTimeout(params.timeout, defaultTimeout, maxTimeout);
		const cwd = await resolveCwd(baseCwd);
		const cwdFile = await cwdFilePath(newTaskId("local_bash"));
		const removeCwdFile = () => removeFile(fs, cwdFile);
		const startedAt = Math.floor(Date.now() / 1000) * 1000;
		const run = await startRun(command, cwd, { background: false, cwdFile, cancelled: () => signal?.aborted === true });
		live.add(run);

		let updateTimer: NodeJS.Timeout | undefined;
		let lastUpdate = 0;
		const flushUpdate = () => {
			updateTimer = undefined;
			lastUpdate = Date.now();
			try {
				onUpdate?.({ content: [{ type: "text", text: run.output.tail(UPDATE_TAIL_CHARS) }], details: { cwd } });
			} catch {
				// progress consumers must not break execution
			}
		};
		if (onUpdate) {
			run.onData = () => {
				if (run.background || updateTimer) return;
				const delay = UPDATE_THROTTLE_MS - (Date.now() - lastUpdate);
				if (delay <= 0) flushUpdate();
				else updateTimer = setTimeout(flushUpdate, delay);
			};
		}

		let onAbort: (() => void) | undefined;
		let timer: NodeJS.Timeout | undefined;
		const outcome = await new Promise<"exit" | "timeout" | "abort">((resolve) => {
			run.done.then(() => resolve("exit"));
			timer = setTimeout(() => resolve("timeout"), timeoutMs);
			onAbort = () => resolve("abort");
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) onAbort();
		});
		clearTimeout(timer);
		if (onAbort) signal?.removeEventListener("abort", onAbort);
		if (updateTimer) clearTimeout(updateTimer);
		run.onData = undefined;
		live.delete(run);

		let task: BackgroundTask | undefined;
		if (outcome === "timeout" && canAutoBackground(command)) {
			// Claude Code does not kill a command at its timeout: it keeps running as a background task.
			try {
				task = await adoptAsTask(run, {
					command,
					description: params.description,
					toolCallId,
					limitMs: BACKGROUND_DEFAULT_TIMEOUT_MS,
					cleanup: removeCwdFile,
				});
			} catch {
				// no output file for the background task: stop the command like a plain timeout
				task = undefined;
			}
		}
		if (task) {
			const text =
				`Command did not complete within its ${Math.max(1, Math.round(timeoutMs / 1000))}s timeout and was moved to the background (ID: ${task.id}). ` +
				`Output is being written to: ${task.outputFile}. You will be notified when it completes. ` +
				`If it is still running after ${formatClaudeDuration(BACKGROUND_DEFAULT_TIMEOUT_MS, true)} in the background, it will be stopped and you will be notified. ` +
				`To check interim output, use Read on that file path.`;
			return textResult<BashDetails>(text, { backgroundTaskId: task.id, outputFile: task.outputFile, timedOut: true, cwd });
		}

		if (outcome !== "exit") run.proc.kill();
		const exit = await run.done;
		await closeRunFile(run);
		let newCwd: string | undefined;
		try {
			if (cwdFile) newCwd = asBuffer(await fs.readFile(cwdFile)).toString("utf8").trim() || undefined;
		} catch {
			// no cwd recorded (the command failed) or unreadable
		}
		await removeCwdFile();
		// The output file is only kept when it is the sole complete copy of the output (see below).
		const keepFile = outcome === "exit" && run.output.droppedChars > 0 && !run.fileFailed && !isErrorExit(command, exitCodeOf(exit));
		if (!keepFile) await removeFile(fs, run.outputFile);

		if (outcome === "abort") {
			throw new Error([run.output.toString().trim(), ABORTED].filter(Boolean).join("\n"));
		}
		if (outcome === "timeout") {
			const text = [`Exit code ${TIMEOUT_EXIT_CODE}`, `Command timed out after ${formatClaudeDuration(timeoutMs)}`, run.head].join("\n").trim();
			throw new Error(truncateError(text));
		}

		const exitCode = exitCodeOf(exit);
		if (isErrorExit(command, exitCode)) {
			throw new Error(truncateError([`Exit code ${exitCode}`, run.head].filter(Boolean).join("\n").trim()));
		}

		let resetNote: string | undefined;
		if (newCwd && (await isDir(fs, newCwd))) {
			if (isWithin(newCwd, baseCwd) || isWithin(newCwd, await realpathOr(fs, baseCwd))) shellCwd = newCwd;
			else {
				// Claude Code keeps the shell inside the project: leaving it resets to the original directory.
				shellCwd = baseCwd;
				resetNote = `Shell cwd was reset to ${baseCwd}`;
			}
		}
		let body: string;
		if (keepFile) {
			// More output than fits in memory: point at the complete output file (it starts at the very
			// first byte, like Claude Code's persisted output) instead of returning a truncated text.
			const { preview } = makePreview(run.head, previewChars);
			body = formatPersistedOutput({ size: run.output.end, path: run.outputFile!, preview, truncated: true, previewChars });
		} else body = run.output.toString().trim();
		let text = [body, resetNote, await staleReadHint(command, startedAt)].filter(Boolean).join("\n") || NO_OUTPUT;
		const env = await environmentUpdate();
		if (env) text += `\n\n${env}`;
		return textResult<BashDetails>(text, { exitCode, signal: exit.signal, cwd: shellCwd });
	}

	// ---------------------------------------------------------------- background
	async function startBackground(
		params: { command: string; description?: string; timeout?: number },
		toolCallId: string,
		baseCwd: string,
		signal: AbortSignal | undefined,
	): Promise<AgentToolResult<BashDetails>> {
		const cwd = await resolveCwd(baseCwd);
		// the output file is created before the command is spawned: no unregistered process on failure
		const run = await startRun(params.command, cwd, { background: true, cancelled: () => signal?.aborted === true || shuttingDown });
		const task = await adoptAsTask(run, {
			command: params.command,
			description: params.description,
			toolCallId,
			limitMs: clampTimeout(params.timeout, BACKGROUND_DEFAULT_TIMEOUT_MS, BACKGROUND_MAX_TIMEOUT_MS),
		});
		let text =
			`Command running in background with ID: ${task.id}. Output is being written to: ${task.outputFile}. ` +
			`You will be notified when it completes. To check interim output, use Read on that file path.`;
		if (changesDirectory(params.command)) text += `\nSession cwd remains ${cwd}; ${BG_CWD_NOTE}`;
		return textResult<BashDetails>(text, { backgroundTaskId: task.id, outputFile: task.outputFile, cwd });
	}

	pi.registerTool({
		name: "Bash",
		label: "Bash",
		description: bashDescription(defaultTimeout, maxTimeout),
		promptSnippet: "Execute shell commands (persistent working directory, optional background execution)",
		parameters: Type.Object(
			{
				command: Type.String({ description: "The command to execute" }),
				timeout: Type.Optional(Type.Number({ description: `Optional timeout in milliseconds (max ${maxTimeout} for a foreground command)` })),
				description: Type.Optional(Type.String({ description: DESCRIPTION_PARAM })),
				run_in_background: Type.Optional(
					Type.Boolean({
						description: `Set to true to run this command in the background. With it, \`timeout\` limits how long the command may run in the background before it is stopped (default ${BACKGROUND_DEFAULT_TIMEOUT_MS} ms, max ${BACKGROUND_MAX_TIMEOUT_MS} ms).`,
					}),
				),
				dangerouslyDisableSandbox: Type.Optional(
					Type.Boolean({ description: "Set this to true to dangerously override sandbox mode and run commands without sandboxing." }),
				),
			},
			{ additionalProperties: false },
		),
		prepareArguments: claudeInputValidator<BashInput>("Bash", BashSpec) as any,
		async execute(toolCallId, rawParams, signal, onUpdate, ctx) {
			const input = rawParams as BashInput;
			const timeout = input.timeout === undefined || input.timeout === null || input.timeout === "" ? undefined : Number(input.timeout);
			const params = { command: input.command, description: input.description, timeout: Number.isFinite(timeout) ? timeout : undefined };
			if (input.run_in_background) {
				// an already-cancelled call must not start anything (like the foreground path)
				if (signal?.aborted || shuttingDown) throw new Error(ABORTED);
				return startBackground(params, toolCallId, ctx.cwd, signal);
			}
			return runForeground(params, toolCallId, ctx.cwd, signal, onUpdate as any);
		},
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		for (const run of live) run.proc.kill();
		live.clear();
	});
}

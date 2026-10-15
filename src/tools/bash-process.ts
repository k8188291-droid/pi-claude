import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { getShellConfig } from "@earendil-works/pi-coding-agent";

/** Hard cap on captured output kept in memory per command (characters). Oldest output is dropped. */
export const OUTPUT_HARD_CAP = 10 * 1024 * 1024;

/**
 * Append-only text buffer with a hard cap. When the cap is exceeded the oldest text is dropped,
 * but absolute offsets (used by read cursors) keep counting from the very first character.
 */
export class OutputBuffer {
	private text = "";
	/** Number of characters dropped from the front so far. */
	private dropped = 0;

	constructor(private readonly cap = OUTPUT_HARD_CAP) {}

	append(chunk: string): void {
		if (!chunk) return;
		this.text += chunk;
		if (this.text.length > this.cap) {
			// drop in larger steps to avoid re-slicing on every append
			const excess = this.text.length - Math.floor(this.cap * 0.9);
			this.text = this.text.slice(excess);
			this.dropped += excess;
		}
	}

	/** Absolute offset of the end of the buffer. */
	get end(): number {
		return this.dropped + this.text.length;
	}

	get droppedChars(): number {
		return this.dropped;
	}

	/** Text from absolute offset `from` to the end. Returns how many requested chars were already dropped. */
	readFrom(from: number): { text: string; lost: number } {
		const start = Math.max(0, from - this.dropped);
		const lost = Math.max(0, this.dropped - from);
		return { text: this.text.slice(start), lost };
	}

	/** Whole retained text. */
	toString(): string {
		return this.text;
	}

	/** Last `n` characters of retained text. */
	tail(n: number): string {
		return this.text.length > n ? this.text.slice(this.text.length - n) : this.text;
	}
}

/** Kill a process and its whole (detached) process group. */
export function killProcessTree(pid: number, signal: NodeJS.Signals = "SIGKILL"): void {
	if (process.platform === "win32") {
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", detached: true });
		} catch {
			// ignore
		}
		return;
	}
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// already dead
		}
	}
}

// Detached children survive the parent unless killed explicitly; kill them when node exits.
const liveDetachedPids = new Set<number>();
let exitHookInstalled = false;
function trackPid(pid: number): void {
	liveDetachedPids.add(pid);
	if (!exitHookInstalled) {
		exitHookInstalled = true;
		process.once("exit", () => {
			for (const p of liveDetachedPids) killProcessTree(p);
		});
	}
}
function untrackPid(pid: number): void {
	liveDetachedPids.delete(pid);
}

/** Single-quote a string for POSIX shells. */
export function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the shell script that runs a user command:
 * - stderr merged into stdout (preserves interleaving order),
 * - stdin from /dev/null (spawned with stdio "ignore"),
 * - optional EXIT trap writing the final `pwd -P` to a side-channel file (also runs on `exit`/`set -e`),
 * - the user command runs through `eval` so syntax errors are reported as a normal non-zero exit.
 */
export function buildScript(command: string, cwdFile?: string): string {
	const lines = ["exec 2>&1"];
	if (cwdFile) lines.push(`trap ${shellQuote(`pwd -P >| ${shellQuote(cwdFile)} 2>/dev/null`)} EXIT`);
	lines.push(`eval ${shellQuote(command)}`);
	return lines.join("\n");
}

export interface SpawnedShell {
	child: ChildProcess;
	pid: number | undefined;
	/** Resolves when the shell process has exited and its output streams are drained (or abandoned). */
	done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
	kill(): void;
}

/** Grace period after the shell exits for descendants still holding the output pipes. */
const EXIT_STDIO_GRACE_MS = 100;

/** Spawn `script` in the user's shell as a detached process group, streaming decoded output to `onData`. */
export function spawnShell(script: string, cwd: string, onData: (text: string) => void): SpawnedShell {
	const { shell, args } = getShellConfig();
	const child = spawn(shell, [...args, script], {
		cwd,
		detached: process.platform !== "win32",
		env: { ...process.env },
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	const pid = child.pid;
	if (pid) trackPid(pid);

	const outDec = new StringDecoder("utf8");
	const errDec = new StringDecoder("utf8");
	child.stdout?.on("data", (b: Buffer) => onData(outDec.write(b)));
	child.stderr?.on("data", (b: Buffer) => onData(errDec.write(b)));

	const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
		let settled = false;
		let exited = false;
		let result: { exitCode: number | null; signal: NodeJS.Signals | null } = { exitCode: null, signal: null };
		let stdoutEnded = !child.stdout;
		let stderrEnded = !child.stderr;
		let graceTimer: NodeJS.Timeout | undefined;
		const finalize = () => {
			if (settled) return;
			settled = true;
			if (graceTimer) clearTimeout(graceTimer);
			const restOut = outDec.end();
			const restErr = errDec.end();
			if (restOut) onData(restOut);
			if (restErr) onData(restErr);
			child.stdout?.destroy();
			child.stderr?.destroy();
			if (pid) untrackPid(pid);
			resolve(result);
		};
		const maybeFinalize = () => {
			if (exited && stdoutEnded && stderrEnded) finalize();
		};
		child.stdout?.once("end", () => {
			stdoutEnded = true;
			maybeFinalize();
		});
		child.stderr?.once("end", () => {
			stderrEnded = true;
			maybeFinalize();
		});
		child.once("exit", (code, signal) => {
			exited = true;
			result = { exitCode: code, signal };
			maybeFinalize();
			if (!settled) graceTimer = setTimeout(finalize, EXIT_STDIO_GRACE_MS);
		});
		child.once("close", (code, signal) => {
			if (!exited) result = { exitCode: code, signal };
			exited = true;
			finalize();
		});
		child.once("error", (err) => {
			if (settled) return;
			settled = true;
			if (graceTimer) clearTimeout(graceTimer);
			if (pid) untrackPid(pid);
			reject(err);
		});
	});

	return {
		child,
		pid,
		done,
		kill() {
			if (pid) killProcessTree(pid);
			else child.kill("SIGKILL");
		},
	};
}

/** Strip leading blank lines and trailing whitespace (Claude Code output normalization). */
export function normalizeOutput(text: string): string {
	return text.replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd();
}

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const totalSec = Math.round(ms / 100) / 10;
	if (totalSec < 60) return `${Number.isInteger(totalSec) ? totalSec : totalSec.toFixed(1)}s`;
	const m = Math.floor(totalSec / 60);
	const s = Math.round(totalSec - m * 60);
	return s ? `${m}m ${s}s` : `${m}m`;
}

import type { ClaudeCodeHost } from "./types.js";

/** Single-quote a string for POSIX shells. */
export function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface HostCommandResult {
	stdout: string;
	stderr: string;
}

/** A command that could not run, failed, timed out or was aborted (execFile's error, in host terms). */
export class HostCommandError extends Error {
	constructor(
		message: string,
		readonly stdout: string,
		readonly stderr: string,
		/** Exit status (127: the command was not found), or null when it did not exit by itself. */
		readonly exitCode: number | null,
		readonly signal: string | null,
		readonly reason: "exit" | "timeout" | "abort" | "maxBuffer" | "spawn",
	) {
		super(message);
	}

	/** The shell could not find the program (execFile's ENOENT). */
	get notFound(): boolean {
		return this.reason === "exit" && this.exitCode === 127;
	}
}

export interface RunHostCommandOptions {
	cwd: string;
	signal?: AbortSignal;
	/** Kill the command after this long (execFile's `timeout`). */
	timeoutMs?: number;
	/** Fail once stdout or stderr passes this many characters (execFile's `maxBuffer`). */
	maxBuffer?: number;
}

/**
 * Run one program with arguments in the host's shell (each argument quoted, no shell expansion),
 * like `execFile`: resolves with its output when it exits 0, rejects with a `HostCommandError`
 * otherwise.
 */
export function runHostCommand(host: ClaudeCodeHost, argv: string[], options: RunHostCommandOptions): Promise<HostCommandResult> {
	const command = argv.map(shellQuote).join(" ");
	return new Promise<HostCommandResult>((resolve, reject) => {
		const fail = (reason: HostCommandError["reason"], exitCode: number | null = null, sig: string | null = null, detail?: string) =>
			new HostCommandError(detail ?? `Command failed: ${argv.join(" ")}${stderr ? `\n${stderr}` : ""}`, stdout, stderr, exitCode, sig, reason);
		let stdout = "";
		let stderr = "";
		if (options.signal?.aborted) {
			reject(fail("abort", null, null, "The operation was aborted"));
			return;
		}
		let proc;
		try {
			proc = host.shell.spawn(command, { cwd: options.cwd, env: host.env });
		} catch (err) {
			reject(fail("spawn", null, null, err instanceof Error ? err.message : String(err)));
			return;
		}
		let stopped: HostCommandError["reason"] | undefined;
		const stop = (reason: HostCommandError["reason"]) => {
			if (stopped) return;
			stopped = reason;
			proc.kill();
		};
		const max = options.maxBuffer ?? Infinity;
		proc.onStdout((chunk) => {
			stdout += chunk;
			if (stdout.length > max) stop("maxBuffer");
		});
		proc.onStderr((chunk) => {
			stderr += chunk;
			if (stderr.length > max) stop("maxBuffer");
		});
		const timer = options.timeoutMs !== undefined ? setTimeout(() => stop("timeout"), options.timeoutMs) : undefined;
		const onAbort = () => stop("abort");
		options.signal?.addEventListener("abort", onAbort, { once: true });
		proc.exited.then(
			(exit) => {
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", onAbort);
				if (stopped === "abort") reject(fail("abort", exit.exitCode, exit.signal, "The operation was aborted"));
				else if (stopped) reject(fail(stopped, exit.exitCode, exit.signal));
				else if (exit.exitCode !== 0) reject(fail("exit", exit.exitCode, exit.signal));
				else resolve({ stdout, stderr });
			},
			(err: unknown) => {
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", onAbort);
				reject(fail("spawn", null, null, err instanceof Error ? err.message : String(err)));
			},
		);
	});
}

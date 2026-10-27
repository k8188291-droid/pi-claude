import { Bash, type BashOptions, decodeBytesToUtf8, InMemoryFs, stdoutAsBytes, stdoutKind } from "just-bash";
import type { ClaudeCodeHost, HostProcess, HostProcessExit, HostShell, HostShellSpawnOptions } from "../host/types.js";
import { MemoryFileSystem } from "./fs.js";
import { memoryGlob } from "./glob.js";
import { DEFAULT_MEMORY_CWD, normalizeVirtualPath } from "./paths.js";
import { MemoryRipgrep } from "./ripgrep.js";

/** Default byte cap of a filesystem created by `createMemoryHost`. */
export const DEFAULT_MEMORY_FS_BYTES = 256 * 1024 * 1024;

export interface MemoryHostOptions {
	/** Filesystem to use (shared with whatever else holds it). Default: a new `InMemoryFs`. */
	fs?: InMemoryFs;
	/** Byte cap of the filesystem created when `fs` is not given. Default 256 MiB. */
	maxFileSystemBytes?: number;
	/** Session working directory (created if missing). Default `/workspace`. */
	cwd?: string;
	/** Scratch directory (created if missing). Default `/tmp`. */
	tmpDir?: string;
	/** Home directory (created if missing). Default `/home/agent`. */
	homeDir?: string;
	/** Merged over the default environment (HOME, PATH, TMPDIR, LANG, USER, SHELL). */
	env?: Record<string, string>;
	/** just-bash execution limits (command count, loop iterations, output size, wall time, ...). */
	executionLimits?: BashOptions["executionLimits"];
	/** just-bash limit preset: "normal" (just-bash's default) or "hardened". */
	executionLimitProfile?: BashOptions["executionLimitProfile"];
	/**
	 * Fetch implementation behind `curl`/`wget`, e.g. one that serves virtual HTTP APIs. Without it
	 * (and without `network`) there are no network commands.
	 */
	fetch?: BashOptions["fetch"];
	/** just-bash network allow-list (real network access). Off by default. */
	network?: BashOptions["network"];
	/** Enable python3 (CPython in WebAssembly). Default false. */
	python?: boolean;
	/** Enable js-exec (QuickJS). Default false. */
	javascript?: BashOptions["javascript"];
	/** Extra just-bash commands, e.g. virtual CLIs backed by the host application. */
	customCommands?: BashOptions["customCommands"];
}

/** The memory host plus the pieces behind it, for reading files back or saving a snapshot. */
export interface MemoryHost extends ClaudeCodeHost {
	vfs: InMemoryFs;
	bash: Bash;
	cwd: string;
}

const EXECUTION_ABORTED = /(?:^|\n)bash: execution aborted\n?$/;

/**
 * Shell over one just-bash `Bash`. A single instance serves concurrent spawns: `Bash#exec` copies
 * the shell state (environment, cwd, functions, options) per call and creates a fresh execution
 * scope (limits, abort signal) per call, so concurrent commands do not see each other's `cd`,
 * `export` or limits; they share only the filesystem, like processes do.
 *
 * Output is delivered once, when the command ends: just-bash has no streaming API (`exec` resolves
 * with the whole stdout/stderr). A command killed by `kill()` or by `signal` reports
 * `{ exitCode: null, signal: "SIGKILL" }`; just-bash stops it at its next await point, so a loop that
 * never awaits (`while :; do :; done`) runs until an execution limit ends it.
 */
class MemoryShell implements HostShell {
	constructor(private readonly bash: Bash) {}

	spawn(command: string, options: HostShellSpawnOptions): HostProcess {
		const controller = new AbortController();
		let killed = false;
		let finished = false;
		const listeners = { stdout: [] as Array<(c: string) => void>, stderr: [] as Array<(c: string) => void> };
		const output = { stdout: [] as string[], stderr: [] as string[] };
		const emit = (stream: "stdout" | "stderr", chunk: string) => {
			if (chunk === "") return;
			output[stream].push(chunk);
			for (const l of listeners[stream]) l(chunk);
		};
		const kill = () => {
			if (finished || killed) return;
			killed = true;
			controller.abort();
		};
		const onAbort = () => kill();
		if (options.signal?.aborted) kill();
		else options.signal?.addEventListener("abort", onAbort, { once: true });

		const exited: Promise<HostProcessExit> = (async () => {
			// let the caller attach its listeners before anything can be emitted
			await Promise.resolve();
			let stdout = "";
			let stderr = "";
			let exitCode = 1;
			try {
				const r = await this.bash.exec(command, {
					cwd: options.cwd,
					env: options.env,
					replaceEnv: true,
					// run the script as written (just-bash otherwise strips leading whitespace per line)
					rawScript: true,
					signal: controller.signal,
				});
				stdout = stdoutKind(r) === "bytes" ? decodeBytesToUtf8(stdoutAsBytes(r)) : r.stdout;
				stderr = r.stderr;
				exitCode = r.exitCode;
			} catch (err) {
				stderr = `bash: ${err instanceof Error ? err.message : String(err)}\n`;
			} finally {
				options.signal?.removeEventListener("abort", onAbort);
			}
			if (killed) stderr = stderr.replace(EXECUTION_ABORTED, "");
			emit("stdout", stdout);
			emit("stderr", stderr);
			finished = true;
			return killed ? { exitCode: null, signal: "SIGKILL" } : { exitCode, signal: null };
		})();

		return {
			onStdout(listener) {
				listeners.stdout.push(listener);
				for (const c of output.stdout) listener(c);
			},
			onStderr(listener) {
				listeners.stderr.push(listener);
				for (const c of output.stderr) listener(c);
			},
			exited,
			kill,
		};
	}
}

/**
 * A `ClaudeCodeHost` that never touches the host machine: files live in a just-bash `InMemoryFs`,
 * Bash runs in the just-bash interpreter (no subprocesses), Grep runs just-bash's `rg`, Glob matches
 * the in-memory paths. Network, Python and JavaScript are off unless enabled in `options`.
 */
export async function createMemoryHost(options: MemoryHostOptions = {}): Promise<MemoryHost> {
	const vfs = options.fs ?? new InMemoryFs({}, { maxTotalBytes: options.maxFileSystemBytes ?? DEFAULT_MEMORY_FS_BYTES });
	const cwd = normalizeVirtualPath(options.cwd ?? DEFAULT_MEMORY_CWD, "/");
	const tmpDir = normalizeVirtualPath(options.tmpDir ?? "/tmp", "/");
	const homeDir = normalizeVirtualPath(options.homeDir ?? "/home/agent", "/");
	for (const dir of [cwd, tmpDir, homeDir]) await vfs.mkdir(dir, { recursive: true });
	const env: Record<string, string> = {
		HOME: homeDir,
		PATH: "/usr/bin:/bin",
		TMPDIR: tmpDir,
		LANG: "C.UTF-8",
		USER: "agent",
		SHELL: "/bin/bash",
		...options.env,
	};
	const bash = new Bash({
		fs: vfs,
		cwd,
		env,
		executionLimits: options.executionLimits,
		executionLimitProfile: options.executionLimitProfile,
		fetch: options.fetch,
		network: options.network,
		python: options.python ?? false,
		javascript: options.javascript ?? false,
		customCommands: options.customCommands,
	});
	const rg = new MemoryRipgrep(bash, vfs);
	return {
		vfs,
		bash,
		cwd,
		fs: new MemoryFileSystem(vfs),
		shell: new MemoryShell(bash),
		search: {
			ripgrep: (args, opts) => rg.run(args, opts),
			glob: (pattern, opts) => memoryGlob(vfs, pattern, opts),
		},
		tmpDir,
		homeDir,
		env,
		supportsWorktrees: false,
	};
}

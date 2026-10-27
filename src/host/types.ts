/**
 * The host the tools run against: the filesystem they read and write, the shell Bash runs in, and
 * the search engines behind Grep and Glob.
 *
 * Every tool reaches the outside world only through this interface, so swapping the host moves the
 * whole tool set at once — the local host (`createLocalHost`) is the real machine, the memory host
 * (`createMemoryHost`) is a just-bash `InMemoryFs` plus its interpreter, with no host file or process
 * touched.
 *
 * Errors: every filesystem method rejects with an `Error` carrying a Node-style `code` (`ENOENT`,
 * `ENOTDIR`, `EISDIR`, `EEXIST`, `EACCES`, `ELOOP`), because the tools branch on those codes to pick
 * Claude Code's wording.
 *
 * Paths are absolute and already resolved against the session cwd by the caller.
 */

export interface HostStat {
	isFile: boolean;
	isDirectory: boolean;
	isSymbolicLink: boolean;
	/** FIFO, socket, character or block device: reading one can block forever. */
	isSpecial: boolean;
	size: number;
	mtimeMs: number;
	/** Permission bits (`mode & 0o7777`). */
	mode: number;
}

export interface HostDirent {
	name: string;
	isFile: boolean;
	isDirectory: boolean;
	isSymbolicLink: boolean;
}

export interface HostFileSystem {
	/** Follows symlinks. */
	stat(path: string): Promise<HostStat>;
	lstat(path: string): Promise<HostStat>;
	realpath(path: string): Promise<string>;
	readFile(path: string, options?: { signal?: AbortSignal }): Promise<Uint8Array>;
	/**
	 * Up to `length` bytes starting at byte `start`; fewer at end of file. Lets Read page through a
	 * large file without holding it whole.
	 */
	readRange(path: string, start: number, length: number, options?: { signal?: AbortSignal }): Promise<Uint8Array>;
	/**
	 * Creates or truncates. `mode` applies only when the file is created. Must never write into a
	 * FIFO, device or socket: the local host then rejects with code `ENXIO` (a FIFO without a
	 * reader) or `ERR_NOT_REGULAR_FILE`, and writes nothing.
	 */
	writeFile(path: string, data: Uint8Array | string, options?: { mode?: number }): Promise<void>;
	appendFile(path: string, data: Uint8Array | string, options?: { mode?: number }): Promise<void>;
	mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
	readdir(path: string): Promise<HostDirent[]>;
	rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
	chmod(path: string, mode: number): Promise<void>;
}

export interface HostProcessExit {
	/** `null` when the process was ended by a signal. */
	exitCode: number | null;
	signal: string | null;
}

export interface HostProcess {
	/** Decoded (UTF-8) output. Output produced before a listener is registered is kept for it. */
	onStdout(listener: (chunk: string) => void): void;
	onStderr(listener: (chunk: string) => void): void;
	/**
	 * Resolves once the process has exited and its output is drained (processes it left running in
	 * the background do not hold this up for more than a moment). Rejects when the process could not
	 * be started at all (for example a missing shell).
	 */
	readonly exited: Promise<HostProcessExit>;
	/** Ends the process and everything it started. Idempotent. */
	kill(): void;
}

export interface HostShellSpawnOptions {
	cwd: string;
	env: Record<string, string>;
	signal?: AbortSignal;
	/**
	 * End everything the command started as soon as the command itself exits, so background (`&`)
	 * children do not outlive it (quirk `orphanProcesses` fixed). Default false: they keep running.
	 */
	killGroupOnExit?: boolean;
}

export interface HostShell {
	/** Runs one `bash -c`-style command string. */
	spawn(command: string, options: HostShellSpawnOptions): HostProcess;
}

export interface HostRipgrepResult {
	/** With `maxOutputBytes`, at most that many bytes (the cut may fall inside a line). */
	stdout: string;
	stderr: string;
	/**
	 * ripgrep's own convention: 0 matches, 1 no match, 2 error. Anything else means the run ended
	 * abnormally (a process ended by a signal reports 128 + the signal number, like a shell).
	 */
	exitCode: number;
	/** The run was stopped at `timeoutMs`; `stdout` holds what was printed until then. */
	timedOut?: boolean;
	/** stdout passed `maxOutputBytes` and the run was stopped there. */
	truncated?: boolean;
}

export interface HostRipgrepOptions {
	cwd: string;
	signal?: AbortSignal;
	/** Stop the run after this long and return what it printed so far (`timedOut`). */
	timeoutMs?: number;
	/** Stop the run once stdout passes this many bytes and return the first bytes (`truncated`). */
	maxOutputBytes?: number;
}

export interface HostGlobOptions {
	cwd: string;
	signal?: AbortSignal;
}

export interface HostGlobMatch {
	/** Absolute path. */
	path: string;
	mtimeMs: number;
}

export interface HostSearch {
	/**
	 * Runs ripgrep with exactly the argument vector Grep builds (no shell quoting involved).
	 * The local host spawns the `rg` binary; the memory host runs just-bash's `rg`. Grep and Glob both
	 * search through this method. Rejects with "Operation aborted" when `signal` aborts.
	 */
	ripgrep(args: string[], options: HostRipgrepOptions): Promise<HostRipgrepResult>;
	/**
	 * Files (not directories) matching `pattern` under `cwd`, with the same matching rules the
	 * Glob tool documents: hidden files, `node_modules` and gitignored files included; oldest first.
	 * The Glob tool itself runs `rg --files` through `ripgrep` (its truncation, timeout and
	 * unreadable-path reporting need ripgrep's raw output); this is for embedders.
	 */
	glob(pattern: string, options: HostGlobOptions): Promise<HostGlobMatch[]>;
}

export interface ClaudeCodeHost {
	fs: HostFileSystem;
	shell: HostShell;
	search: HostSearch;
	/** Private scratch directory on this host: background output, spilled results, cwd tracking. */
	tmpDir: string;
	/** Home directory on this host (`~` expansion, `~/.claude/agents`). */
	homeDir: string;
	/** Base environment for Bash commands. */
	env: Record<string, string>;
	/**
	 * Whether `isolation: "worktree"` can work here (needs a real `git`). When false, the Agent tool
	 * reports worktree isolation as unsupported instead of trying it.
	 */
	supportsWorktrees: boolean;
}

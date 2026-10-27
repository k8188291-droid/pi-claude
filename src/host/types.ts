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
	/** Creates or truncates. `mode` applies only when the file is created. */
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
	onStdout(listener: (chunk: string) => void): void;
	onStderr(listener: (chunk: string) => void): void;
	/** Resolves once the process and its whole process group have ended. */
	readonly exited: Promise<HostProcessExit>;
	/** Ends the process and everything it started. Idempotent. */
	kill(): void;
}

export interface HostShellSpawnOptions {
	cwd: string;
	env: Record<string, string>;
	signal?: AbortSignal;
}

export interface HostShell {
	/** Runs one `bash -c`-style command string. */
	spawn(command: string, options: HostShellSpawnOptions): HostProcess;
}

export interface HostRipgrepResult {
	stdout: string;
	stderr: string;
	/** ripgrep's own convention: 0 matches, 1 no match, 2 error. */
	exitCode: number;
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
	 * The local host spawns the `rg` binary; the memory host runs just-bash's `rg`.
	 */
	ripgrep(args: string[], options: { cwd: string; signal?: AbortSignal }): Promise<HostRipgrepResult>;
	/**
	 * Files (not directories) matching `pattern` under `cwd`, with the same matching rules the
	 * Glob tool documents: hidden files, `node_modules` and gitignored files included.
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

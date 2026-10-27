import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, type Stats } from "node:fs";
import { appendFile, chmod, lstat, mkdir, open, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { constants as osConstants, homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";
import { getAgentDir, getShellConfig } from "@earendil-works/pi-coding-agent";
import type {
	ClaudeCodeHost,
	HostDirent,
	HostFileSystem,
	HostGlobMatch,
	HostProcess,
	HostProcessExit,
	HostRipgrepOptions,
	HostRipgrepResult,
	HostShellSpawnOptions,
	HostStat,
} from "./types.js";

/**
 * The real machine: node's filesystem (errors keep their Node codes), the user's shell in a detached
 * process group, the `rg` binary, and a private per-user temp directory. This is the only module
 * that touches the machine directly; every tool goes through the `ClaudeCodeHost` it returns.
 */

export interface LocalHostOptions {
	/** Base of the private temp directory `<tmpBase>/pi-cc-<uid>`. Default: `os.tmpdir()`. */
	tmpBase?: string;
}

// ---------------------------------------------------------------------------------------------
// Private temp directory
// ---------------------------------------------------------------------------------------------

function currentUid(): number | undefined {
	return typeof process.getuid === "function" ? process.getuid() : undefined;
}

/**
 * Create `dir` (and missing parents) with mode 0700. An existing `dir` must be a real directory
 * owned by the current user; it is chmod-ed back to 0700 if it is more open.
 */
export function ensurePrivateDir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const st = lstatSync(dir);
	if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} is not a directory`);
	const uid = currentUid();
	if (uid === undefined) return;
	if (st.uid !== uid) throw new Error(`${dir} is not owned by the current user`);
	if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

/**
 * Per-user private temp root, like Claude Code's `$TMPDIR/claude-<uid>` (mode 0700):
 * `<os.tmpdir()>/pi-cc-<uid>`. Created (and checked) on every call.
 */
export function privateTempRoot(base: string = tmpdir()): string {
	const uid = currentUid();
	let who: string;
	if (uid !== undefined) who = String(uid);
	else {
		try {
			who = userInfo().username.replace(/[^\w.-]/g, "_") || "user";
		} catch {
			who = "user";
		}
	}
	const root = join(base, `pi-cc-${who}`);
	ensurePrivateDir(root);
	return root;
}

// ---------------------------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------------------------

function toHostStat(s: Stats): HostStat {
	return {
		isFile: s.isFile(),
		isDirectory: s.isDirectory(),
		isSymbolicLink: s.isSymbolicLink(),
		isSpecial: s.isFIFO() || s.isSocket() || s.isCharacterDevice() || s.isBlockDevice(),
		size: s.size,
		mtimeMs: s.mtimeMs,
		mode: s.mode & 0o7777,
	};
}

function abortError(): Error {
	return Object.assign(new Error("Operation aborted"), { name: "AbortError" });
}

/** O_NONBLOCK: opening a FIFO must neither wait for its other end nor hand it data. */
const O_NONBLOCK = fsConstants.O_NONBLOCK ?? 0;

function notRegularFileError(path: string): Error {
	return Object.assign(new Error(`Not a regular file (device, FIFO, or socket): ${path}`), { code: "ERR_NOT_REGULAR_FILE" });
}

export const localFileSystem: HostFileSystem = {
	async stat(path) {
		return toHostStat(await stat(path));
	},
	async lstat(path) {
		return toHostStat(await lstat(path));
	},
	realpath(path) {
		return realpath(path);
	},
	readFile(path, options) {
		return options?.signal ? readFile(path, { signal: options.signal }) : readFile(path);
	},
	async readRange(path, start, length, options) {
		if (options?.signal?.aborted) throw abortError();
		const fh = await open(path, "r");
		try {
			const buf = Buffer.allocUnsafe(Math.max(0, length));
			const { bytesRead } = await fh.read(buf, 0, buf.length, start);
			return buf.subarray(0, bytesRead);
		} finally {
			await fh.close();
		}
	},
	/**
	 * Opened non-blocking (a FIFO without a reader fails with ENXIO) and checked with fstat before
	 * truncating or writing, so nothing is ever written into a FIFO, device or socket, even if one
	 * replaced the file after the caller checked it.
	 */
	async writeFile(path, data, options) {
		const fh = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | O_NONBLOCK, options?.mode ?? 0o666);
		try {
			if (!(await fh.stat()).isFile()) throw notRegularFileError(path);
			await fh.truncate(0);
			await fh.writeFile(data);
		} finally {
			await fh.close();
		}
	},
	async appendFile(path, data, options) {
		await appendFile(path, data, options?.mode !== undefined ? { mode: options.mode } : undefined);
	},
	async mkdir(path, options) {
		await mkdir(path, options);
	},
	async readdir(path): Promise<HostDirent[]> {
		const entries = await readdir(path, { withFileTypes: true });
		return entries.map((e) => ({ name: e.name, isFile: e.isFile(), isDirectory: e.isDirectory(), isSymbolicLink: e.isSymbolicLink() }));
	},
	async rm(path, options) {
		try {
			await rm(path, options);
		} catch (err: any) {
			// node reports a directory removed without `recursive` as ERR_FS_EISDIR; hosts use EISDIR
			if (err?.code === "ERR_FS_EISDIR") throw Object.assign(err, { code: "EISDIR" });
			throw err;
		}
	},
	chmod(path, mode) {
		return chmod(path, mode);
	},
};

// ---------------------------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------------------------

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

/** Grace period after the shell exits for descendants still holding the output pipes. */
const EXIT_STDIO_GRACE_MS = 100;

/** Listeners of one output stream; text produced before the first listener is kept for it. */
class OutputChannel {
	private listeners: Array<(chunk: string) => void> = [];
	private pending: string[] = [];

	emit(text: string): void {
		if (!text) return;
		if (this.listeners.length === 0) this.pending.push(text);
		else for (const l of this.listeners) l(text);
	}

	add(listener: (chunk: string) => void): void {
		this.listeners.push(listener);
		if (this.listeners.length === 1 && this.pending.length > 0) {
			const pending = this.pending;
			this.pending = [];
			for (const text of pending) listener(text);
		}
	}
}

/** Spawn `command` in the user's shell as a detached process group. */
export function spawnLocalShell(command: string, options: HostShellSpawnOptions): HostProcess {
	const { shell, args } = getShellConfig();
	const child: ChildProcess = spawn(shell, [...args, command], {
		cwd: options.cwd,
		detached: process.platform !== "win32",
		env: options.env,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	const pid = child.pid;
	if (pid) trackPid(pid);

	const out = new OutputChannel();
	const err = new OutputChannel();
	const outDec = new StringDecoder("utf8");
	const errDec = new StringDecoder("utf8");
	child.stdout?.on("data", (b: Buffer) => out.emit(outDec.write(b)));
	child.stderr?.on("data", (b: Buffer) => err.emit(errDec.write(b)));

	const kill = () => {
		if (pid) killProcessTree(pid);
		else child.kill("SIGKILL");
	};

	const exited = new Promise<HostProcessExit>((resolve, reject) => {
		let settled = false;
		let didExit = false;
		let result: HostProcessExit = { exitCode: null, signal: null };
		let stdoutEnded = !child.stdout;
		let stderrEnded = !child.stderr;
		let graceTimer: NodeJS.Timeout | undefined;
		const onAbort = () => kill();
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.signal?.aborted) kill();
		const finalize = () => {
			if (settled) return;
			settled = true;
			if (graceTimer) clearTimeout(graceTimer);
			options.signal?.removeEventListener("abort", onAbort);
			out.emit(outDec.end());
			err.emit(errDec.end());
			child.stdout?.destroy();
			child.stderr?.destroy();
			if (pid) untrackPid(pid);
			resolve(result);
		};
		const maybeFinalize = () => {
			if (didExit && stdoutEnded && stderrEnded) finalize();
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
			didExit = true;
			if (options.killGroupOnExit && pid && process.platform !== "win32") killProcessTree(pid);
			result = { exitCode: code, signal };
			maybeFinalize();
			if (!settled) graceTimer = setTimeout(finalize, EXIT_STDIO_GRACE_MS);
		});
		child.once("close", (code, signal) => {
			if (!didExit) result = { exitCode: code, signal };
			didExit = true;
			finalize();
		});
		child.once("error", (e) => {
			if (settled) return;
			settled = true;
			if (graceTimer) clearTimeout(graceTimer);
			options.signal?.removeEventListener("abort", onAbort);
			if (pid) untrackPid(pid);
			reject(e);
		});
	});
	// a consumer that never awaits `exited` must not turn a spawn failure into an unhandled rejection
	exited.catch(() => {});

	return {
		onStdout: (listener) => out.add(listener),
		onStderr: (listener) => err.add(listener),
		exited,
		kill,
	};
}

// ---------------------------------------------------------------------------------------------
// ripgrep
// ---------------------------------------------------------------------------------------------

let cachedRgPath: string | undefined;

function commandWorks(cmd: string): boolean {
	try {
		const r = spawnSync(cmd, ["--version"], { stdio: "ignore" });
		return !r.error && r.status === 0;
	} catch {
		return false;
	}
}

/**
 * Locate ripgrep the same way pi does: pi's managed bin dir (<agentDir>/bin/rg) first,
 * then `rg` on PATH, then (best effort) pi's own `ensureTool` downloader. That module is not
 * part of pi's public exports, so it is loaded by file path; failures fall through to a clear error.
 */
export async function resolveRgPath(): Promise<string> {
	if (cachedRgPath) return cachedRgPath;
	const exe = process.platform === "win32" ? "rg.exe" : "rg";
	try {
		const local = join(getAgentDir(), "bin", exe);
		if (existsSync(local)) return (cachedRgPath = local);
	} catch {
		// ignore
	}
	if (commandWorks("rg")) return (cachedRgPath = "rg");
	try {
		const require = createRequire(import.meta.url);
		const entry = require.resolve("@earendil-works/pi-coding-agent");
		const managerPath = join(dirname(entry), "utils", "tools-manager.js");
		if (existsSync(managerPath)) {
			const mod: any = await import(pathToFileURL(managerPath).href);
			const p = await mod.ensureTool?.("rg", true);
			if (typeof p === "string" && p) return (cachedRgPath = p);
		}
	} catch {
		// ignore
	}
	throw new Error(
		"ripgrep (rg) is not installed or not on PATH. Install ripgrep (https://github.com/BurntSushi/ripgrep) to use Grep.",
	);
}

/** Exit code of a process ended by `signal`, as a shell reports it. */
function signalExitCode(signal: NodeJS.Signals | null): number {
	const n = signal ? (osConstants.signals as Record<string, number>)[signal] : undefined;
	return 128 + (n ?? 0);
}

/** Run the `rg` binary: stdout capped at `maxOutputBytes`, stopped at `timeoutMs` (output so far kept). */
export async function runLocalRipgrep(args: string[], options: HostRipgrepOptions): Promise<HostRipgrepResult> {
	const rgPath = await resolveRgPath();
	const { signal, timeoutMs, maxOutputBytes } = options;
	return new Promise<HostRipgrepResult>((resolvePromise, reject) => {
		if (signal?.aborted) {
			reject(abortError());
			return;
		}
		const child = spawn(rgPath, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		let bytes = 0;
		let capped = false;
		let timedOut = false;
		let stderr = "";
		let settled = false;
		const timer =
			timeoutMs !== undefined
				? setTimeout(() => {
						timedOut = true;
						child.kill("SIGTERM");
						setTimeout(() => child.kill("SIGKILL"), 5000).unref();
					}, timeoutMs)
				: undefined;
		const onAbort = () => {
			child.kill("SIGKILL");
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				reject(abortError());
			}
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (d: Buffer) => {
			if (capped) return;
			if (maxOutputBytes !== undefined && bytes + d.length > maxOutputBytes) {
				chunks.push(d.subarray(0, maxOutputBytes - bytes));
				bytes = maxOutputBytes;
				capped = true;
				child.kill("SIGKILL");
				return;
			}
			chunks.push(d);
			bytes += d.length;
		});
		child.stderr.on("data", (d: Buffer) => {
			if (stderr.length < 64 * 1024) stderr += d.toString("utf8");
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (!settled) {
				settled = true;
				reject(new Error(`Failed to run ripgrep: ${err.message}`));
			}
		});
		child.on("close", (code, sig) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (settled) return;
			settled = true;
			resolvePromise({
				stdout: Buffer.concat(chunks).toString("utf8"),
				stderr,
				exitCode: code ?? signalExitCode(sig),
				...(timedOut && { timedOut }),
				...(capped && { truncated: capped }),
			});
		});
	});
}

/** Files matching `pattern` under `cwd` (rg --glob semantics, hidden and ignored files included), oldest first. */
async function localGlob(pattern: string, options: { cwd: string; signal?: AbortSignal }): Promise<HostGlobMatch[]> {
	const run = await runLocalRipgrep(["--files", "--null", "--glob", pattern, "--sort=modified", "--no-ignore", "--hidden", "."], options);
	if (run.exitCode !== 0 && run.exitCode !== 1 && run.stdout === "") throw new Error(run.stderr.trim() || `ripgrep exited with code ${run.exitCode}`);
	const paths = run.stdout
		.split("\0")
		.filter(Boolean)
		.map((p) => join(options.cwd, p.startsWith("./") ? p.slice(2) : p));
	const stats = await Promise.allSettled(paths.map((p) => stat(p)));
	return paths.map((path, i) => {
		const s = stats[i];
		return { path, mtimeMs: s.status === "fulfilled" ? s.value.mtimeMs : 0 };
	});
}

// ---------------------------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------------------------

function processEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
	return env;
}

/**
 * The local machine as a `ClaudeCodeHost`. `tmpDir`, `homeDir` and `env` are read when used (the
 * private temp root is created and checked each time, `env` is a fresh copy of `process.env`), as
 * the tools did before hosts existed.
 */
export function createLocalHost(options: LocalHostOptions = {}): ClaudeCodeHost {
	return {
		fs: localFileSystem,
		shell: { spawn: spawnLocalShell },
		search: { ripgrep: runLocalRipgrep, glob: localGlob },
		get tmpDir() {
			return privateTempRoot(options.tmpBase);
		},
		get homeDir() {
			return homedir();
		},
		get env() {
			return processEnv();
		},
		supportsWorktrees: true,
	};
}

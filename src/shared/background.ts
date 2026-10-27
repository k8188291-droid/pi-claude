import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { ClaudeCodeHost, HostFileSystem } from "../host/types.js";

/** Background task kinds, as Claude Code reports them in TaskStop results. */
export type BackgroundTaskType = "local_bash" | "local_agent";
export type BackgroundTaskStatus = "running" | "completed" | "failed" | "killed";

export interface BackgroundTask {
	id: string;
	type: BackgroundTaskType;
	/** Command (bash) or description (agent), shown in TaskStop results and notifications. */
	label: string;
	status: BackgroundTaskStatus;
	/** File the task's output is written to (the model reads it with Read). */
	outputFile?: string;
	/** tool_use id of the call that started the task. */
	toolUseId?: string;
	/** Stop the task. Must resolve once it is stopped (status set to "killed" by the registry). */
	stop(): void | Promise<void>;
}

/**
 * Claude Code-style ids: bash tasks are "b" + 8 base36 chars, agents "a" + 16 hex chars.
 */
export function newTaskId(type: BackgroundTaskType): string {
	if (type === "local_agent") return "a" + randomBytes(8).toString("hex").slice(0, 16);
	let s = "";
	const bytes = randomBytes(8);
	for (const b of bytes) s += (b % 36).toString(36);
	return "b" + s;
}

/** Bytes of a host file as a Buffer (no copy). */
export function asBuffer(data: Uint8Array): Buffer {
	return Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * Create `dir` (and missing parents) on the host with mode 0700. An existing `dir` must be a real
 * directory; it is chmod-ed back to 0700 if it is more open. (The host's `tmpDir` itself is checked
 * by the host: the local one also refuses a root owned by another user.)
 */
export async function ensurePrivateDir(fs: HostFileSystem, dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	const st = await fs.lstat(dir);
	if (st.isSymbolicLink || !st.isDirectory) throw new Error(`${dir} is not a directory`);
	if ((st.mode & 0o077) !== 0) await fs.chmod(dir, 0o700);
}

/**
 * Per-session registry of background tasks (bash commands and agents), used by TaskStop.
 *
 * Like Claude Code (evictTerminalTask), tasks are removed as soon as they reach a terminal status
 * (completed/failed/killed): setting `task.status` to anything but "running" evicts it. TaskStop
 * reports "No task found" for finished tasks either way.
 */
export class BackgroundTaskRegistry {
	private tasks = new Map<string, BackgroundTask>();

	constructor(
		private sessionKey: () => string,
		/** Where output files live: `<host.tmpDir>/<session>/tasks`. */
		private host: Pick<ClaudeCodeHost, "fs" | "tmpDir">,
	) {}

	add(task: BackgroundTask): BackgroundTask {
		let status = task.status;
		const tasks = this.tasks;
		Object.defineProperty(task, "status", {
			configurable: true,
			enumerable: true,
			get: () => status,
			set(value: BackgroundTaskStatus) {
				status = value;
				if (value !== "running" && tasks.get(task.id) === task) tasks.delete(task.id);
			},
		});
		if (status === "running") this.tasks.set(task.id, task);
		return task;
	}

	get(id: string): BackgroundTask | undefined {
		return this.tasks.get(id);
	}

	list(): BackgroundTask[] {
		return [...this.tasks.values()];
	}

	/** Remove a task from the registry (finished tasks are evicted automatically). */
	evict(id: string): void {
		this.tasks.delete(id);
	}

	/**
	 * Directory for task output files: <host.tmpDir>/<session>/tasks (locally
	 * <tmpdir>/pi-cc-<uid>/<session>/tasks), every level 0700. (Re)created on every call, so a
	 * deleted directory is recreated like Claude Code does.
	 */
	async outputDir(): Promise<string> {
		const dir = join(this.host.tmpDir, this.sessionKey().replace(/[^\w.-]/g, "_"), "tasks");
		await this.host.fs.mkdir(dir, { recursive: true, mode: 0o700 });
		return dir;
	}

	async outputPath(id: string): Promise<string> {
		return join(await this.outputDir(), `${id}.output`);
	}

	/** Create (truncate) a task's output file with mode 0600 and return its path. */
	async createOutputFile(id: string, ext = ".output"): Promise<{ path: string }> {
		const path = join(await this.outputDir(), `${id}${ext}`);
		await this.host.fs.writeFile(path, "", { mode: 0o600 });
		return { path };
	}

	async stop(id: string): Promise<BackgroundTask> {
		const task = this.tasks.get(id);
		if (!task) throw new Error(`No task found with ID: ${id}`);
		if (task.status !== "running") throw new Error(`Task ${id} is not running (status: ${task.status})`);
		await task.stop();
		task.status = "killed";
		return task;
	}

	async stopAll(): Promise<void> {
		await Promise.all(
			this.list()
				.filter((t) => t.status === "running")
				.map(async (t) => {
					try {
						await t.stop();
					} finally {
						t.status = "killed";
					}
				}),
		);
	}
}

/**
 * Appends text to a host file in order, without blocking the caller: writes are queued and
 * coalesced. After the first failed write the file is marked `failed` and nothing more is written.
 */
export class FileAppender {
	private pending = "";
	private writing: Promise<void> | undefined;
	private closed = false;
	/** A write failed: the file is incomplete. */
	failed = false;

	constructor(
		private readonly fs: HostFileSystem,
		readonly path: string,
		/** Settles once the file exists (false: it could not be created, nothing is written). */
		private readonly ready: Promise<boolean> = Promise.resolve(true),
	) {}

	write(text: string): void {
		if (this.closed || this.failed || !text) return;
		this.pending += text;
		this.writing ??= this.drain();
	}

	private async drain(): Promise<void> {
		if (!(await this.ready)) {
			this.failed = true;
			this.pending = "";
		}
		while (this.pending && !this.failed) {
			const chunk = this.pending;
			this.pending = "";
			try {
				await this.fs.appendFile(this.path, chunk);
			} catch {
				this.failed = true;
				this.pending = "";
			}
		}
		this.writing = undefined;
	}

	/** Resolves once everything written so far is in the file (or the file failed). */
	async flush(): Promise<void> {
		if (!(await this.ready)) this.failed = true;
		while (this.writing) await this.writing;
	}

	/** Stop accepting writes and flush. Idempotent, never rejects. */
	close(): Promise<void> {
		this.closed = true;
		return this.flush();
	}
}

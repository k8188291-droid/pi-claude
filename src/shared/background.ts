import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

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
 * `<os.tmpdir()>/pi-cc-<uid>`. Created on demand.
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
		/** Base temp directory (tests). Default: os.tmpdir(). */
		private baseTmp?: string,
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
	 * Directory for task output files: <tmpdir>/pi-cc-<uid>/<session>/tasks, every level 0700.
	 * (Re)created on every call, so a deleted directory is recreated like Claude Code does.
	 */
	outputDir(): string {
		const dir = join(privateTempRoot(this.baseTmp), this.sessionKey().replace(/[^\w.-]/g, "_"), "tasks");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		return dir;
	}

	outputPath(id: string): string {
		return join(this.outputDir(), `${id}.output`);
	}

	/** Create (truncate) a task's output file with mode 0600 and return its path and open fd. */
	createOutputFile(id: string, ext = ".output"): { path: string; fd: number } {
		const path = join(this.outputDir(), `${id}${ext}`);
		return { path, fd: openSync(path, "w", 0o600) };
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

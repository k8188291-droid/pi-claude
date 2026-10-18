import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
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

/** Per-session registry of background tasks (bash commands and agents), used by TaskStop. */
export class BackgroundTaskRegistry {
	private tasks = new Map<string, BackgroundTask>();
	private dir?: string;

	constructor(private sessionKey: () => string) {}

	add(task: BackgroundTask): BackgroundTask {
		this.tasks.set(task.id, task);
		return task;
	}

	get(id: string): BackgroundTask | undefined {
		return this.tasks.get(id);
	}

	list(): BackgroundTask[] {
		return [...this.tasks.values()];
	}

	/** Directory for task output files: <tmpdir>/pi-cc-tasks/<session>/tasks (created on demand). */
	outputDir(): string {
		if (!this.dir) {
			this.dir = join(tmpdir(), "pi-cc-tasks", this.sessionKey().replace(/[^\w.-]/g, "_"), "tasks");
			mkdirSync(this.dir, { recursive: true });
		}
		return this.dir;
	}

	outputPath(id: string): string {
		return join(this.outputDir(), `${id}.output`);
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

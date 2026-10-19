import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CCContext } from "../shared/context.js";
import { REMINDER_CUSTOM_TYPE, wrapReminder } from "../shared/reminders.js";
import { textResult } from "../shared/text.js";
import type { TodoItem } from "../shared/types.js";
import { claudeInputValidator, type Spec } from "./input-validation.js";

/*
 * Claude Code's task list tools (TaskCreate / TaskGet / TaskList / TaskUpdate), which replaced
 * TodoWrite. Claude Code keeps the list in files under ~/.claude/tasks/<session>; here the whole
 * list is stored in the `details` of every TaskCreate/TaskUpdate result, so it follows the session
 * branch (resume, fork, /tree) the same way TodoWrite's list did.
 */

export const TASK_CREATE_TOOL_NAME = "TaskCreate";
export const TASK_GET_TOOL_NAME = "TaskGet";
export const TASK_LIST_TOOL_NAME = "TaskList";
export const TASK_UPDATE_TOOL_NAME = "TaskUpdate";
const MUTATING_TOOLS = new Set([TASK_CREATE_TOOL_NAME, TASK_UPDATE_TOOL_NAME]);

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface TaskItem {
	id: string;
	subject: string;
	description: string;
	activeForm?: string;
	status: TaskStatus;
	owner?: string;
	/** Ids of tasks that cannot start until this one completes. */
	blocks: string[];
	/** Ids of tasks that must complete before this one can start. */
	blockedBy: string[];
	metadata?: Record<string, unknown>;
}

export interface TaskListState {
	/** Sorted by numeric id. */
	tasks: TaskItem[];
	/** Highest id ever handed out (ids of deleted tasks are never reused). */
	highWaterMark: number;
}

/** `details` of TaskCreate / TaskUpdate results: the task list after the call. */
export interface TaskToolDetails {
	taskList: TaskListState;
}

/** Claude Code's TodoItem view of a task (what it shows in its todo panel). */
export function taskToTodo(t: TaskItem): TodoItem {
	return { content: t.subject, activeForm: t.activeForm ?? t.subject, status: t.status };
}

// ---------------------------------------------------------------------------------------------
// Descriptions and schemas (verbatim from Claude Code, non-team mode)
// ---------------------------------------------------------------------------------------------

export const TASK_CREATE_DESCRIPTION = `Use this tool to create a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
It also helps the user understand the progress of the task and overall progress of their requests.

## When to Use This Tool

Use this tool proactively in these scenarios:

- Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
- Non-trivial and complex tasks - Tasks that require careful planning or multiple operations
- Plan mode - When using plan mode, create a task list to track the work
- User explicitly requests todo list - When the user directly asks you to use the todo list
- User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)
- After receiving new instructions - Immediately capture user requirements as tasks
- When you start working on a task - Mark it as in_progress BEFORE beginning work
- After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation

## When NOT to Use This Tool

Skip using this tool when:
- There is only a single, straightforward task
- The task is trivial and tracking it provides no organizational benefit
- The task can be completed in less than 3 trivial steps
- The task is purely conversational or informational

NOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.

## Task Fields

- **subject**: A brief, actionable title in imperative form (e.g., "Fix authentication bug in login flow")
- **description**: What needs to be done
- **activeForm** (optional): Present continuous form shown in the spinner when the task is in_progress (e.g., "Fixing authentication bug"). If omitted, the spinner shows the subject instead.

All tasks are created with status \`pending\`.

## Tips

- Create tasks with clear, specific subjects that describe the outcome
- After creating tasks, use TaskUpdate to set up dependencies (blocks/blockedBy) if needed
- Check TaskList first to avoid creating duplicate tasks
`;

export const TASK_GET_DESCRIPTION = `Use this tool to retrieve a task by its ID from the task list.

## When to Use This Tool

- When you need the full description and context before starting work on a task
- To understand task dependencies (what it blocks, what blocks it)
- After being assigned a task, to get complete requirements

## Output

Returns full task details:
- **subject**: Task title
- **description**: Detailed requirements and context
- **status**: 'pending', 'in_progress', or 'completed'
- **blocks**: Tasks waiting on this one to complete
- **blockedBy**: Tasks that must complete before this one can start

## Tips

- After fetching a task, verify its blockedBy list is empty before beginning work.
- Use TaskList to see all tasks in summary form.
`;

export const TASK_LIST_DESCRIPTION = `Use this tool to list all tasks in the task list.

## When to Use This Tool

- To see what tasks are available to work on (status: 'pending', no owner, not blocked)
- To check overall progress on the project
- To find tasks that are blocked and need dependencies resolved
- After completing a task, to check for newly unblocked work or claim the next available task
- **Prefer working on tasks in ID order** (lowest ID first) when multiple tasks are available, as earlier tasks often set up context for later ones

## Output

Returns a summary of each task:
- **id**: Task identifier (use with TaskGet, TaskUpdate)
- **subject**: Brief description of the task
- **status**: 'pending', 'in_progress', or 'completed'
- **owner**: Agent ID if assigned, empty if available
- **blockedBy**: List of open task IDs that must be resolved first (tasks with blockedBy cannot be claimed until dependencies resolve)

Use TaskGet with a specific task ID to view full details including description and comments.
`;

export const TASK_UPDATE_DESCRIPTION = `Use this tool to update a task in the task list.

## When to Use This Tool

**Mark tasks as resolved:**
- When you have completed the work described in a task
- When a task is no longer needed or has been superseded
- IMPORTANT: Always mark your assigned tasks as resolved when you finish them
- After resolving, call TaskList to find your next task

- ONLY mark a task as completed when you have FULLY accomplished it
- If you encounter errors, blockers, or cannot finish, keep the task as in_progress
- When blocked, create a new task describing what needs to be resolved
- Never mark a task as completed if:
  - Tests are failing
  - Implementation is partial
  - You encountered unresolved errors
  - You couldn't find necessary files or dependencies

**Delete tasks:**
- When a task is no longer relevant or was created in error
- Setting status to \`deleted\` permanently removes the task

**Update task details:**
- When requirements change or become clearer
- When establishing dependencies between tasks

## Fields You Can Update

- **status**: The task status (see Status Workflow below)
- **subject**: Change the task title (imperative form, e.g., "Run tests")
- **description**: Change the task description
- **activeForm**: Present continuous form shown in spinner when in_progress (e.g., "Running tests")
- **owner**: Change the task owner (agent name)
- **metadata**: Merge metadata keys into the task (set a key to null to delete it)
- **addBlocks**: Mark tasks that cannot start until this one completes
- **addBlockedBy**: Mark tasks that must complete before this one can start

## Status Workflow

Status progresses: \`pending\` → \`in_progress\` → \`completed\`

Use \`deleted\` to permanently remove a task.

## Staleness

Make sure to read a task's latest state using \`TaskGet\` before updating it.

## Examples

Mark task as in progress when starting work:
\`\`\`json
{"taskId": "1", "status": "in_progress"}
\`\`\`

Mark task as completed after finishing work:
\`\`\`json
{"taskId": "1", "status": "completed"}
\`\`\`

Delete a task:
\`\`\`json
{"taskId": "1", "status": "deleted"}
\`\`\`

Claim a task by setting owner:
\`\`\`json
{"taskId": "1", "owner": "my-name"}
\`\`\`

Set up task dependencies:
\`\`\`json
{"taskId": "2", "addBlockedBy": ["1"]}
\`\`\`
`;

const ACTIVE_FORM_DESCRIPTION = 'Present continuous form shown in spinner when in_progress (e.g., "Running tests")';
const recordOfAny = (description: string) => ({ description, type: "object", propertyNames: { type: "string" }, additionalProperties: {} });
const stringArray = (description: string) => ({ description, type: "array", items: { type: "string" } });

/** JSON schemas exactly as Claude Code declares them. */
export const TaskCreateParams = {
	type: "object",
	properties: {
		subject: { description: "A brief title for the task", type: "string" },
		description: { description: "What needs to be done", type: "string" },
		activeForm: { description: ACTIVE_FORM_DESCRIPTION, type: "string" },
		metadata: recordOfAny("Arbitrary metadata to attach to the task"),
	},
	required: ["subject", "description"],
	additionalProperties: false,
};

export const TaskGetParams = {
	type: "object",
	properties: { taskId: { description: "The ID of the task to retrieve", type: "string" } },
	required: ["taskId"],
	additionalProperties: false,
};

export const TaskListParams = { type: "object", properties: {}, additionalProperties: false };

export const TaskUpdateParams = {
	type: "object",
	properties: {
		taskId: { description: "The ID of the task to update", type: "string" },
		subject: { description: "New subject for the task", type: "string" },
		description: { description: "New description for the task", type: "string" },
		activeForm: { description: ACTIVE_FORM_DESCRIPTION, type: "string" },
		status: {
			description: "New status for the task",
			anyOf: [
				{ type: "string", enum: ["pending", "in_progress", "completed"] },
				{ type: "string", const: "deleted" },
			],
		},
		addBlocks: stringArray("Task IDs that this task blocks"),
		addBlockedBy: stringArray("Task IDs that block this task"),
		owner: { description: "New owner for the task", type: "string" },
		metadata: recordOfAny("Metadata keys to merge into the task. Set a key to null to delete it."),
	},
	required: ["taskId"],
	additionalProperties: false,
};

// zod-equivalent specs used for Claude Code-style validation errors
const str: Spec = { kind: "string" };
const anyRecord: Spec = { kind: "record", value: { kind: "unknown" } };
const strArray: Spec = { kind: "array", items: str };
const TASK_STATUSES = ["pending", "in_progress", "completed"] as const;

const TaskCreateSpec: Spec = {
	kind: "object",
	props: { subject: { spec: str }, description: { spec: str }, activeForm: { spec: str, optional: true }, metadata: { spec: anyRecord, optional: true } },
};
const TaskGetSpec: Spec = { kind: "object", props: { taskId: { spec: str } } };
const TaskListSpec: Spec = { kind: "object", props: {} };
const TaskUpdateSpec: Spec = {
	kind: "object",
	props: {
		taskId: { spec: str },
		subject: { spec: str, optional: true },
		description: { spec: str, optional: true },
		activeForm: { spec: str, optional: true },
		status: { spec: { kind: "union", options: [{ kind: "enum", values: TASK_STATUSES }, { kind: "literal", value: "deleted" }] }, optional: true },
		addBlocks: { spec: strArray, optional: true },
		addBlockedBy: { spec: strArray, optional: true },
		owner: { spec: str, optional: true },
		metadata: { spec: anyRecord, optional: true },
	},
};

export interface TaskCreateInput {
	subject: string;
	description: string;
	activeForm?: string;
	metadata?: Record<string, unknown>;
}
export interface TaskUpdateInput {
	taskId: string;
	subject?: string;
	description?: string;
	activeForm?: string;
	status?: TaskStatus | "deleted";
	addBlocks?: string[];
	addBlockedBy?: string[];
	owner?: string;
	metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------------
// Input repair (Claude Code's coerceInput / validationErrorSteer for these tools)
// ---------------------------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const hasTaskArray = (o: Record<string, unknown>) => "tasks" in o || "todos" in o;
const hasAgentParams = (o: Record<string, unknown>) => "prompt" in o || "subagent_type" in o;

const CREATE_KEYS = new Set(["subject", "description", "activeForm", "metadata"]);
const CREATE_ALIASES: Array<[string[], string]> = [
	[["title", "name"], "subject"],
	[["content"], "description"],
	[["active_form"], "activeForm"],
];
const UPDATE_ALIASES: Array<[string[], string]> = [
	[["id", "task_id"], "taskId"],
	[["active_form"], "activeForm"],
];

/** A subject derived from a description: its first line, at most 80 characters, cut at a word boundary. */
export function subjectFromDescription(description: string): string {
	const text = firstLine(description).trim();
	const chars = Array.from(text);
	if (chars.length <= 80) return text;
	const head = chars.slice(0, 80).join("");
	const cut = head.lastIndexOf(" ");
	return (cut > 40 ? head.slice(0, cut) : head).trim();
}

function firstLine(text: string): string {
	return text.split("\n")[0];
}

/** TaskCreate input repair: aliases, a `task` wrapper, a missing subject/description, unknown keys. */
export function coerceTaskCreateInput(input: unknown): Record<string, unknown> | null {
	if (!isObj(input) || hasTaskArray(input)) return null;
	const changes: string[] = [];
	const r: Record<string, unknown> = { ...input };
	if (hasAgentParams(r) && !(nonEmpty(r.subject) && nonEmpty(r.description))) return null;
	if (!("subject" in r) && !("description" in r) && "task" in r) {
		const task = r.task;
		if (nonEmpty(task)) {
			delete r.task;
			r.description = task;
			changes.push("task_wrapper_string");
		} else if (isObj(task)) {
			if (hasTaskArray(task)) return null;
			if (hasAgentParams(task) && !(nonEmpty(task.subject) && nonEmpty(task.description))) return null;
			delete r.task;
			Object.assign(r, task);
			changes.push("task_wrapper_object");
		} else return null;
	}
	for (const [aliases, target] of CREATE_ALIASES) {
		for (const alias of aliases) {
			if (alias in r && !(target in r) && nonEmpty(r[alias])) {
				r[target] = r[alias];
				delete r[alias];
				changes.push(`alias_${alias}`);
			}
		}
	}
	if (nonEmpty(r.subject) && !("description" in r)) {
		r.description = r.subject;
		changes.push("backfill_description");
	} else if (nonEmpty(r.description) && !("subject" in r)) {
		r.subject = subjectFromDescription(r.description);
		changes.push("backfill_subject");
	}
	if (nonEmpty(r.subject) && nonEmpty(r.description)) {
		for (const key of Object.keys(r)) {
			if (!CREATE_KEYS.has(key)) {
				delete r[key];
				changes.push(`strip_${key}`);
			}
		}
		if ("activeForm" in r && typeof r.activeForm !== "string") {
			delete r.activeForm;
			changes.push("drop_invalid_activeForm");
		}
		if ("metadata" in r && !isObj(r.metadata)) {
			delete r.metadata;
			changes.push("drop_invalid_metadata");
		}
	}
	return changes.length ? r : null;
}

/** TaskUpdate input repair: `id`/`task_id` → taskId, `active_form` → activeForm. */
export function coerceTaskUpdateInput(input: unknown): Record<string, unknown> | null {
	if (!isObj(input)) return null;
	const r: Record<string, unknown> = { ...input };
	let changed = false;
	for (const [aliases, target] of UPDATE_ALIASES) {
		for (const alias of aliases) {
			if (alias in r && !(target in r) && nonEmpty(r[alias])) {
				r[target] = r[alias];
				delete r[alias];
				changed = true;
			}
		}
	}
	return changed ? r : null;
}

function taskCreateSteer(input: unknown): string | null {
	if (!isObj(input)) return null;
	const task = isObj(input.task) ? input.task : null;
	if (hasTaskArray(input) || (task !== null && hasTaskArray(task))) {
		return "TaskCreate creates ONE task per call and has no `tasks` or `todos` parameter. Call TaskCreate once per task, passing `subject` (a brief title) and `description` (what needs to be done) as top-level string parameters.";
	}
	if ((hasAgentParams(input) || (task !== null && hasAgentParams(task))) && !(nonEmpty(input.subject) && nonEmpty(input.description))) {
		return "This call used Agent-tool parameters (`prompt`/`subagent_type`). TaskCreate adds an item to the task list and takes `subject` and `description` string parameters. To delegate work to a subagent, use the Agent tool instead.";
	}
	return null;
}

// ---------------------------------------------------------------------------------------------
// Task list store
// ---------------------------------------------------------------------------------------------

function cloneTask(t: TaskItem): TaskItem {
	const copy: TaskItem = { ...t, blocks: [...t.blocks], blockedBy: [...t.blockedBy] };
	if (t.metadata) copy.metadata = { ...t.metadata };
	return copy;
}

/** Who changed a TaskStore: the session that owns it, or a (subagent) session sharing it. */
export type TaskChangeSource = "owner" | "shared";

/**
 * Custom session entry (`pi.appendEntry`) holding the task list after a foreground subagent sharing
 * the parent's list changed it. The subagent's own TaskCreate/TaskUpdate results live in its
 * in-memory session, so the parent records the state in its own branch for resume/fork/tree.
 */
export const TASK_STATE_ENTRY_TYPE = "pi-claude-task-list";

/** In-memory task list with Claude Code's semantics (ids, dependencies, deletion). */
export class TaskStore {
	private listeners = new Set<(source: TaskChangeSource) => void>();
	/** Called after the store changed; `source` is "shared" when a session sharing it (a subagent) changed it. */
	subscribe(fn: (source: TaskChangeSource) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}
	notify(source: TaskChangeSource = "owner"): void {
		for (const fn of this.listeners) fn(source);
	}

	private tasks = new Map<string, TaskItem>();
	private highWaterMark = 0;

	constructor(state?: TaskListState) {
		if (state) this.load(state);
	}

	load(state: TaskListState): void {
		this.tasks = new Map(state.tasks.map((t) => [t.id, cloneTask(t)]));
		this.highWaterMark = state.highWaterMark ?? 0;
	}

	snapshot(): TaskListState {
		return { tasks: this.list().map(cloneTask), highWaterMark: this.highWaterMark };
	}

	/** All tasks, sorted by numeric id. */
	list(): TaskItem[] {
		return [...this.tasks.values()].sort((a, b) => Number(a.id) - Number(b.id));
	}

	get(id: string): TaskItem | undefined {
		return this.tasks.get(id);
	}

	create(fields: Omit<TaskItem, "id">): string {
		const ids = [...this.tasks.keys()].map(Number).filter(Number.isFinite);
		const id = String(Math.max(this.highWaterMark, 0, ...ids) + 1);
		this.tasks.set(id, { id, ...fields });
		this.highWaterMark = Number(id);
		return id;
	}

	update(id: string, fields: Partial<TaskItem>): void {
		const t = this.tasks.get(id);
		if (t) this.tasks.set(id, { ...t, ...fields, id });
	}

	/** Delete a task and drop it from every other task's dependencies. */
	delete(id: string): boolean {
		const n = Number.parseInt(id, 10);
		if (!Number.isNaN(n) && n > this.highWaterMark) this.highWaterMark = n;
		if (!this.tasks.delete(id)) return false;
		for (const t of this.tasks.values()) {
			t.blocks = t.blocks.filter((b) => b !== id);
			t.blockedBy = t.blockedBy.filter((b) => b !== id);
		}
		return true;
	}

	/** `from` blocks `to` (both must exist). */
	block(from: string, to: string): boolean {
		const a = this.tasks.get(from);
		const b = this.tasks.get(to);
		if (!a || !b) return false;
		if (!a.blocks.includes(to)) a.blocks = [...a.blocks, to];
		if (!b.blockedBy.includes(from)) b.blockedBy = [...b.blockedBy, from];
		return true;
	}
}

// ---------------------------------------------------------------------------------------------
// Result text
// ---------------------------------------------------------------------------------------------

export function formatTaskGet(t: TaskItem | undefined): string {
	if (!t) return "Task not found";
	const lines = [`Task #${t.id}: ${t.subject}`, `Status: ${t.status}`, `Description: ${t.description}`];
	if (t.blockedBy.length > 0) lines.push(`Blocked by: ${t.blockedBy.map((id) => `#${id}`).join(", ")}`);
	if (t.blocks.length > 0) lines.push(`Blocks: ${t.blocks.map((id) => `#${id}`).join(", ")}`);
	return lines.join("\n");
}

export function formatTaskList(tasks: TaskItem[]): string {
	const visible = tasks.filter((t) => !t.metadata?._internal);
	if (visible.length === 0) return "No tasks found";
	const completed = new Set(visible.filter((t) => t.status === "completed").map((t) => t.id));
	return visible
		.map((t) => {
			const owner = t.owner ? ` (${t.owner})` : "";
			const open = t.blockedBy.filter((id) => !completed.has(id));
			const blocked = open.length > 0 ? ` [blocked by ${open.map((id) => `#${id}`).join(", ")}]` : "";
			return `#${t.id} [${t.status}] ${t.subject}${owner}${blocked}`;
		})
		.join("\n");
}

function mergeMetadata(current: Record<string, unknown> | undefined, patch: Record<string, unknown>): Record<string, unknown> {
	const out = { ...current };
	for (const [k, v] of Object.entries(patch)) {
		if (v === null) delete out[k];
		else out[k] = v;
	}
	return out;
}

/** Apply a TaskUpdate call to the store and return Claude Code's result text. */
export function applyTaskUpdate(store: TaskStore, input: TaskUpdateInput): string {
	const { taskId } = input;
	const task = store.get(taskId);
	if (!task) return "Task not found";
	const before = cloneTask(task);
	const updated: string[] = [];
	const patch: Partial<TaskItem> = {};
	if (input.subject !== undefined && input.subject !== before.subject) {
		patch.subject = input.subject;
		updated.push("subject");
	}
	if (input.description !== undefined && input.description !== before.description) {
		patch.description = input.description;
		updated.push("description");
	}
	if (input.activeForm !== undefined && input.activeForm !== before.activeForm) {
		patch.activeForm = input.activeForm;
		updated.push("activeForm");
	}
	if (input.owner !== undefined && input.owner !== before.owner) {
		patch.owner = input.owner;
		updated.push("owner");
	}
	if (input.metadata !== undefined) {
		patch.metadata = mergeMetadata(before.metadata, input.metadata);
		updated.push("metadata");
	}
	if (input.status !== undefined) {
		if (input.status === "deleted") {
			// other field changes in the same call are discarded, as in Claude Code
			return store.delete(taskId) ? `Updated task #${taskId} deleted` : "Failed to delete task";
		}
		if (input.status !== before.status) {
			patch.status = input.status;
			updated.push("status");
		}
	}
	if (Object.keys(patch).length > 0) store.update(taskId, patch);
	if (input.addBlocks && input.addBlocks.length > 0) {
		const added = input.addBlocks.filter((id) => !before.blocks.includes(id));
		for (const id of added) store.block(taskId, id);
		if (added.length > 0) updated.push("blocks");
	}
	if (input.addBlockedBy && input.addBlockedBy.length > 0) {
		const added = input.addBlockedBy.filter((id) => !before.blockedBy.includes(id));
		for (const id of added) store.block(id, taskId);
		if (added.length > 0) updated.push("blockedBy");
	}
	return `Updated task #${taskId} ${updated.join(", ")}`;
}

// ---------------------------------------------------------------------------------------------
// Reminder
// ---------------------------------------------------------------------------------------------

/**
 * Claude Code nudges the model when the task tools have not been used for a while: when at least
 * this many assistant content blocks (text and tool calls; thinking does not count) came after the
 * last TaskCreate/TaskUpdate call and after the last reminder.
 */
export const TASK_REMINDER_TURNS = 10;

/** `details.kind` of injected task reminder messages. */
export const TASK_REMINDER_KIND = "task_reminder";

/** Claude Code's reminder text, listing the current tasks. */
export function buildTaskReminderText(tasks: TaskItem[]): string {
	let text =
		"The task tools haven't been used recently. If you're working on tasks that would benefit from tracking progress, consider using TaskCreate to add new tasks and TaskUpdate to update task status (set to in_progress when starting, completed when done). Also consider cleaning up the task list if it has become stale. Only use these if relevant to the current work. This is just a gentle reminder - ignore if not applicable.\n";
	if (tasks.length > 0) text += `\n\nHere are the existing tasks:\n\n${tasks.map((t) => `#${t.id}. [${t.status}] ${t.subject}`).join("\n")}`;
	return text;
}

/**
 * Latest task list found in successful TaskCreate/TaskUpdate results of a session branch (or in
 * the state entries recorded when a subagent changed the shared list).
 */
export function taskListFromBranch(entries: readonly any[]): TaskListState | undefined {
	let state: TaskListState | undefined;
	for (const entry of entries) {
		if (entry?.type === "custom" && entry.customType === TASK_STATE_ENTRY_TYPE) {
			const data = entry.data as Partial<TaskListState> | undefined;
			if (data && Array.isArray(data.tasks)) state = data as TaskListState;
			continue;
		}
		if (entry?.type !== "message") continue;
		const msg = entry.message;
		if (msg?.role !== "toolResult" || !MUTATING_TOOLS.has(msg.toolName) || msg.isError) continue;
		const list = (msg.details as Partial<TaskToolDetails> | undefined)?.taskList;
		if (list && Array.isArray(list.tasks)) state = list;
	}
	return state;
}

function messageKey(m: any, index: number): string {
	return `${index}:${m?.role}:${m?.timestamp ?? ""}:${m?.toolCallId ?? ""}`;
}

function reminderMessage(content: string) {
	return { role: "custom", customType: REMINDER_CUSTOM_TYPE, content, display: false, details: { kind: TASK_REMINDER_KIND }, timestamp: Date.now() };
}

// ---------------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------------

export function registerTaskTools(pi: ExtensionAPI, cc: CCContext): void {
	// Foreground subagents share the parent's list; the parent owns persistence and host events.
	const shared = cc.options.sharedTaskStore;
	const store = shared ?? new TaskStore();
	cc.taskStore = store;
	/** Reminders injected so far, by the key of the message they follow (re-inserted on every call). */
	let reminders = new Map<string, string>();

	const publish = () => {
		const tasks = store.list().map(cloneTask);
		cc.emit({ type: "todos_updated", todos: tasks.map(taskToTodo) });
		cc.emit({ type: "tasks_updated", tasks });
	};

	if (!shared) {
		store.subscribe((source) => {
			publish();
			// a subagent changed the list: record it in this session's branch, which reconstruct() reads
			if (source === "shared") {
				try {
					pi.appendEntry(TASK_STATE_ENTRY_TYPE, store.snapshot());
				} catch {
					// no session to record into (e.g. a host without session storage)
				}
			}
		});
	}

	const reconstruct = (ctx: ExtensionContext) => {
		if (shared) return; // the parent's branch is the source of truth
		let entries: readonly any[] = [];
		try {
			entries = ctx.sessionManager?.getBranch?.() ?? [];
		} catch {
			entries = [];
		}
		store.load(taskListFromBranch(entries) ?? { tasks: [], highWaterMark: 0 });
		reminders = new Map();
		publish();
	};

	// session_start covers startup, reload, new, resume and fork; session_tree covers /tree navigation.
	pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));

	const mutated = (text: string) => {
		store.notify(shared ? "shared" : "owner"); // owner publishes (and persists a subagent's change)
		return textResult<TaskToolDetails>(text, { taskList: store.snapshot() });
	};

	pi.registerTool({
		name: TASK_CREATE_TOOL_NAME,
		label: "TaskCreate",
		description: TASK_CREATE_DESCRIPTION,
		promptSnippet: "TaskCreate: add a task to the session task list",
		parameters: TaskCreateParams as any,
		prepareArguments: claudeInputValidator<TaskCreateInput>(TASK_CREATE_TOOL_NAME, TaskCreateSpec, { coerce: coerceTaskCreateInput, steer: taskCreateSteer }),
		async execute(_toolCallId, params) {
			const { subject, description, activeForm, metadata } = params as TaskCreateInput;
			const id = store.create({ subject, description, activeForm, status: "pending", owner: undefined, blocks: [], blockedBy: [], metadata });
			return mutated(`Task #${id} created successfully: ${subject}`);
		},
	});

	pi.registerTool({
		name: TASK_GET_TOOL_NAME,
		label: "TaskGet",
		description: TASK_GET_DESCRIPTION,
		promptSnippet: "TaskGet: show one task with its description and dependencies",
		parameters: TaskGetParams as any,
		prepareArguments: claudeInputValidator(TASK_GET_TOOL_NAME, TaskGetSpec),
		async execute(_toolCallId, params) {
			return textResult(formatTaskGet(store.get((params as { taskId: string }).taskId)));
		},
	});

	pi.registerTool({
		name: TASK_LIST_TOOL_NAME,
		label: "TaskList",
		description: TASK_LIST_DESCRIPTION,
		promptSnippet: "TaskList: list all tasks with status, owner and blockers",
		parameters: TaskListParams as any,
		prepareArguments: claudeInputValidator(TASK_LIST_TOOL_NAME, TaskListSpec),
		async execute() {
			return textResult(formatTaskList(store.list()));
		},
	});

	pi.registerTool({
		name: TASK_UPDATE_TOOL_NAME,
		label: "TaskUpdate",
		description: TASK_UPDATE_DESCRIPTION,
		promptSnippet: "TaskUpdate: change a task's status, fields or dependencies, or delete it",
		parameters: TaskUpdateParams as any,
		prepareArguments: claudeInputValidator<TaskUpdateInput>(TASK_UPDATE_TOOL_NAME, TaskUpdateSpec, { coerce: coerceTaskUpdateInput }),
		async execute(_toolCallId, params) {
			return mutated(applyTaskUpdate(store, params as TaskUpdateInput));
		},
	});

	/*
	 * Reminder. Claude Code adds it to the conversation as a persistent attachment. Here it is
	 * injected in the `context` hook (synchronous with the model call it targets, branch-correct)
	 * and remembered by the message it follows, so later calls see it at the same position (stable
	 * prompt prefix) without storing it in the session.
	 */
	pi.on("context", async (event) => {
		const input = event.messages as any[];
		if (input.length === 0) return undefined;
		const messages: any[] = [];
		let sinceTaskTool = 0;
		let sinceReminder = 0;
		let reinserted = false;
		input.forEach((m, i) => {
			messages.push(m);
			if (m?.role === "assistant" && Array.isArray(m.content)) {
				for (const block of m.content) {
					if (block?.type === "thinking" || block?.type === "redactedThinking") continue;
					if (block?.type === "toolCall" && MUTATING_TOOLS.has(block.name)) sinceTaskTool = 0;
					else sinceTaskTool++;
					sinceReminder++;
				}
			}
			const text = reminders.get(messageKey(m, i));
			if (text !== undefined) {
				messages.push(reminderMessage(text));
				sinceReminder = 0;
				reinserted = true;
			}
		});
		if (sinceTaskTool >= TASK_REMINDER_TURNS && sinceReminder >= TASK_REMINDER_TURNS) {
			const text = wrapReminder(buildTaskReminderText(store.list()));
			reminders.set(messageKey(input.at(-1), input.length - 1), text);
			messages.push(reminderMessage(text));
			return { messages };
		}
		return reinserted ? { messages } : undefined;
	});
}

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CCContext } from "../shared/context.js";
import { REMINDER_CUSTOM_TYPE, wrapReminder } from "../shared/reminders.js";
import { textResult } from "../shared/text.js";
import type { TodoItem } from "../shared/types.js";

export const TODO_WRITE_TOOL_NAME = "TodoWrite";

/**
 * Remind the model about the todo list after this many assistant turns without a TodoWrite call
 * (and at most once per this many turns).
 */
export const TODO_REMINDER_TURNS = 10;

/** `details.kind` of injected todo reminder messages. */
export const TODO_REMINDER_KIND = "todo_reminder";

export interface TodoWriteDetails {
	todos: TodoItem[];
}

export const TODO_WRITE_DESCRIPTION = `Use this tool to create and manage a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
It also helps the user understand the progress of the task and overall progress of their requests.

## When to Use This Tool
Use this tool proactively in these scenarios:

1. Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
2. Non-trivial and complex tasks - Tasks that require careful planning or multiple operations
3. User explicitly requests todo list - When the user directly asks you to use the todo list
4. User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)
5. After receiving new instructions - Immediately capture user requirements as todos
6. When you start working on a task - Mark it as in_progress BEFORE beginning work. Ideally you should only have one todo as in_progress at a time
7. After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation

## When NOT to Use This Tool

Skip using this tool when:
1. There is only a single, straightforward task
2. The task is trivial and tracking it provides no organizational benefit
3. The task can be completed in less than 3 trivial steps
4. The task is purely conversational or informational

NOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.

## Examples of When to Use the Todo List

<example>
User: I want to add a dark mode toggle to the application settings. Make sure you run the tests and build when you're done!
Assistant: I'll help add a dark mode toggle to your application settings. Let me create a todo list to track this implementation.
*Creates todo list with the following items:*
1. Creating dark mode toggle component in Settings page
2. Adding dark mode state management (context/store)
3. Implementing CSS-in-JS styles for dark theme
4. Updating existing components to support theme switching
5. Running tests and build process, addressing any failures or errors that occur
*Begins working on the first task*

<reasoning>
The assistant used the todo list because:
1. Adding dark mode is a multi-step feature requiring UI, state management, and styling changes
2. The user explicitly requested tests and build be run afterward
3. The assistant inferred that tests and build need to pass by adding "Ensure tests and build succeed" as the final task
</reasoning>
</example>

<example>
User: I need to rename the function getCwd to getCurrentWorkingDirectory across my project
Assistant: Let me first search through your codebase to find all occurrences of 'getCwd'.
*Uses grep or search tools to locate all instances of getCwd in the codebase*
Assistant: I've found 15 instances of 'getCwd' across 8 different files. Let me create a todo list to track these changes.
*Creates todo list with specific items for each file that needs updating*

<reasoning>
The assistant used the todo list because:
1. First, the assistant searched to understand the scope of the task
2. Upon finding multiple occurrences across different files, it determined this was a complex task with multiple steps
3. The todo list helps ensure every instance is tracked and updated systematically
4. This approach prevents missing any occurrences and maintains code consistency
</reasoning>
</example>

<example>
User: I need to implement these features for my e-commerce site: user registration, product catalog, shopping cart, and checkout flow.
Assistant: I'll help implement these features. First, let's add all the features to the todo list.
*Creates a todo list breaking down each feature into specific tasks based on the project architecture*
Assistant: Let's start with user registration. This will involve creating database models, API endpoints, and frontend forms that integrate with your existing authentication system.

<reasoning>
The assistant used the todo list because:
1. The user provided multiple complex features to implement in a comma separated list
2. The todo list helps organize these large features into manageable tasks
3. This approach allows for tracking progress across the entire implementation
</reasoning>
</example>

## Examples of When NOT to Use the Todo List

<example>
User: How do I print 'Hello World' in Python?
Assistant: In Python, you can print "Hello World" with this simple code:

python
print("Hello World")

This will output the text "Hello World" to the console when executed.

<reasoning>
The assistant did not use the todo list because this is a single, trivial task that can be completed in one step. There's no need to track multiple tasks or steps for such a straightforward request.
</reasoning>
</example>

<example>
User: Can you add a comment to the calculateTotal function to explain what it does?
Assistant: Sure, let me add a comment to the calculateTotal function to explain what it does.
*Uses the Edit tool to add a comment to the calculateTotal function*

<reasoning>
The assistant did not use the todo list because this is a single, straightforward task confined to one location in the code. Adding a comment doesn't require tracking multiple steps or systematic organization.
</reasoning>
</example>

<example>
User: Run npm install for me and tell me what happens.
Assistant: I'll run the npm install command for you.
*Executes: npm install*
The command completed successfully. Here's the output: [Output of npm install command]

<reasoning>
The assistant did not use the todo list because this is a single command execution with immediate results. There are no multiple steps to track or organize, making the todo list unnecessary for this straightforward task.
</reasoning>
</example>

## Task States and Management

1. **Task States**: Use these states to track progress:
   - pending: Task not yet started
   - in_progress: Currently working on (limit to ONE task at a time)
   - completed: Task finished successfully

   **IMPORTANT**: Task descriptions must have two forms:
   - content: The imperative form describing what needs to be done (e.g., "Run tests", "Build the project")
   - activeForm: The present continuous form shown during execution (e.g., "Running tests", "Building the project")

2. **Task Management**:
   - Update task status in real-time as you work
   - Mark tasks complete IMMEDIATELY after finishing (don't batch completions)
   - Exactly ONE task must be in_progress at any time (not less, not more)
   - Complete current tasks before starting new ones
   - Remove tasks that are no longer relevant from the list entirely

3. **Task Completion Requirements**:
   - ONLY mark a task as completed when you have FULLY accomplished it
   - If you encounter errors, blockers, or cannot finish, keep the task as in_progress
   - When blocked, create a new task describing what needs to be resolved
   - Never mark a task as completed if:
     - Tests are failing
     - Implementation is partial
     - You encountered unresolved errors
     - You couldn't find necessary files or dependencies

4. **Task Breakdown**:
   - Create specific, actionable items
   - Break complex tasks into smaller, manageable steps
   - Use clear, descriptive task names
   - Always provide both forms:
     - content: "Fix authentication bug"
     - activeForm: "Fixing authentication bug"

When in doubt, use this tool. Being proactive with task management demonstrates attentiveness and ensures you complete all requirements successfully.`;

const TodoItemSchema = Type.Object(
	{
		content: Type.String({ minLength: 1 }),
		status: StringEnum(["pending", "in_progress", "completed"] as const),
		activeForm: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

export const TodoWriteParams = Type.Object(
	{
		todos: Type.Array(TodoItemSchema, { description: "The updated todo list" }),
	},
	{ additionalProperties: false },
);

const STATUSES = new Set(["pending", "in_progress", "completed"]);

export const TODO_WRITE_RESULT_TEXT =
	"Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable";

/** Validate and normalize raw `todos` input. Throws a model-facing Error on invalid input. */
export function validateTodos(raw: unknown): TodoItem[] {
	if (!Array.isArray(raw)) throw new Error("Invalid input: `todos` must be an array.");
	return raw.map((item, i) => {
		if (!item || typeof item !== "object") throw new Error(`Invalid input: todos[${i}] must be an object.`);
		const { content, activeForm, status } = item as Record<string, unknown>;
		if (typeof content !== "string" || content.trim() === "") {
			throw new Error(`Invalid input: todos[${i}].content must be a non-empty string.`);
		}
		if (typeof activeForm !== "string" || activeForm.trim() === "") {
			throw new Error(`Invalid input: todos[${i}].activeForm must be a non-empty string.`);
		}
		if (typeof status !== "string" || !STATUSES.has(status)) {
			throw new Error(`Invalid input: todos[${i}].status must be one of "pending", "in_progress", "completed".`);
		}
		return { content, activeForm, status: status as TodoItem["status"] };
	});
}

/** Reminder text (Claude Code wording) including the current todo list. */
export function buildTodoReminderText(todos: TodoItem[]): string {
	let text =
		"The TodoWrite tool hasn't been used recently. If you're working on tasks that would benefit from tracking progress, consider using the TodoWrite tool to track progress. " +
		"Also consider cleaning up the todo list if has become stale and no longer matches what you are working on. " +
		"Only use it if it's relevant to the current work. This is just a gentle reminder - ignore if not applicable. " +
		"Make sure that you NEVER mention this reminder to the user";
	if (todos.length > 0) {
		text += `\n\nHere are the existing contents of your todo list:\n\n[${todos
			.map((t, i) => `${i + 1}. [${t.status}] ${t.content}`)
			.join("\n")}]`;
	}
	return text;
}

function isTodoWriteCall(c: any): boolean {
	return !!c && c.type === "toolCall" && c.name === TODO_WRITE_TOOL_NAME;
}

/** Latest todo list found in successful TodoWrite tool results of a session branch (undefined when none). */
export function todosFromBranch(entries: readonly any[]): TodoItem[] | undefined {
	let todos: TodoItem[] | undefined;
	for (const entry of entries) {
		if (entry?.type !== "message") continue;
		const msg = entry.message;
		if (msg?.role !== "toolResult" || msg.toolName !== TODO_WRITE_TOOL_NAME || msg.isError) continue;
		const details = msg.details as Partial<TodoWriteDetails> | undefined;
		if (details && Array.isArray(details.todos)) todos = details.todos.map((t) => ({ ...t }));
	}
	return todos;
}

export function registerTodoWrite(pi: ExtensionAPI, cc: CCContext): void {
	let todos: TodoItem[] = [];
	/** Number of assistant messages in context when the last reminder was injected. */
	let remindedAtAssistantCount: number | undefined;

	const publish = () => cc.emit({ type: "todos_updated", todos: todos.map((t) => ({ ...t })) });

	const reconstruct = (ctx: ExtensionContext) => {
		let entries: readonly any[] = [];
		try {
			entries = ctx.sessionManager?.getBranch?.() ?? [];
		} catch {
			entries = [];
		}
		todos = todosFromBranch(entries) ?? [];
		remindedAtAssistantCount = undefined;
		publish();
	};

	// session_start covers startup, reload, new, resume and fork; session_tree covers /tree navigation.
	pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));

	pi.registerTool({
		name: TODO_WRITE_TOOL_NAME,
		label: "TodoWrite",
		description: TODO_WRITE_DESCRIPTION,
		promptSnippet: "TodoWrite: create and update a structured task list to track progress on multi-step work",
		parameters: TodoWriteParams,
		async execute(_toolCallId, params, signal) {
			if (signal?.aborted) throw new Error("TodoWrite was aborted");
			const next = validateTodos((params as any)?.todos);
			todos = next;
			publish();
			let text = TODO_WRITE_RESULT_TEXT;
			const inProgress = next.filter((t) => t.status === "in_progress").length;
			if (inProgress > 1) {
				text += `\n\nWarning: ${inProgress} tasks are marked in_progress. Keep exactly ONE task in_progress at a time; mark the others pending or completed.`;
			}
			return textResult<TodoWriteDetails>(text, { todos: next.map((t) => ({ ...t })) });
		},
	});

	/*
	 * Reminder. Turns are counted from the LLM context right before each model call (the
	 * `context` hook) rather than from `turn_end`: pi runs extension `turn_end` handlers
	 * asynchronously relative to the agent loop, so a steer message sent from there is picked up
	 * one turn late (or forces an extra LLM call when the run was about to finish), and a
	 * "nextTurn" message waits for the next user prompt. Injecting in `context` is synchronous with
	 * the model call it targets and naturally branch-correct. The injected reminder is transient
	 * (seen by the model on that call, not persisted to the session).
	 */
	pi.on("context", async (event) => {
		const messages = event.messages as any[];
		let assistantCount = 0;
		let sinceTodo = 0;
		let everUsed = false;
		for (const m of messages) {
			if (m?.role !== "assistant") continue;
			assistantCount++;
			if (Array.isArray(m.content) && m.content.some(isTodoWriteCall)) {
				sinceTodo = 0;
				everUsed = true;
			} else {
				sinceTodo++;
			}
		}
		// branch navigation / compaction can shrink the context below the last reminder point
		if (remindedAtAssistantCount !== undefined && assistantCount < remindedAtAssistantCount) remindedAtAssistantCount = undefined;
		if (sinceTodo < TODO_REMINDER_TURNS) return undefined;
		if (remindedAtAssistantCount !== undefined && assistantCount - remindedAtAssistantCount < TODO_REMINDER_TURNS) return undefined;
		// used before but nothing left to do -> no nudge
		if (everUsed && !todos.some((t) => t.status !== "completed")) return undefined;
		remindedAtAssistantCount = assistantCount;
		const reminder = {
			role: "custom",
			customType: REMINDER_CUSTOM_TYPE,
			content: wrapReminder(buildTodoReminderText(todos)),
			display: false,
			details: { kind: TODO_REMINDER_KIND },
			timestamp: Date.now(),
		};
		return { messages: [...messages, reminder] as any };
	});
}

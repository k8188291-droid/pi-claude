import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionFactory, ModelRuntime } from "@earendil-works/pi-coding-agent";

/** One question passed to AskUserQuestion (Claude Code-compatible shape). */
export interface AskUserQuestionItem {
	question: string;
	header: string;
	options: Array<{ label: string; description: string }>;
	multiSelect: boolean;
}

/**
 * Host answers keyed by question text. For multiSelect questions, join labels with ", ".
 * Free-text answers ("Other") are allowed as arbitrary strings.
 */
export type AskUserQuestionAnswers = Record<string, string | string[]>;

/** Full host reply: answers plus optional per-question annotations or a free-form response. */
export interface AskUserQuestionReply {
	answers: AskUserQuestionAnswers;
	annotations?: Record<string, { preview?: string; notes?: string }>;
	/** Free-form response instead of (or in addition to) answers. */
	response?: string;
}

export interface TodoItem {
	content: string;
	activeForm: string;
	status: "pending" | "in_progress" | "completed";
}

/** Subagent definition (mirrors Claude Agent SDK `AgentDefinition`). */
export interface AgentDefinition {
	description: string;
	prompt: string;
	/** Tool names the subagent may use. Omit to inherit all parent tools (except Task). */
	tools?: string[];
	/**
	 * Model override: a pi Model, a model id ("provider/id" or bare id), an alias
	 * ("sonnet" | "opus" | "haiku"), or "inherit" (default).
	 */
	model?: Model<any> | string;
}

/** Events pushed to the SDK host via `onEvent`. */
export type ClaudeCodeHostEvent =
	| { type: "todos_updated"; todos: TodoItem[] }
	| { type: "tasks_updated"; tasks: import("../tools/task-tools.js").TaskItem[] }
	| { type: "background_shell_started"; shellId: string; command: string }
	| { type: "background_shell_exited"; shellId: string; exitCode: number | null; signal?: string | null }
	| { type: "subagent_start"; agentId: string; parentToolCallId: string; subagentType: string; description: string; background: boolean }
	| { type: "subagent_event"; agentId: string; parentToolCallId: string; event: unknown }
	| { type: "subagent_end"; agentId: string; parentToolCallId: string; subagentType: string; isError: boolean; usage?: SubagentUsage }
	| { type: "output_spilled"; toolName: string; toolCallId: string; path: string; totalChars: number }
	| { type: "tools_activated"; names: string[] };

export interface SubagentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	costTotal: number;
	turns: number;
	toolUses: number;
	durationMs: number;
}

export interface OutputSpillOptions {
	/** Max characters of tool text output kept inline, for every tool. Default: per tool, like Claude Code (Grep 20000, Bash 30000, others 50000; Read is never spilled). */
	maxChars?: number;
	/** Characters of preview kept inline when spilling. Default 2000. */
	previewChars?: number;
	/** Directory where spilled outputs are written. Default: <os.tmpdir()>/pi-cc-tool-results/<sessionId>. */
	dir?: string;
	/** Tool names excluded from spilling (Read is always excluded to avoid loops). */
	exclude?: string[];
}

export interface ClaudeCodeToolsOptions {
	/** Host callback for AskUserQuestion. Without it, the tool returns an error to the model. */
	onAskUserQuestion?: (questions: AskUserQuestionItem[], ctx: { signal?: AbortSignal; toolCallId: string }) => Promise<AskUserQuestionAnswers | AskUserQuestionReply>;
	/** Receives host-facing notifications (todos, background shells, subagents, ...). */
	onEvent?: (event: ClaudeCodeHostEvent) => void;
	/** Large tool output → file. `false` disables. */
	outputSpill?: OutputSpillOptions | false;
	/** Extra/override subagent definitions (merged over built-ins and .claude/agents). */
	agents?: Record<string, AgentDefinition>;
	/** Load agent definitions from ~/.claude/agents and <cwd>/.claude/agents. Default true. */
	loadAgentsFromDisk?: boolean;
	/**
	 * Extra extension factories installed in every subagent session (e.g. the host's custom or
	 * MCP tools). The Claude Code tools themselves are always installed.
	 */
	subagentExtensions?: ExtensionFactory[];
	/** Enable the Task tool. Default true. */
	subagents?: boolean;
	/**
	 * Names of this package's tools to register with pi's native `exposure: "deferred"`: they are
	 * not declared to the model until pi's built-in `tool_search` finds them. createClaudeCodeSession
	 * installs and activates `tool_search` automatically. (Your own tools can set `exposure: "deferred"`
	 * themselves; MCP servers via their `exposure` setting.)
	 */
	deferredTools?: string[];
	/**
	 * Model runtime used for subagent sessions (credentials + model catalog). createClaudeCodeSession
	 * fills this in; when omitted, the parent session's runtime is used if it can be found.
	 */
	modelRuntime?: ModelRuntime;
	/** Bash defaults. */
	bash?: { defaultTimeoutMs?: number; maxTimeoutMs?: number };
	/** Internal: the parent's task list, shared with foreground subagents (as in Claude Code). */
	sharedTaskStore?: import("../tools/task-tools.js").TaskStore;
	/** Internal: set for subagent sessions (disables Task, AskUserQuestion, nested spill dir). */
	isSubagent?: boolean;
}

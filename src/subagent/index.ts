import { randomBytes } from "node:crypto";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentToolUpdateCallback,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionFactory,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createClaudeCodeSession } from "../sdk.js";
import type { CCContext } from "../shared/context.js";
import { sendReminder } from "../shared/reminders.js";
import type { ClaudeCodeHostEvent, SubagentUsage } from "../shared/types.js";
import { formatAgentList, loadAgentDefinitions, type SubagentDefinition } from "./agents.js";
import { resolveSubagentModel } from "./models.js";

export { BUILT_IN_AGENTS, loadAgentDefinitions, parseAgentMarkdown, type SubagentDefinition } from "./agents.js";
export { resolveSubagentModel } from "./models.js";

export const TASK_TOOL_NAME = "Task";
const DEFAULT_AGENT_TYPE = "general-purpose";
/** Finished child sessions kept around for `resume`. Oldest are disposed beyond this. */
const MAX_RETAINED_AGENTS = 20;

/**
 * Internal hooks (mainly for tests). `childExtensionFactories` are appended to every child session's
 * extensions (e.g. to give subagents extra tools); `homeDir` overrides where `~/.claude/agents` is read.
 */
export const subagentInternals: { childExtensionFactories: ExtensionFactory[]; homeDir?: string } = {
	childExtensionFactories: [],
	homeDir: undefined,
};

const TaskParams = Type.Object({
	description: Type.String({ description: "A short (3-5 word) description of the task" }),
	prompt: Type.String({ description: "The task for the agent to perform" }),
	subagent_type: Type.Optional(
		Type.String({ description: `The type of specialized agent to use for this task. Defaults to "${DEFAULT_AGENT_TYPE}".` }),
	),
	model: Type.Optional(
		Type.String({
			description:
				'Optional model override for this agent: an alias ("sonnet", "opus", "haiku"), a model id, or "provider/model-id". Takes precedence over the agent definition\'s model. If omitted, uses the agent definition\'s model, or inherits from the parent.',
		}),
	),
	run_in_background: Type.Optional(
		Type.Boolean({
			description: "Set to true to run this agent in the background. You will be notified automatically when it completes.",
		}),
	),
	resume: Type.Optional(
		Type.String({
			description:
				"Optional agent ID to resume from. If provided, the agent will continue from the previous execution transcript (subagent_type and model are ignored).",
		}),
	),
});

interface TaskInput {
	description: string;
	prompt: string;
	subagent_type?: string;
	model?: string;
	run_in_background?: boolean;
	resume?: string;
}

export interface TaskDetails {
	agentId: string;
	subagentType: string;
	description: string;
	status: "completed" | "async_launched" | "running";
	background: boolean;
	/** "provider/id" of the child's model. */
	model?: string;
	/** Set when the requested/defined model could not be resolved and the parent model was used. */
	modelNote?: string;
	usage?: SubagentUsage;
	toolUses?: number;
	lastToolName?: string;
}

export function buildTaskDescription(defs: Map<string, SubagentDefinition>, knownTools?: ReadonlySet<string>): string {
	return `Launch a new agent to handle complex, multi-step tasks autonomously.

The ${TASK_TOOL_NAME} tool launches specialized agents that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

Available agent types and the tools they have access to:
${formatAgentList(defs, knownTools)}

When using the ${TASK_TOOL_NAME} tool, specify a subagent_type parameter to select which agent type to use. If omitted, the ${DEFAULT_AGENT_TYPE} agent is used.

When NOT to use the ${TASK_TOOL_NAME} tool:
- If you want to read a specific file path, use the Read or Glob tool instead of the ${TASK_TOOL_NAME} tool, to find the match more quickly
- If you are searching for a specific class definition like "class Foo", use the Glob tool instead, to find the match more quickly
- If you are searching for code within a specific file or set of 2-3 files, use the Read tool instead of the ${TASK_TOOL_NAME} tool, to find the match more quickly
- Other tasks that are not related to the agent descriptions above

Usage notes:
- Always include a short description (3-5 words) summarizing what the agent will do
- Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses
- When the agent is done, it will return a single message back to you along with its agent ID. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.
- You can optionally run agents in the background using the run_in_background parameter. When an agent runs in the background, you will be automatically notified when it completes — do NOT sleep, poll, or proactively check on its progress. Continue with other work or respond to the user instead.
- Agents can be resumed using the \`resume\` parameter by passing the agent ID from a previous invocation. When resumed, the agent continues with its full previous context preserved. When NOT resuming, each invocation starts fresh and you should provide a detailed task description with all necessary context.
- Provide clear, detailed prompts so the agent can work autonomously, and specify exactly what information the agent should return back to you in its final message.
- The agent's outputs should generally be trusted
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent
- If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.
- If the user specifies that they want you to run agents "in parallel", you MUST send a single message with multiple ${TASK_TOOL_NAME} tool use content blocks. For example, if you need to launch both a code-reviewer agent and a test-runner agent in parallel, send a single message with both tool calls.

Example usage:

<example>
user: "Where are API errors handled in this codebase?"
assistant: I'll use the ${TASK_TOOL_NAME} tool with subagent_type "Explore" to search the codebase.
<commentary>
The question requires searching across many files with uncertain naming, so delegating to an exploration agent keeps the main context small.
</commentary>
</example>`;
}

function newAgentId(): string {
	return `a${randomBytes(8).toString("hex")}`;
}

function modelLabel(m: Model<any> | undefined): string | undefined {
	return m ? `${m.provider}/${m.id}` : undefined;
}

function isAssistant(m: unknown): m is AssistantMessage {
	return !!m && typeof m === "object" && (m as { role?: string }).role === "assistant";
}

function assistantText(m: AssistantMessage): string {
	return m.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();
}

/** Sum usage over the assistant messages of one run. */
export function computeSubagentUsage(messages: readonly unknown[], durationMs: number): SubagentUsage {
	const u: SubagentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costTotal: 0, turns: 0, toolUses: 0, durationMs };
	for (const m of messages) {
		if (!isAssistant(m)) continue;
		u.turns++;
		u.toolUses += m.content.filter((c) => c.type === "toolCall").length;
		const usage = m.usage;
		if (!usage) continue;
		u.input += usage.input ?? 0;
		u.output += usage.output ?? 0;
		u.cacheRead += usage.cacheRead ?? 0;
		u.cacheWrite += usage.cacheWrite ?? 0;
		u.totalTokens += usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
		u.costTotal += usage.cost?.total ?? 0;
	}
	return u;
}

function usageBlock(u: SubagentUsage): string {
	return `<usage>total_tokens: ${u.totalTokens}\ntool_uses: ${u.toolUses}\nduration_ms: ${u.durationMs}</usage>`;
}

function escapeXmlText(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Identifies the current run of an agent; child host events are tagged with it. */
interface RunTag {
	agentId: string;
	toolCallId: string;
}

interface AgentRecord {
	tag: RunTag;
	definition: SubagentDefinition;
	description: string;
	session: AgentSession;
	model?: Model<any>;
	modelNote?: string;
	running: boolean;
	background: boolean;
	/** Aborts the current run. */
	controller?: AbortController;
	/** Set when the parent session shuts down: no notification is delivered. */
	killed?: boolean;
	finishedAt: number;
}

interface RunResult {
	text: string;
	usage: SubagentUsage;
}

class SubagentAbortedError extends Error {
	constructor() {
		super("Subagent was aborted");
	}
}

export function registerTask(pi: ExtensionAPI, cc: CCContext): void {
	const records = new Map<string, AgentRecord>();
	let currentDescription: string | undefined;

	const loadDefs = (cwd: string) =>
		loadAgentDefinitions({
			cwd,
			agents: cc.options.agents,
			loadAgentsFromDisk: cc.options.loadAgentsFromDisk,
			homeDir: subagentInternals.homeDir,
		});

	const emit = (event: ClaudeCodeHostEvent) => cc.emit(event);

	async function disposeRecord(rec: AgentRecord): Promise<void> {
		records.delete(rec.tag.agentId);
		try {
			const runner = rec.session.extensionRunner;
			if (runner?.hasHandlers("session_shutdown")) await runner.emit({ type: "session_shutdown", reason: "quit" });
		} catch {
			// ignore child extension errors during teardown
		}
		try {
			rec.session.dispose();
		} catch {
			// ignore
		}
	}

	function evictFinished(): void {
		const finished = [...records.values()].filter((r) => !r.running).sort((a, b) => a.finishedAt - b.finishedAt);
		while (finished.length > MAX_RETAINED_AGENTS) void disposeRecord(finished.shift()!);
	}

	async function createChildSession(ctx: ExtensionContext, def: SubagentDefinition, model: Model<any> | undefined, tag: RunTag): Promise<AgentSession> {
		const tools = def.tools ? [...def.tools] : undefined;
		let deferredTools = cc.options.deferredTools;
		if (tools) {
			// keep only deferred tools the agent may use; tool_search must be allowed to load them
			deferredTools = (cc.options.deferredTools ?? []).filter((n) => tools.includes(n));
			if (deferredTools.length > 0) tools.push("tool_search");
		}
		let thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]> | undefined;
		try {
			thinkingLevel = pi.getThinkingLevel();
		} catch {
			thinkingLevel = undefined;
		}
		const registry = ctx.modelRegistry;
		const { session } = await createClaudeCodeSession({
			cwd: ctx.cwd,
			sessionManager: SessionManager.inMemory(ctx.cwd),
			settingsManager: SettingsManager.inMemory(),
			// share the parent's credentials and model catalog
			modelRuntime: cc.options.modelRuntime ?? (registry as unknown as { runtime?: ModelRuntime } | undefined)?.runtime,
			model,
			thinkingLevel,
			tools,
			claudeCode: {
				...cc.options,
				isSubagent: true,
				onAskUserQuestion: undefined,
				deferredTools,
				// child host events (todos, background shells, ...) are forwarded wrapped in subagent_event,
				// so they never clobber the parent's state in the host UI
				onEvent: (event) => emit({ type: "subagent_event", agentId: tag.agentId, parentToolCallId: tag.toolCallId, event }),
			},
			loader: {
				// no disk-discovered pi extensions/templates/themes/skills in children; context files (AGENTS.md/CLAUDE.md) are kept
				noExtensions: true,
				noPromptTemplates: true,
				noThemes: true,
				noSkills: true,
				systemPromptOverride: () => def.prompt,
				appendSystemPromptOverride: () => [],
				extensionFactories: [...(cc.options.subagentExtensions ?? []), ...subagentInternals.childExtensionFactories],
			},
		});
		try {
			await session.bindExtensions({});
		} catch (err) {
			session.dispose();
			throw err;
		}
		if (tools && deferredTools && deferredTools.length > 0) {
			// The `tools` allowlist keeps deferred tools registered but also activates them; deactivate
			// them so they stay deferred until tool_search loads them, as in the parent.
			const deferredSet = new Set(deferredTools);
			session.setActiveToolsByName(session.getActiveToolNames().filter((n) => !deferredSet.has(n)));
		}
		return session;
	}

	async function runAgent(
		rec: AgentRecord,
		prompt: string,
		signal: AbortSignal,
		onUpdate: AgentToolUpdateCallback<TaskDetails> | undefined,
	): Promise<RunResult> {
		const { session } = rec;
		const { agentId, toolCallId: parentToolCallId } = rec.tag;
		const subagentType = rec.definition.name;
		rec.running = true;
		emit({ type: "subagent_start", agentId, parentToolCallId, subagentType, description: rec.description, background: rec.background });

		const t0 = Date.now();
		const startIndex = session.messages.length;
		let toolUses = 0;
		const unsubscribe = session.subscribe((event) => {
			emit({ type: "subagent_event", agentId, parentToolCallId, event });
			if (event.type === "tool_execution_start" && onUpdate) {
				toolUses++;
				try {
					onUpdate({
						content: [{ type: "text", text: `[${subagentType}] ${event.toolName} (${toolUses} tool use${toolUses === 1 ? "" : "s"})` }],
						details: {
							agentId,
							subagentType,
							description: rec.description,
							status: "running",
							background: rec.background,
							toolUses,
							lastToolName: event.toolName,
						},
					});
				} catch {
					// progress is best-effort
				}
			}
		});
		const onAbort = () => {
			session.abort().catch(() => {});
		};
		signal.addEventListener("abort", onAbort, { once: true });

		let usage: SubagentUsage | undefined;
		let isError = true;
		try {
			if (signal.aborted) throw new SubagentAbortedError();
			await session.prompt(prompt, { expandPromptTemplates: false });
			const newMessages = session.messages.slice(startIndex);
			usage = computeSubagentUsage(newMessages, Date.now() - t0);
			const last = [...newMessages].reverse().find(isAssistant);
			if (signal.aborted || last?.stopReason === "aborted") throw new SubagentAbortedError();
			if (!last) throw new Error("Subagent produced no response");
			if (last.stopReason === "error") throw new Error(`Subagent failed: ${last.errorMessage ?? "unknown error"}`);
			isError = false;
			return { text: assistantText(last) || "(Subagent completed with no text output)", usage };
		} finally {
			unsubscribe();
			signal.removeEventListener("abort", onAbort);
			rec.running = false;
			rec.controller = undefined;
			rec.finishedAt = Date.now();
			usage ??= computeSubagentUsage(session.messages.slice(startIndex), Date.now() - t0);
			emit({ type: "subagent_end", agentId, parentToolCallId, subagentType, isError, usage });
			evictFinished();
		}
	}

	function deliverBackgroundResult(rec: AgentRecord, outcome: { ok: true; result: RunResult } | { ok: false; error: unknown }): void {
		if (rec.killed) return; // parent session is shutting down
		const status = outcome.ok ? "completed" : outcome.error instanceof SubagentAbortedError ? "killed" : "failed";
		const summary = `Agent "${rec.description}" ${status === "completed" ? "completed" : status === "killed" ? "was stopped" : "failed"}`;
		const body = outcome.ok
			? `<result>\n${outcome.result.text}\n</result>\n${usageBlock(outcome.result.usage)}`
			: `<error>${escapeXmlText(outcome.error instanceof Error ? outcome.error.message : String(outcome.error))}</error>`;
		const text = `<task-notification>\n<task-id>${rec.tag.agentId}</task-id>\n<task-type>agent</task-type>\n<status>${status}</status>\n<summary>${escapeXmlText(summary)}</summary>\n${body}\n</task-notification>`;
		try {
			sendReminder(pi, text, {
				wake: true,
				details: { agentId: rec.tag.agentId, subagentType: rec.definition.name, status, usage: outcome.ok ? outcome.result.usage : undefined },
			});
		} catch {
			// parent session already gone
		}
	}

	async function execute(
		toolCallId: string,
		params: TaskInput,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<TaskDetails> | undefined,
		ctx: ExtensionContext,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: TaskDetails }> {
		if (signal?.aborted) throw new SubagentAbortedError();
		if (typeof params.prompt !== "string" || !params.prompt.trim()) throw new Error("prompt must be a non-empty string");
		const background = params.run_in_background === true;

		let rec: AgentRecord;
		if (params.resume) {
			const existing = records.get(params.resume.trim());
			if (!existing) throw new Error(`No agent found with ID "${params.resume}". It may have expired or never existed.`);
			if (existing.running) throw new Error(`Agent ${existing.tag.agentId} is still running; wait for it to finish before resuming it.`);
			rec = existing;
			rec.tag.toolCallId = toolCallId;
			rec.background = background;
			if (params.description) rec.description = params.description;
		} else {
			const defs = loadDefs(ctx.cwd);
			const type = params.subagent_type?.trim() || DEFAULT_AGENT_TYPE;
			const def = defs.get(type);
			if (!def) throw new Error(`Agent type '${type}' not found. Available agents: ${[...defs.keys()].join(", ")}`);
			const resolved = params.model
				? resolveSubagentModel(params.model, ctx.modelRegistry, ctx.model, { strict: true })
				: resolveSubagentModel(def.model, ctx.modelRegistry, ctx.model, { strict: false });
			if (!resolved.ok) throw new Error(resolved.error);
			const tag: RunTag = { agentId: newAgentId(), toolCallId };
			const session = await createChildSession(ctx, def, resolved.model, tag);
			rec = {
				tag,
				definition: def,
				description: params.description,
				session,
				model: session.model ?? resolved.model,
				modelNote: resolved.note,
				running: false,
				background,
				finishedAt: Date.now(),
			};
			records.set(tag.agentId, rec);
			if (signal?.aborted) {
				await disposeRecord(rec);
				throw new SubagentAbortedError();
			}
		}

		const baseDetails: TaskDetails = {
			agentId: rec.tag.agentId,
			subagentType: rec.definition.name,
			description: rec.description,
			status: "completed",
			background,
			model: modelLabel(rec.model),
			modelNote: rec.modelNote,
		};

		const controller = new AbortController();
		rec.controller = controller;

		if (background) {
			// not tied to the parent's abort signal: the tool call returns immediately
			runAgent(rec, params.prompt, controller.signal, undefined).then(
				(result) => deliverBackgroundResult(rec, { ok: true, result }),
				(error) => deliverBackgroundResult(rec, { ok: false, error }),
			);
			return {
				content: [
					{
						type: "text",
						text: `Async agent launched successfully.\nagentId: ${rec.tag.agentId} (internal ID - do not mention to the user; pass it as \`resume\` to continue this agent later)\nThe agent is working in the background. You will be notified automatically when it completes. Do not duplicate this agent's work. Continue with other tasks or briefly tell the user what you launched.`,
					},
				],
				details: { ...baseDetails, status: "async_launched" },
			};
		}

		const forwardAbort = () => controller.abort();
		signal?.addEventListener("abort", forwardAbort, { once: true });
		try {
			const result = await runAgent(rec, params.prompt, controller.signal, onUpdate);
			return {
				content: [
					{
						type: "text",
						text: `${result.text}\n\nagentId: ${rec.tag.agentId} (pass as \`resume\` to continue this agent's work if needed)\n${usageBlock(result.usage)}`,
					},
				],
				details: { ...baseDetails, usage: result.usage },
			};
		} finally {
			signal?.removeEventListener("abort", forwardAbort);
		}
	}

	function registerTool(description: string): void {
		currentDescription = description;
		pi.registerTool({
			name: TASK_TOOL_NAME,
			label: "Task",
			description,
			parameters: TaskParams,
			execute: (toolCallId, params, signal, onUpdate, ctx) => execute(toolCallId, params as TaskInput, signal, onUpdate, ctx),
		});
	}

	/** Refresh the model-facing description (the agent list depends on cwd's .claude/agents). */
	function refreshDescription(cwd: string): void {
		try {
			let known: Set<string> | undefined;
			try {
				known = new Set(pi.getAllTools().map((t) => t.name));
			} catch {
				known = undefined;
			}
			const description = buildTaskDescription(loadDefs(cwd), known);
			if (description !== currentDescription) registerTool(description);
		} catch {
			// keep previous description
		}
	}

	// The extension factory has no cwd: start with process.cwd() and refresh once a ctx is available.
	registerTool(buildTaskDescription(loadDefs(process.cwd())));
	pi.on("session_start", (_event, ctx) => {
		refreshDescription(ctx.cwd);
	});
	pi.on("before_agent_start", (_event, ctx) => {
		refreshDescription(ctx.cwd);
	});

	pi.on("session_shutdown", async () => {
		const all = [...records.values()];
		await Promise.all(
			all.map(async (rec) => {
				if (rec.running) {
					rec.killed = true;
					rec.controller?.abort();
					await rec.session.abort().catch(() => {});
				}
				await disposeRecord(rec);
			}),
		);
	});
}

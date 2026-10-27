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
import { withDeferredExposure } from "../deferred-tools.js";
import { createClaudeCodeSession } from "../sdk.js";
import { type BackgroundTask, FileAppender, newTaskId } from "../shared/background.js";
import { type CCContext, createCCContext } from "../shared/context.js";
import { formatTaskNotification } from "../shared/notifications.js";
import { isFixed } from "../shared/quirks.js";
import { REMINDER_CUSTOM_TYPE, wrapReminder } from "../shared/reminders.js";
import type { ClaudeCodeHostEvent, ClaudeCodeToolsOptions, SubagentUsage } from "../shared/types.js";
import { type AgentEffort, agentAllowsTool, formatAgentListingReminder, loadAgentDefinitions, SUBAGENT_PROMPT_NOTES, type SubagentDefinition, sortedAgentNames } from "./agents.js";
import { resolveSubagentModel } from "./models.js";
import {
	AGENT_NOTIFICATION_NOTE,
	AGENT_TOOL_DESCRIPTION,
	type AgentEndStatus,
	agentNotificationSummary,
	asyncLaunchText,
	EFFORT_OPTIONS,
	FORK_STARTED,
	foregroundResultText,
	forkDirective,
	forkWorktreeNotice,
	ISOLATION_OPTIONS,
	MODEL_OPTIONS,
	noSuchToolText,
	PARAM_DESCRIPTIONS,
	validateAgentInput,
	type WorktreeInfo,
} from "./prompt.js";
import { type AgentWorktree, createAgentWorktree, finishAgentWorktree, gitRootOf, WORKTREE_UNSUPPORTED } from "./worktree.js";

export {
	BUILT_IN_AGENTS,
	formatAgentList,
	formatAgentListingReminder,
	loadAgentDefinitions,
	parseAgentMarkdown,
	type SubagentDefinition,
} from "./agents.js";
export { resolveSubagentModel } from "./models.js";
export { AGENT_TOOL_DESCRIPTION, foregroundResultText, frameHandback, validateAgentInput } from "./prompt.js";

export const AGENT_TOOL_NAME = "Agent";
/** @deprecated The tool is called `Agent` now (Claude Code renamed Task → Agent). */
export const TASK_TOOL_NAME = AGENT_TOOL_NAME;
const DEFAULT_AGENT_TYPE = "general-purpose";
const FORK_AGENT_TYPE = "fork";

/** Never available to subagents. */
const SUBAGENT_EXCLUDED_TOOLS = ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"];
/** Claude Code gives background agents no task-list tools. */
const BACKGROUND_EXCLUDED_TOOLS = ["TaskCreate", "TaskGet", "TaskList", "TaskUpdate", "TodoWrite"];

const FORK_DEFINITION: SubagentDefinition = {
	name: FORK_AGENT_TYPE,
	description: 'Fork — inherits full conversation context. Selected explicitly via subagent_type: "fork"; never the default.',
	prompt: "",
	tools: ["*"],
	source: "built-in",
};

/**
 * Internal hooks (mainly for tests). `childExtensionFactories` are appended to every child session's
 * extensions (e.g. to give subagents extra tools); `homeDir` overrides where `~/.claude/agents` is read.
 */
export const subagentInternals: { childExtensionFactories: ExtensionFactory[]; homeDir?: string } = {
	childExtensionFactories: [],
	homeDir: undefined,
};

const AgentParams = Type.Object({
	description: Type.String({ description: PARAM_DESCRIPTIONS.description }),
	prompt: Type.String({ description: PARAM_DESCRIPTIONS.prompt }),
	subagent_type: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.subagent_type })),
	model: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.model, enum: [...MODEL_OPTIONS] })),
	effort: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.effort, enum: [...EFFORT_OPTIONS] })),
	run_in_background: Type.Optional(Type.Boolean({ description: PARAM_DESCRIPTIONS.run_in_background })),
	isolation: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.isolation, enum: [...ISOLATION_OPTIONS] })),
});

export interface AgentInput {
	description: string;
	prompt: string;
	subagent_type?: string;
	model?: (typeof MODEL_OPTIONS)[number];
	effort?: AgentEffort;
	run_in_background?: boolean;
	isolation?: (typeof ISOLATION_OPTIONS)[number];
	/** Accepted and ignored (agent teams are not supported). */
	name?: string;
	team_name?: string;
	mode?: string;
}

export interface AgentDetails {
	agentId: string;
	subagentType: string;
	description: string;
	status: "completed" | "async_launched" | "running";
	background: boolean;
	/** "provider/id" of the child's model. */
	model?: string;
	/** Set when the requested/defined model could not be resolved and the parent model was used. */
	modelNote?: string;
	/** Transcript file of a background agent. */
	outputFile?: string;
	worktree?: WorktreeInfo;
	usage?: SubagentUsage;
	toolUses?: number;
	lastToolName?: string;
}
/** @deprecated Use AgentDetails. */
export type TaskDetails = AgentDetails;

function modelLabel(m: Model<any> | undefined): string | undefined {
	return m ? `${m.provider}/${m.id}` : undefined;
}

function isAssistant(m: unknown): m is AssistantMessage {
	return !!m && typeof m === "object" && (m as { role?: string }).role === "assistant";
}

function assistantText(m: AssistantMessage | undefined): string {
	if (!m) return "";
	return m.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text" && !!c.text)
		.map((c) => c.text)
		.join("\n");
}

function messageTokens(m: AssistantMessage): number {
	const u = m.usage;
	if (!u) return 0;
	return u.totalTokens ?? (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
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
		u.totalTokens += messageTokens(m);
		u.costTotal += usage.cost?.total ?? 0;
	}
	return u;
}

/** Claude Code reports a subagent's tokens as the context size of its last model call. */
function lastCallTokens(messages: readonly unknown[]): number {
	const last = [...messages].reverse().find((m) => isAssistant(m) && !!m.usage) as AssistantMessage | undefined;
	return last ? messageTokens(last) : 0;
}

/**
 * A sibling model of the parent's provider (e.g. the "opus" alias) is reached through the same
 * endpoint as the parent model, so a parent configured with a custom baseUrl/proxy keeps using it.
 */
function sameEndpoint(model: Model<any> | undefined, parent: Model<any> | undefined): Model<any> | undefined {
	if (!model || !parent || model === parent || model.provider !== parent.provider) return model;
	if (model.baseUrl === parent.baseUrl && model.headers === parent.headers) return model;
	return { ...model, baseUrl: parent.baseUrl, ...(parent.headers ? { headers: parent.headers } : {}) };
}

/**
 * Rewrites pi's "Tool X not found" result for a call to an unavailable tool into Claude Code's
 * wording. Installed in every subagent session and in the session that owns the Agent tool.
 */
export function registerUnknownToolErrors(pi: ExtensionAPI): void {
	pi.on("message_end", (event) => {
		const m = event.message as { role?: string; isError?: boolean; toolName?: string; content?: unknown };
		if (m?.role !== "toolResult" || !m.isError || !Array.isArray(m.content) || m.content.length !== 1) return undefined;
		const block = m.content[0] as { type?: string; text?: string };
		const match = block?.type === "text" ? /^Tool (.+) not found$/.exec(block.text ?? "") : null;
		if (!match || (m.toolName && match[1] !== m.toolName)) return undefined;
		return { message: { ...(event.message as object), content: [{ type: "text", text: noSuchToolText(match[1]) }] } as typeof event.message };
	});
}

class SubagentAbortedError extends Error {
	constructor() {
		super("Subagent was aborted");
	}
}

interface AgentRun {
	agentId: string;
	toolCallId: string;
	definition: SubagentDefinition;
	description: string;
	session: AgentSession;
	model?: Model<any>;
	modelNote?: string;
	background: boolean;
	controller: AbortController;
	running: boolean;
	/** Messages before this run's prompt (a fork's inherited history). */
	startIndex: number;
	worktree?: AgentWorktree;
	outputFile?: string;
	task?: BackgroundTask;
	/** Settles (never rejects) when the run has ended and been cleaned up. */
	done?: Promise<void>;
	/** Set by TaskStop ("parent") or when the parent session shuts down ("shutdown"). */
	killedBy?: "parent" | "shutdown";
}

interface RunResult {
	text: string;
	usage: SubagentUsage;
	totalTokens: number;
}

interface RegisterAgentInternalOptions {
	/** The session is a forked worker: forking again is refused. */
	inFork?: boolean;
}

/**
 * Wraps an extension factory so the tools it registers that `allowed` rejects are registered with
 * pi's `hidden` exposure: they are neither declared to the child, nor loadable by tool_search, nor
 * callable (a restricted agent must not reach them, as in Claude Code).
 */
function restrictToolRegistration(factory: ExtensionFactory, allowed: (name: string) => boolean): ExtensionFactory {
	return (childPi) => {
		const view = new Proxy(childPi, {
			get(target, prop, receiver) {
				if (prop === "registerTool") {
					return (def: Parameters<ExtensionAPI["registerTool"]>[0]) => target.registerTool(allowed(def.name) ? def : { ...def, exposure: "hidden" });
				}
				const value = Reflect.get(target, prop, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		return factory(view);
	};
}

/** Register Claude Code's Agent tool (subagents). */
export function registerAgent(pi: ExtensionAPI, cc: CCContext, internal: RegisterAgentInternalOptions = {}): void {
	const runs = new Map<string, AgentRun>();
	let shuttingDown = false;
	let lastListing: string | undefined;
	const isSubagent = cc.options.isSubagent === true;

	const host = cc.host;
	const loadDefs = (cwd: string) =>
		loadAgentDefinitions({
			fs: host.fs,
			homeDir: subagentInternals.homeDir ?? host.homeDir,
			cwd,
			agents: cc.options.agents,
			loadAgentsFromDisk: cc.options.loadAgentsFromDisk,
		});
	const finishWorktree = (w: AgentWorktree) => finishAgentWorktree(host, w);

	const emit = (event: ClaudeCodeHostEvent) => cc.emit(event);

	function resolveAgentType(defs: Map<string, SubagentDefinition>, requested: string | undefined): SubagentDefinition {
		const names = sortedAgentNames(defs);
		if (!requested) {
			const def = defs.get(DEFAULT_AGENT_TYPE);
			if (!def) {
				const avail = internal.inFork ? names : [FORK_AGENT_TYPE, ...names];
				throw new Error(`subagent_type is required: the general-purpose agent is not available in this session. Available agents: ${avail.join(", ") || "none"}`);
			}
			return def;
		}
		const exact = defs.get(requested);
		if (exact) return exact;
		// Claude Code matches names ignoring case, whitespace, dashes and underscores
		const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\p{White_Space}\p{Pd}_]+/gu, "");
		const matches = names.filter((n) => norm(n) === norm(requested));
		if (matches.length === 1) return defs.get(matches[0])!;
		if (matches.length > 1) throw new Error(`Agent type '${requested}' is ambiguous: ${matches.join(", ")}. Use the exact name: ${matches.join(" or ")}`);
		throw new Error(`Agent type '${requested}' not found. Available agents: ${names.join(", ") || "none"}`);
	}

	async function disposeSession(session: AgentSession): Promise<void> {
		try {
			const runner = session.extensionRunner;
			if (runner?.hasHandlers("session_shutdown")) await runner.emit({ type: "session_shutdown", reason: "quit" });
		} catch {
			// ignore child extension errors during teardown
		}
		try {
			session.dispose();
		} catch {
			// ignore
		}
	}

	/** Seed a fork's session with the parent's conversation plus synthetic results for the pending tool calls. */
	function forkSessionManager(ctx: ExtensionContext, cwd: string): SessionManager {
		const sm = SessionManager.inMemory(cwd);
		let messages: any[] = [];
		try {
			messages = [...((ctx.sessionManager as any).buildSessionProjection?.().messages ?? [])];
		} catch {
			messages = [];
		}
		messages = messages.filter((m) => m && m.role !== "system");
		for (const m of messages) {
			try {
				sm.appendMessage(m);
			} catch {
				// not a message pi can replay; skip it
			}
		}
		const last = messages.at(-1);
		if (isAssistant(last)) {
			for (const c of last.content) {
				if (c.type !== "toolCall") continue;
				sm.appendMessage({ role: "toolResult", toolCallId: c.id, toolName: c.name, content: [{ type: "text", text: FORK_STARTED }], isError: false, timestamp: Date.now() } as any);
			}
		}
		return sm;
	}

	async function createChildSession(
		ctx: ExtensionContext,
		def: SubagentDefinition,
		model: Model<any> | undefined,
		opts: { agentId: string; toolCallId: string; background: boolean; cwd: string; effort?: AgentEffort; fork: boolean },
	): Promise<AgentSession> {
		let parentActive: Set<string> | undefined;
		if (opts.fork) {
			try {
				parentActive = new Set(pi.getActiveTools());
			} catch {
				parentActive = undefined;
			}
		}
		const disallowAll = isFixed(cc, "agentDisallowAll");
		const allowed = (name: string): boolean => {
			if (parentActive) return parentActive.has(name);
			if (SUBAGENT_EXCLUDED_TOOLS.includes(name)) return false;
			if (opts.background && BACKGROUND_EXCLUDED_TOOLS.includes(name)) return false;
			return agentAllowsTool(def, name, { disallowAll });
		};
		const deferredTools = opts.fork ? cc.options.deferredTools : (cc.options.deferredTools ?? []).filter(allowed);

		let thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]> | undefined = opts.effort;
		if (!thinkingLevel) {
			try {
				thinkingLevel = pi.getThinkingLevel();
			} catch {
				thinkingLevel = undefined;
			}
		}

		const childOptions: ClaudeCodeToolsOptions = {
			...cc.options,
			// subagents work on the parent's filesystem, shell and search
			host,
			isSubagent: true,
			onAskUserQuestion: undefined,
			sharedTaskStore: cc.taskStore,
			deferredTools,
			// child host events (todos, background shells, ...) are forwarded wrapped in subagent_event,
			// so they never clobber the parent's state in the host UI
			onEvent: (event) => emit({ type: "subagent_event", agentId: opts.agentId, parentToolCallId: opts.toolCallId, event }),
		};
		const hostFactories = [...(cc.options.subagentExtensions ?? []), ...subagentInternals.childExtensionFactories];
		const factories: ExtensionFactory[] = [
			// a fork inherits the parent's tools (and may load its deferred tools); other agents only get
			// what their definition allows, also for deferred and host/MCP tools
			...(opts.fork ? hostFactories : hostFactories.map((f) => restrictToolRegistration(f, allowed))),
			(childPi) => registerUnknownToolErrors(childPi),
		];
		if (!opts.fork) {
			// last line of defense: whatever got registered or activated, a disallowed tool never runs
			factories.push((childPi) => {
				childPi.on("tool_call", (event) => (event.toolName === "tool_search" || allowed(event.toolName) ? undefined : { block: true, reason: noSuchToolText(event.toolName) }));
			});
		}
		if (allowed(AGENT_TOOL_NAME)) {
			// subagents can launch their own agents (foreground by default)
			factories.push((childPi) => {
				const childCC = createCCContext(childOptions, childPi);
				registerAgent(withDeferredExposure(childPi, new Set(deferredTools ?? [])), childCC, { inFork: internal.inFork || opts.fork });
				(childCC.notifications as { attachToToolResults?: () => void }).attachToToolResults?.();
			});
		}

		let parentPrompt = "";
		if (opts.fork) {
			try {
				parentPrompt = ctx.getSystemPrompt();
			} catch {
				parentPrompt = "";
			}
		}
		const systemPrompt = opts.fork ? parentPrompt : def.prompt ? `${def.prompt}\n\n${SUBAGENT_PROMPT_NOTES}` : SUBAGENT_PROMPT_NOTES;

		const registry = ctx.modelRegistry;
		if (shuttingDown) throw new SubagentAbortedError();
		const { session } = await createClaudeCodeSession({
			cwd: opts.cwd,
			sessionManager: opts.fork ? forkSessionManager(ctx, opts.cwd) : SessionManager.inMemory(opts.cwd),
			settingsManager: SettingsManager.inMemory(),
			// share the parent's credentials and model catalog
			modelRuntime: cc.options.modelRuntime ?? (registry as unknown as { runtime?: ModelRuntime } | undefined)?.runtime,
			model,
			thinkingLevel,
			claudeCode: childOptions,
			// a non-local host supplies its own loader: DefaultResourceLoader reads the real disk
			resourceLoaderFactory: cc.options.subagentResourceLoader,
			loader: {
				// no disk-discovered pi extensions/templates/themes/skills in children; context files (AGENTS.md/CLAUDE.md) are kept
				noExtensions: true,
				noPromptTemplates: true,
				noThemes: true,
				noSkills: true,
				...(opts.fork ? { noContextFiles: true } : {}),
				systemPromptOverride: () => systemPrompt,
				appendSystemPromptOverride: () => [],
				extensionFactories: factories,
			},
		});
		// the parent may have shut down while the child was being created: never start its extensions
		if (shuttingDown) {
			session.dispose();
			throw new SubagentAbortedError();
		}
		try {
			await session.bindExtensions({});
		} catch (err) {
			session.dispose();
			throw err;
		}
		if (shuttingDown) {
			await disposeSession(session);
			throw new SubagentAbortedError();
		}
		// Deferred tools stay registered-but-inactive until tool_search loads them, as in the parent.
		session.setActiveToolsByName(session.getActiveToolNames().filter((n) => n === "tool_search" || allowed(n)));
		return session;
	}

	/**
	 * Write the run's transcript to its output file; the returned stop function flushes it. Starts
	 * synchronously (the file is created ahead of the queued appends), so the child's prompt is not
	 * held up by it.
	 */
	function startTranscript(run: AgentRun): () => Promise<void> {
		const file = run.outputFile;
		if (!file) return async () => {};
		const created = host.fs.writeFile(file, "", { mode: 0o600 }).then(
			() => true,
			() => false,
		);
		// queued in order; a failed create or append ends the transcript (it is best-effort)
		const out = new FileAppender(host.fs, file, created);
		const unsubscribe = run.session.subscribe((event) => {
			if (event.type !== "message_end" || (event.message as { role?: string }).role === "system") return;
			out.write(`${JSON.stringify({ type: (event.message as { role?: string }).role, agentId: run.agentId, timestamp: new Date().toISOString(), message: event.message })}\n`);
		});
		return async () => {
			unsubscribe();
			await out.close();
		};
	}

	async function runAgent(run: AgentRun, prompt: string, onUpdate: AgentToolUpdateCallback<AgentDetails> | undefined): Promise<RunResult> {
		const { session, agentId, toolCallId: parentToolCallId } = run;
		const signal = run.controller.signal;
		const subagentType = run.definition.name;
		run.running = true;
		emit({ type: "subagent_start", agentId, parentToolCallId, subagentType, description: run.description, background: run.background });

		const t0 = Date.now();
		const startIndex = run.startIndex;
		let toolUses = 0;
		const stopTranscript = startTranscript(run);
		const unsubscribe = session.subscribe((event) => {
			emit({ type: "subagent_event", agentId, parentToolCallId, event });
			if (event.type === "tool_execution_start" && onUpdate) {
				toolUses++;
				try {
					onUpdate({
						content: [{ type: "text", text: `[${subagentType}] ${event.toolName} (${toolUses} tool use${toolUses === 1 ? "" : "s"})` }],
						details: { agentId, subagentType, description: run.description, status: "running", background: run.background, toolUses, lastToolName: event.toolName },
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
			return { text: assistantText(last), usage, totalTokens: lastCallTokens(newMessages) };
		} finally {
			unsubscribe();
			await stopTranscript();
			signal.removeEventListener("abort", onAbort);
			run.running = false;
			usage ??= computeSubagentUsage(session.messages.slice(startIndex), Date.now() - t0);
			emit({ type: "subagent_end", agentId, parentToolCallId, subagentType, isError, usage });
		}
	}

	/** Last assistant text of a run that did not complete (for failed/killed notifications). */
	function partialText(run: AgentRun): string {
		const last = [...run.session.messages.slice(run.startIndex)].reverse().find(isAssistant);
		return assistantText(last);
	}

	async function finishBackground(run: AgentRun, outcome: { ok: true; result: RunResult } | { ok: false; error: unknown }): Promise<void> {
		const status: AgentEndStatus = outcome.ok ? "completed" : run.killedBy ? "killed" : "failed";
		if (run.task && run.task.status === "running") run.task.status = status;
		const result = outcome.ok ? outcome.result.text : partialText(run);
		runs.delete(run.agentId);
		const worktree = run.worktree ? await finishWorktree(run.worktree) : undefined;
		const silent = run.killedBy === "shutdown" || shuttingDown;
		if (!silent) {
			const error = outcome.ok ? undefined : outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
			let text = formatTaskNotification({
				taskId: run.agentId,
				toolUseId: run.toolCallId,
				outputFile: run.outputFile,
				status,
				summary: agentNotificationSummary(run.description, status, error),
				note: AGENT_NOTIFICATION_NOTE,
				result: result.trim() ? result : undefined,
				usage: outcome.ok ? { subagentTokens: outcome.result.totalTokens, toolUses: outcome.result.usage.toolUses, durationMs: outcome.result.usage.durationMs } : undefined,
			});
			if (worktree) {
				const branch = worktree.worktreeBranch ? `<worktreeBranch>${worktree.worktreeBranch}</worktreeBranch>` : "";
				text = text.replace("\n</task-notification>", `\n<worktree><worktreePath>${worktree.worktreePath}</worktreePath>${branch}</worktree>\n</task-notification>`);
			}
			if (status === "killed") {
				// stopped by TaskStop: delivered after that tool call settles, never inside its result
				setTimeout(() => {
					if (!shuttingDown) cc.notifications.enqueue(text);
				}, 0);
			} else {
				cc.notifications.enqueue(text);
			}
		}
		await disposeSession(run.session);
	}

	async function stopRun(run: AgentRun): Promise<void> {
		if (!run.running) return;
		run.killedBy ??= "parent";
		run.controller.abort();
		await Promise.race([run.done, new Promise((r) => setTimeout(r, 10_000).unref?.())]);
	}

	async function execute(
		toolCallId: string,
		params: AgentInput,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<AgentDetails> | undefined,
		ctx: ExtensionContext,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: AgentDetails }> {
		if (signal?.aborted || shuttingDown) throw new SubagentAbortedError();
		const invalid = validateAgentInput(params);
		if (invalid) throw new Error(invalid);

		const requested = params.subagent_type?.trim() || undefined;
		const fork = requested === FORK_AGENT_TYPE && !(await loadDefs(ctx.cwd)).has(FORK_AGENT_TYPE);
		if (fork && internal.inFork) throw new Error("Fork is not available inside a forked worker. Complete your task directly using your tools.");
		if (fork && params.isolation === "remote") {
			throw new Error('Fork cannot use isolation: "remote" — a remote session cannot inherit the conversation context. Omit isolation (or use "worktree"), or spawn a named agent type for remote work.');
		}
		const def = fork ? FORK_DEFINITION : resolveAgentType(await loadDefs(ctx.cwd), requested);

		const resolved = fork
			? ({ ok: true, model: ctx.model } as const)
			: params.model
				? resolveSubagentModel(params.model, ctx.modelRegistry, ctx.model, { strict: true })
				: resolveSubagentModel(def.model, ctx.modelRegistry, ctx.model, { strict: false });
		if (!resolved.ok) throw new Error(resolved.error);
		const childModel = sameEndpoint(resolved.model, ctx.model);
		const modelNote = "note" in resolved ? resolved.note : undefined;

		// Claude Code: agents run in the background unless run_in_background is false; agents launched
		// by a subagent run in the foreground unless run_in_background is true.
		const background = params.run_in_background === true || def.background === true || (!isSubagent && params.run_in_background !== false);

		// "remote" is not available here. Claude Code silently falls back to a worktree in a git checkout,
		// else runs locally (#3); with the remoteIsolationFallback quirk fixed it is an error instead.
		if (params.isolation === "remote" && isFixed(cc, "remoteIsolationFallback")) {
			throw new Error('isolation: "remote" is not available: remote agent sessions are not supported here, and the agent would silently run on this machine instead. Omit isolation to run it in the current directory, or use isolation: "worktree" for an isolated git worktree.');
		}
		// A host without git worktrees (an in-memory host) cannot isolate an agent: say so instead of
		// running it unisolated. "remote" falls back to running locally there, as outside a checkout.
		if (params.isolation === "worktree" && !host.supportsWorktrees) throw new Error(WORKTREE_UNSUPPORTED);
		const isolation =
			params.isolation === "remote" ? (host.supportsWorktrees && (await gitRootOf(host, ctx.cwd)) ? "worktree" : undefined) : params.isolation;
		const agentId = newTaskId("local_agent");
		const worktree = isolation === "worktree" ? await createAgentWorktree(host, ctx.cwd, agentId) : undefined;

		let session: AgentSession;
		try {
			session = await createChildSession(ctx, def, childModel, {
				agentId,
				toolCallId,
				background,
				cwd: worktree?.cwd ?? ctx.cwd,
				effort: fork ? undefined : (params.effort ?? def.effort),
				fork,
			});
		} catch (err) {
			if (worktree) await finishWorktree(worktree);
			throw err;
		}
		const run: AgentRun = {
			agentId,
			toolCallId,
			definition: def,
			description: params.description,
			session,
			model: session.model ?? childModel,
			modelNote,
			background,
			controller: new AbortController(),
			running: false,
			startIndex: session.messages.length,
			worktree,
		};
		if (background) {
			// before the abort/shutdown check below, so nothing can stop the session in between
			try {
				run.outputFile = await cc.tasks.outputPath(agentId);
			} catch (err) {
				if (worktree) await finishWorktree(worktree);
				await disposeSession(session);
				throw err;
			}
		}
		if (signal?.aborted || shuttingDown) {
			if (worktree) await finishWorktree(worktree);
			await disposeSession(session);
			throw new SubagentAbortedError();
		}
		const prompt = fork ? `${forkDirective(params.prompt)}${worktree ? `\n\n${forkWorktreeNotice(ctx.cwd, worktree.path)}` : ""}` : params.prompt;
		const baseDetails: AgentDetails = {
			agentId,
			subagentType: def.name,
			description: params.description,
			status: "completed",
			background,
			model: modelLabel(run.model),
			modelNote,
		};
		runs.set(agentId, run);

		if (background) {
			run.task = cc.tasks.add({
				id: agentId,
				type: "local_agent",
				label: params.description,
				status: "running",
				outputFile: run.outputFile,
				toolUseId: toolCallId,
				stop: () => stopRun(run),
			});
			// not tied to the parent's abort signal: the tool call returns immediately
			run.done = runAgent(run, prompt, undefined).then(
				(result) => finishBackground(run, { ok: true, result }),
				(error) => finishBackground(run, { ok: false, error }),
			);
			return {
				content: [{ type: "text", text: asyncLaunchText(agentId, run.outputFile!) }],
				details: { ...baseDetails, status: "async_launched", outputFile: run.outputFile },
			};
		}

		const forwardAbort = () => run.controller.abort();
		signal?.addEventListener("abort", forwardAbort, { once: true });
		let worktreeInfo: WorktreeInfo | undefined;
		try {
			const result = await runAgent(run, prompt, onUpdate);
			worktreeInfo = worktree ? await finishWorktree(worktree) : undefined;
			return {
				content: [
					{
						type: "text",
						text: foregroundResultText({
							report: result.text,
							agentId,
							agentType: def.name,
							usage: { totalTokens: result.totalTokens, toolUses: result.usage.toolUses, durationMs: result.usage.durationMs },
							worktree: worktreeInfo,
						}),
					},
				],
				details: { ...baseDetails, usage: result.usage, worktree: worktreeInfo },
			};
		} catch (err) {
			if (worktree) await finishWorktree(worktree);
			throw err;
		} finally {
			signal?.removeEventListener("abort", forwardAbort);
			runs.delete(agentId);
			await disposeSession(session);
		}
	}

	pi.registerTool({
		name: AGENT_TOOL_NAME,
		label: "Agent",
		description: AGENT_TOOL_DESCRIPTION,
		promptSnippet: "Launch a subagent (general-purpose, Explore, Plan, fork, or a custom agent) for complex multi-step work",
		parameters: AgentParams,
		// Claude Code's InputValidationError wording (pi's own validation would word it differently)
		prepareArguments: (args) => {
			const invalid = validateAgentInput(args);
			if (invalid) throw new Error(invalid);
			return args as AgentInput;
		},
		execute: (toolCallId, params, signal, onUpdate, ctx) => execute(toolCallId, params as AgentInput, signal, onUpdate, ctx),
	});

	if (!isSubagent) registerUnknownToolErrors(pi);

	// Claude Code lists the agent types in a system reminder (re-sent when the list changes).
	pi.on("before_agent_start", async (_event, ctx) => {
		let listing: string;
		try {
			listing = formatAgentListingReminder(await loadDefs(ctx.cwd), { disallowAll: isFixed(cc, "agentDisallowAll") });
		} catch {
			return undefined;
		}
		if (listing === lastListing) return undefined;
		lastListing = listing;
		return { message: { customType: REMINDER_CUSTOM_TYPE, content: wrapReminder(listing), display: false } };
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		await Promise.all(
			[...runs.values()].map(async (run) => {
				if (run.running) {
					run.killedBy ??= "shutdown";
					run.controller.abort();
					await run.session.abort().catch(() => {});
				}
				if (run.done) await Promise.race([run.done, new Promise((r) => setTimeout(r, 5_000).unref?.())]);
			}),
		);
	});
}

/** @deprecated Use registerAgent (kept for src/index.ts). */
export const registerTask = registerAgent;

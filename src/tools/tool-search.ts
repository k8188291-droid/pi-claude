import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import type { CCContext } from "../shared/context.js";

/**
 * ToolSearch: Claude Code-style deferred tool loading.
 *
 * Tools named in `options.deferredTools` start "deferred": the model only sees their names (in a
 * system-prompt section) and must call ToolSearch to load their schemas before calling them.
 *
 * ## Why we wrap the agent's streamFn instead of only using pi.setActiveTools()
 * pi snapshots `agent.state.tools` once per agent run (`Agent.createContextSnapshot()`), so a
 * `setActiveTools()` call made while a run is in progress only takes effect on the NEXT prompt.
 * Claude Code makes a tool callable on the very next model call after ToolSearch. To get the same
 * behavior we use two layers:
 *
 * 1. "hook" mode (default): deferred tools stay ACTIVE in pi (so they are part of every run's
 *    snapshot and are executable), and the session's `agent.streamFn` is wrapped with
 *    `wrapStreamFnForToolSearch()` (done by `createClaudeCodeSession`; hosts building their own
 *    session can install it themselves). The wrapper drops not-yet-loaded deferred tools from the
 *    tool list the model sees on every LLM call. It identifies the extension instance by finding
 *    that instance's ToolSearch tool (its parameter schema object) in `context.tools`. Calls to
 *    deferred tools that were not loaded are blocked in `tool_call`, mirroring Claude Code's
 *    InputValidationError.
 * 2. "inactive" mode (fallback): if we see a model response that did not pass through the wrapper
 *    (wrapper not installed, or ToolSearch deactivated by the host), we switch to deactivating
 *    deferred tools via `pi.setActiveTools()`. Loading then takes effect from the next prompt only.
 */

const TOOL_NAME = "ToolSearch";
const ENTRY_TYPE = "cc-tool-search";
const DEFAULT_MAX_RESULTS = 5;

const DESCRIPTION = `Fetches full schema definitions for deferred tools so they can be called.

Deferred tools appear by name in <system-reminder> messages. Until fetched, only the name is known — there is no parameter schema, so the tool cannot be invoked. This tool takes a query, matches it against the deferred tool list, and returns the matched tools' complete JSONSchema definitions inside a <functions> block. Once a tool's schema appears in that result, it is callable exactly like any tool defined at the top of the prompt.

Result format: each matched tool appears as one <function>{"description": "...", "name": "...", "parameters": {...}}</function> line inside the <functions> block — the same encoding as the tool list at the top of this prompt.

Query forms:
- "select:Read,Edit,Grep" — fetch these exact tools by name
- "notebook jupyter" — keyword search, up to max_results best matches
- "+slack send" — require "slack" in the name, rank by remaining terms`;

/** System-prompt section listing deferred tools whose schemas are not loaded yet. */
export function deferredToolsSection(names: string[]): string {
	return (
		`The following deferred tools are now available via ToolSearch. Their schemas are NOT loaded — calling them directly will fail with InputValidationError. Use ToolSearch with query "select:<name>[,<name>...]" to load tool schemas before calling them:\n` +
		names.join("\n")
	);
}

// ---------------------------------------------------------------------------------------------
// streamFn wrapper
// ---------------------------------------------------------------------------------------------

interface HookState {
	hidden(): Set<string>;
	onProviderCall(): void;
}

/** Keyed by the ToolSearch parameter schema object of each extension instance. */
const hookStates = new WeakMap<object, HookState>();
const WRAPPED = Symbol("pi-cc-tool-search-wrapped");

function filterContext(context: any): any {
	const tools = context?.tools;
	if (!Array.isArray(tools)) return context;
	for (const tool of tools) {
		const params = tool?.parameters;
		if (!params || typeof params !== "object") continue;
		const state = hookStates.get(params);
		if (!state) continue;
		state.onProviderCall();
		const hidden = state.hidden();
		if (hidden.size === 0) return context;
		return { ...context, tools: tools.filter((t: any) => !hidden.has(t?.name)) };
	}
	return context;
}

/**
 * Wrap an agent `streamFn` so deferred tools whose schemas were not loaded via ToolSearch are
 * removed from the tool list sent to the model. Install on the session's agent:
 * `session.agent.streamFn = wrapStreamFnForToolSearch(session.agent.streamFn)`.
 * Idempotent; contexts without a ToolSearch tool from this module pass through unchanged.
 */
export function wrapStreamFnForToolSearch<T extends StreamFn>(streamFn: T): T {
	if ((streamFn as any)[WRAPPED]) return streamFn;
	const wrapped = ((model: any, context: any, options: any) => streamFn(model, filterContext(context), options)) as T;
	(wrapped as any)[WRAPPED] = true;
	return wrapped;
}

// ---------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------

function nameTokens(name: string): string[] {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scoreTerm(tool: ToolInfo, term: string): number {
	const lname = tool.name.toLowerCase();
	let score = 0;
	if (lname === term) score += 20;
	else if (nameTokens(tool.name).includes(term)) score += 10;
	else if (lname.includes(term)) score += 5;
	const desc = (tool.description ?? "").toLowerCase();
	if (desc) {
		if (new RegExp(`\\b${escapeRegExp(term)}\\b`).test(desc)) score += 2;
		else if (desc.includes(term)) score += 1;
	}
	return score;
}

/** Find deferred tools matching a ToolSearch query. Exported for unit tests. */
export function searchTools(tools: ToolInfo[], query: string, maxResults: number): ToolInfo[] {
	const q = query.trim();
	const selectMatch = /^select:(.*)$/is.exec(q);
	if (selectMatch) {
		const out: ToolInfo[] = [];
		for (const raw of selectMatch[1]!.split(",")) {
			const wanted = raw.trim();
			if (!wanted) continue;
			const tool = tools.find((t) => t.name === wanted) ?? tools.find((t) => t.name.toLowerCase() === wanted.toLowerCase());
			if (tool && !out.includes(tool)) out.push(tool);
		}
		return out;
	}

	const limit = Math.max(1, Math.floor(Number.isFinite(maxResults) ? maxResults : DEFAULT_MAX_RESULTS));
	const terms = q.split(/\s+/).filter(Boolean);
	const required = terms.filter((t) => t.startsWith("+")).map((t) => t.slice(1).toLowerCase()).filter(Boolean);
	const optional = terms.filter((t) => !t.startsWith("+")).map((t) => t.toLowerCase());
	if (required.length === 0 && optional.length === 0) return [];

	// exact tool name typed as the whole query
	const exact = tools.find((t) => t.name.toLowerCase() === q.toLowerCase());
	if (exact) return [exact];

	const candidates = tools.filter((t) => required.every((r) => t.name.toLowerCase().includes(r)));
	const rankTerms = optional.length > 0 ? optional : required;
	const scored = candidates
		.map((tool) => ({ tool, score: rankTerms.reduce((s, term) => s + scoreTerm(tool, term), 0) }))
		.filter((x) => optional.length === 0 || x.score > 0)
		.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
	return scored.slice(0, limit).map((x) => x.tool);
}

function formatFunctions(tools: ToolInfo[]): string {
	const lines = tools.map(
		(t) => `<function>${JSON.stringify({ description: t.description ?? "", name: t.name, parameters: t.parameters ?? {} })}</function>`,
	);
	return `<functions>\n${lines.join("\n")}\n</functions>`;
}

// ---------------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------------

export function registerToolSearch(pi: ExtensionAPI, cc: CCContext): void {
	const deferred = new Set((cc.options.deferredTools ?? []).filter((n) => n && n !== TOOL_NAME));
	if (deferred.size === 0) return;

	const loaded = new Set<string>();
	let mode: "hook" | "inactive" = "hook";
	let initialized = false;
	let providerCalls = 0;
	let assistantResponses = 0;

	const parameters = Type.Object({
		query: Type.String({
			description: 'Query to find deferred tools. Use "select:<tool_name>" for direct selection, or keywords to search.',
		}),
		max_results: Type.Number({
			description: "Maximum number of results to return (default: 5)",
			default: DEFAULT_MAX_RESULTS,
		}),
	});

	const pendingNames = (): Set<string> => {
		const out = new Set<string>();
		for (const n of deferred) if (!loaded.has(n)) out.add(n);
		return out;
	};
	const registeredDeferred = (): ToolInfo[] => pi.getAllTools().filter((t) => deferred.has(t.name));

	hookStates.set(parameters, {
		hidden: () => (mode === "hook" ? pendingNames() : new Set()),
		onProviderCall: () => {
			providerCalls++;
		},
	});

	const restore = (ctx: ExtensionContext) => {
		loaded.clear();
		try {
			const branch = ctx.sessionManager?.getBranch?.() ?? [];
			for (const entry of branch as any[]) {
				if (entry?.type === "custom" && entry.customType === ENTRY_TYPE && Array.isArray(entry.data?.loaded)) {
					for (const n of entry.data.loaded) if (typeof n === "string" && deferred.has(n)) loaded.add(n);
				}
			}
		} catch {
			// no session manager (unit tests): start empty
		}
		initialized = true;
	};

	/** Make pi's active set consistent with the current mode. */
	const syncActiveTools = () => {
		if (mode !== "inactive") return;
		const active = pi.getActiveTools();
		const pending = pendingNames();
		const next = active.filter((n) => !pending.has(n));
		for (const t of registeredDeferred()) if (loaded.has(t.name) && !next.includes(t.name)) next.push(t.name);
		if (next.length !== active.length || next.some((n, i) => n !== active[i])) pi.setActiveTools(next);
	};

	const persist = () => {
		try {
			pi.appendEntry(ENTRY_TYPE, { loaded: [...loaded] });
		} catch {
			// persistence is best effort
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		restore(ctx);
		syncActiveTools();
	});

	pi.on("session_tree", async (_event, ctx) => {
		// branch navigation: loaded state follows the branch
		restore(ctx);
		syncActiveTools();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!initialized) restore(ctx);
		syncActiveTools();
		const registered = new Set(registeredDeferred().map((t) => t.name));
		const names = [...pendingNames()].filter((n) => registered.has(n));
		if (names.length === 0) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${deferredToolsSection(names)}` };
	});

	pi.on("message_end", async (event) => {
		const msg: any = event.message;
		if (msg?.role !== "assistant" || msg.stopReason === "error" || msg.stopReason === "aborted") return;
		assistantResponses++;
		// Every successful LLM call must have passed through the streamFn wrapper (it runs before the
		// message is produced). If not, hiding does not work for this session: fall back.
		if (mode === "hook" && providerCalls < assistantResponses) {
			mode = "inactive";
			syncActiveTools();
		}
	});

	pi.on("tool_call", async (event) => {
		if (mode === "hook" && deferred.has(event.toolName) && !loaded.has(event.toolName)) {
			return {
				block: true,
				reason: `InputValidationError: ${event.toolName} is a deferred tool and its schema has not been loaded. Call ${TOOL_NAME} with query "select:${event.toolName}" to load it before calling it.`,
			};
		}
		return undefined;
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: TOOL_NAME,
		description: DESCRIPTION,
		parameters,
		prepareArguments(args: unknown) {
			// max_results is required in the schema (as in Claude Code) but has a default
			if (args && typeof args === "object" && !Array.isArray(args) && (args as any).max_results === undefined) {
				return { ...(args as object), max_results: DEFAULT_MAX_RESULTS } as any;
			}
			return args as any;
		},
		async execute(_toolCallId, params, signal) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const query = String(params.query ?? "");
			const pool = registeredDeferred();
			const matches = searchTools(pool, query, params.max_results ?? DEFAULT_MAX_RESULTS);

			if (matches.length === 0) {
				const available = pool.map((t) => t.name);
				const text =
					`No matching deferred tools found for query "${query}".` +
					(available.length > 0 ? `\n\nAvailable deferred tools:\n${available.join("\n")}` : "\n\nNo deferred tools are available.");
				return { content: [{ type: "text", text }], details: { query, matches: [] as string[], activated: [] as string[] } };
			}

			const newly = matches.map((t) => t.name).filter((n) => !loaded.has(n));
			for (const n of newly) loaded.add(n);

			// Make sure matched tools are active in pi (already true in hook mode unless the host
			// deactivated them; in inactive mode this takes effect from the next prompt).
			const active = pi.getActiveTools();
			const missing = matches.map((t) => t.name).filter((n) => !active.includes(n));
			if (missing.length > 0) pi.setActiveTools([...active, ...missing]);

			if (newly.length > 0) {
				persist();
				cc.emit({ type: "tools_activated", names: newly });
			}

			let text = formatFunctions(matches);
			if (mode === "inactive" && newly.length > 0) {
				text += `\n\nNote: ${newly.join(", ")} can be called starting with the next user message.`;
			}
			return {
				content: [{ type: "text", text }],
				details: { query, matches: matches.map((t) => t.name), activated: newly },
			};
		},
	});
}

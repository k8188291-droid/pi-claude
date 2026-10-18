import type { CapturedRequest, ScriptedCall, Turn } from "./mock-server.js";

/** Context for computed inputs: texts of the previous turn's tool results (in call order). */
export interface InputContext {
	results: string[];
	/** Every tool result so far in this conversation, oldest first. */
	all: string[];
	cwd: string;
}
export type CallInput = Record<string, unknown> | ((ctx: InputContext) => Record<string, unknown>);

export type Harness = "claude" | "pi";

/** A scripted tool call. `claude` / `pi` override the call for one harness when names or params differ. */
export interface ScenarioCall {
	tool: string;
	input: CallInput;
	claude?: { tool: string; input: CallInput } | "skip";
	pi?: { tool: string; input: CallInput } | "skip";
	/** Short label shown in the report. */
	label?: string;
}
export interface ScenarioTurn {
	text?: string;
	calls?: ScenarioCall[];
}

export interface Scenario {
	name: string;
	description: string;
	/** Files created in the fresh workspace before the run (path → content; Buffer for binary). */
	files?: Record<string, string | Buffer>;
	/** Runs after files are written (e.g. set mtimes). */
	setup?: (cwd: string) => void | Promise<void>;
	prompt: string;
	turns: ScenarioTurn[];
	/** Subagent scripts: a Task/Agent prompt containing `[[sub:NAME]]` is answered from subagents[NAME]. */
	subagents?: Record<string, ScenarioTurn[]>;
	/** Routes subagent requests without a `[[sub:NAME]]` marker (recordings): first user message contains `match`. */
	subagentRoutes?: Array<{ name: string; match: string }>;
	/** Claude Code maxTurns for this scenario (default 60). */
	maxTurns?: number;
	/** Files whose final content is compared after the run (default: every file in the workspace). */
	compareFiles?: string[];
}

export interface StepResult {
	turn: number;
	index: number;
	label: string;
	tool: string;
	toolUseId: string;
	text: string;
	isError: boolean;
	/** "missing" when the harness never sent a result for this call. */
	status: "ok" | "error" | "missing" | "skipped";
}

export interface RunOutcome {
	harness: Harness;
	steps: StepResult[];
	/** Tools declared to the model on the first main request. */
	tools: Array<{ name: string; description?: string; input_schema?: unknown }>;
	subagentTools: Record<string, string[]>;
	/** Main-agent requests beyond the scripted turns (extra wake-ups etc.). */
	extraTurns: string[];
	files: Record<string, string>;
	error?: string;
	durationMs: number;
	/** Workspace the run used (normalized to <CWD> in reports). */
	cwd: string;
}

export function renderInput(input: Record<string, unknown>, cwd: string): Record<string, unknown> {
	return JSON.parse(JSON.stringify(input).replaceAll("{{cwd}}", cwd.replaceAll("\\", "\\\\")));
}

/** Build the mock-server script for one harness. */
export function toMockTurns(turns: ScenarioTurn[], harness: Harness, cwd: string): Turn[] {
	return turns.map((t) => ({
		text: t.text,
		calls: (t.calls ?? []).flatMap((c): ScriptedCall[] => {
			const o = c[harness];
			if (o === "skip") return [];
			const call = o ?? { tool: c.tool, input: c.input };
			const input = call.input;
			if (typeof input === "function") {
				return [{ tool: call.tool, input: (req: CapturedRequest) => renderInput(input({ results: req.toolResults.map((r) => r.text), all: req.allToolResults.map((r) => r.text), cwd }), cwd) }];
			}
			return [{ tool: call.tool, input: renderInput(input, cwd) }];
		}),
	}));
}

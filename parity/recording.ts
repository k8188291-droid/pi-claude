import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type GitFixture, materializeFixture } from "./fixture.js";
import type { InputContext, Scenario, ScenarioTurn } from "./types.js";

/** A real Claude Code session recorded through the mock server's proxy mode. */
export interface Recording {
	name: string;
	description: string;
	prompt: string;
	model: string;
	recordedAt: string;
	fixture: GitFixture;
	/** Workspace path during recording (replaced by {{cwd}} on replay). */
	recordedCwd: string;
	conversations: Array<{
		/** "main" or "sub<N>". */
		name: string;
		/** Agent prompt that started this subagent ({{cwd}}-templated); routes replay requests. */
		match?: string;
		/** The subagent's first user message as recorded ({{cwd}}-templated), for reference. */
		firstUser?: string;
		turns: Array<{ content: any[] } | null>;
		toolResults: Array<{ toolUseId: string; text: string; isError: boolean }>;
	}>;
}

/** Values that differ per run and are referenced by later tool calls (task ids, temp paths). */
const DYNAMIC = [/(?<=ID: )[\w-]+/g, /(?<=agentId: )[\w-]+/g, /(?<="task_id":")[\w-]+/g, /\/tmp\/[^\s"'<>)\]]+/g];

/** Only values that look like run-specific ids or temp paths (never short words or numbers like "1"). */
const LOOKS_DYNAMIC = /^(?:[ab][0-9a-z]{8,}|\/tmp\/.{6,})$/;

function tokens(text: string): string[] {
	return DYNAMIC.flatMap((re) => [...text.matchAll(re)].map((m) => m[0])).filter((t) => LOOKS_DYNAMIC.test(t));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Map recorded dynamic values to the values seen in this run (paired by result position, then token position). */
function liveMapping(recorded: string[], live: string[], recordedCwd: string, cwd: string): Map<string, string> {
	const map = new Map<string, string>();
	recorded.forEach((r, i) => {
		const l = live[i];
		if (l === undefined) return;
		const rt = tokens(r.replaceAll(recordedCwd, cwd));
		const lt = tokens(l);
		rt.forEach((tok, j) => {
			if (lt[j] !== undefined && lt[j] !== tok) map.set(tok, lt[j]);
		});
	});
	return map;
}

function summarize(tool: string, input: any): string {
	const v = input?.file_path ?? input?.pattern ?? input?.command ?? input?.description ?? input?.subject ?? input?.prompt ?? "";
	const s = String(v).replace(/\s+/g, " ");
	return `${tool}: ${s.length > 60 ? s.slice(0, 57) + "..." : s}`;
}

function toTurns(rec: Recording, conv: Recording["conversations"][number]): ScenarioTurn[] {
	const recordedResults = conv.toolResults.map((r) => r.text);
	return conv.turns.map((t) => {
		const content = t?.content ?? [];
		const text = content.filter((b) => b.type === "text").map((b) => b.text).join("\n") || undefined;
		const calls = content
			.filter((b) => b.type === "tool_use")
			.map((b) => {
				const template = JSON.stringify(b.input ?? {}).replaceAll(rec.recordedCwd, "{{cwd}}");
				return {
					label: summarize(b.name, b.input),
					tool: b.name,
					input: (ctx: InputContext) => {
						let json = template;
						const map = liveMapping(recordedResults, ctx.all, rec.recordedCwd, ctx.cwd);
						// whole-token replacement only, longest first
						for (const [from, to] of [...map].sort((a, b) => b[0].length - a[0].length)) {
							json = json.replace(new RegExp(`(?<![\\w/.-])${escapeRe(from)}(?![\\w-])`, "g"), to);
						}
						return JSON.parse(json);
					},
				};
			});
		return { text, calls };
	});
}

export function recordingToScenario(rec: Recording): Scenario {
	const main = rec.conversations.find((c) => c.name === "main")!;
	const subs = rec.conversations.filter((c) => c.name !== "main");
	return {
		name: rec.name,
		description: `${rec.description} (recorded ${rec.recordedAt} with ${rec.model}; fixture ${rec.fixture.commit.slice(0, 7)})`,
		prompt: rec.prompt,
		setup: (cwd) => materializeFixture(rec.fixture, cwd),
		turns: toTurns(rec, main),
		subagents: Object.fromEntries(subs.map((c) => [c.name, toTurns(rec, c)])),
		subagentRoutes: subs.filter((c) => c.match).map((c) => ({ name: c.name, match: c.match! })),
		compareFiles: [],
		maxTurns: Math.max(60, main.turns.length + 10),
	};
}

export function loadRecordings(dir = join(import.meta.dirname, "recordings")): Scenario[] {
	let files: string[] = [];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".raw.json"));
	} catch {
		return [];
	}
	return files.sort().map((f) => recordingToScenario(JSON.parse(readFileSync(join(dir, f), "utf8")) as Recording));
}

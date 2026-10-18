import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { createTwoFilesPatch } from "diff";
import type { RunOutcome, Scenario, StepResult } from "./types.js";

/**
 * Harness-injected reminders that are not part of a tool's own output (context-usage counters,
 * "you haven't used the task tools" nudges). Stripped before comparing.
 */
const NOISE_REMINDERS = [/<total_tokens>/, /tools? (haven't|hasn't) been used recently/i, /Available agent types for the Agent tool/];

export function stripNoise(text: string): string {
	return text
		.replace(/\n*<system-reminder>[\s\S]*?<\/system-reminder>/g, (block) => (NOISE_REMINDERS.some((re) => re.test(block)) ? "" : block))
		.replace(/^<tool_use_error>([\s\S]*)<\/tool_use_error>$/, "$1");
}

/** Remove run-specific noise so equal behavior compares equal. */
export function normalize(text: string, cwd: string): string {
	let out = stripNoise(text);
	const cwds = new Set([cwd]);
	try {
		cwds.add(realpathSync(cwd));
	} catch {}
	for (const c of [...cwds].sort((a, b) => b.length - a.length)) out = out.replaceAll(c, "<CWD>");
	const tmp = tmpdir();
	out = out
		.replace(new RegExp(`${tmp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[^\\s"'<>)]*`, "g"), "<TMP>")
		.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, "<TS>")
		.replace(/\b\d+(\.\d+)?\s?(ms|s)\b/g, "<DUR>")
		.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<UUID>")
		.replace(/\b(agentId|agent_id|task_id|shell_id|bash_id)(["':=\s]+)[\w-]+/gi, "$1$2<ID>")
		.replace(/(\bID:\s*|\btask:\s*|\bshell:\s*|<task-id>|<tool-use-id>)[\w-]+/g, "$1<ID>")
		.replace(/\bbash_\d+\b/g, "<ID>")
		.replace(/\b(duration_ms|durationMs)(["':=\s]+)\d+/g, "$1$2<N>")
		.replace(/<(duration_ms|subagent_tokens)>\d+<\/\1>/g, "<$1><N></$1>")
		.replace(/[ \t]+$/gm, "")
		.replace(/^\n+|\s+$/g, "");
	return out;
}

export type Verdict = "same" | "differs" | "only-claude" | "only-pi" | "both-missing" | "skipped";

export interface StepComparison {
	label: string;
	claude: StepResult;
	pi: StepResult;
	verdict: Verdict;
	statusDiffers: boolean;
	diff?: string;
	claudeText: string;
	piText: string;
}

export interface ScenarioComparison {
	scenario: Scenario;
	claude: RunOutcome;
	pi: RunOutcome;
	steps: StepComparison[];
	fileDiffs: Array<{ path: string; diff: string }>;
	toolSetOnlyClaude: string[];
	toolSetOnlyPi: string[];
	schemaDiffs: Array<{ tool: string; onlyClaude: string[]; onlyPi: string[] }>;
	subagentToolDiffs: Array<{ name: string; claude: string[]; pi: string[] }>;
}

function props(schema: any): string[] {
	return Object.keys(schema?.properties ?? {}).sort();
}

export function compare(s: Scenario, claude: RunOutcome, pi: RunOutcome): ScenarioComparison {
	const steps: StepComparison[] = claude.steps.map((c, i) => {
		const p = pi.steps[i];
		const claudeText = normalize(c.text, claude.cwd);
		const piText = normalize(p.text, pi.cwd);
		let verdict: Verdict;
		if (c.status === "skipped" || p.status === "skipped") verdict = "skipped";
		else if (c.status === "missing" && p.status === "missing") verdict = "both-missing";
		else if (c.status === "missing") verdict = "only-pi";
		else if (p.status === "missing") verdict = "only-claude";
		else verdict = claudeText === piText && c.isError === p.isError ? "same" : "differs";
		const diff =
			verdict === "differs" && claudeText !== piText
				? createTwoFilesPatch("claude", "pi", claudeText + "\n", piText + "\n", "", "", { context: 2 })
						.split("\n")
						.slice(2)
						.join("\n")
				: undefined;
		return { label: c.label, claude: c, pi: p, verdict, statusDiffers: c.isError !== p.isError, diff, claudeText, piText };
	});

	const fileDiffs: ScenarioComparison["fileDiffs"] = [];
	for (const path of [...new Set([...Object.keys(claude.files), ...Object.keys(pi.files)])].sort()) {
		const a = claude.files[path];
		const b = pi.files[path];
		if (a === b) continue;
		fileDiffs.push({
			path,
			diff:
				a === undefined
					? "(only created by pi)"
					: b === undefined
						? "(only created by claude)"
						: createTwoFilesPatch(`claude/${path}`, `pi/${path}`, a, b, "", "", { context: 2 }).split("\n").slice(2).join("\n"),
		});
	}

	const cTools = new Map(claude.tools.map((t) => [t.name, t]));
	const pTools = new Map(pi.tools.map((t) => [t.name, t]));
	const schemaDiffs: ScenarioComparison["schemaDiffs"] = [];
	for (const [name, ct] of cTools) {
		const pt = pTools.get(name);
		if (!pt) continue;
		const a = props(ct.input_schema);
		const b = props(pt.input_schema);
		const onlyClaude = a.filter((x) => !b.includes(x));
		const onlyPi = b.filter((x) => !a.includes(x));
		if (onlyClaude.length || onlyPi.length) schemaDiffs.push({ tool: name, onlyClaude, onlyPi });
	}
	const subagentToolDiffs = Object.keys(s.subagents ?? {})
		.map((name) => ({ name, claude: claude.subagentTools[name] ?? [], pi: pi.subagentTools[name] ?? [] }))
		.filter((d) => d.claude.join() !== d.pi.join());

	return {
		scenario: s,
		claude,
		pi,
		steps,
		fileDiffs,
		toolSetOnlyClaude: [...cTools.keys()].filter((n) => !pTools.has(n)).sort(),
		toolSetOnlyPi: [...pTools.keys()].filter((n) => !cTools.has(n)).sort(),
		schemaDiffs,
		subagentToolDiffs,
	};
}

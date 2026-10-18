import type { ScenarioComparison } from "./compare.js";

const icon: Record<string, string> = { same: "✅ same", differs: "⚠️ differs", "only-claude": "❌ pi missing", "only-pi": "❌ claude missing", "both-missing": "— both missing", skipped: "⏭ skipped" };
const fence = (s: string, lang = "") => "```" + lang + "\n" + s.replaceAll("```", "ˋˋˋ") + "\n```";
const clip = (s: string, n = 1500) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more chars)` : s);
const status = (st: { status: string }) => st.status;

export function renderReport(results: ScenarioComparison[], meta: { model: string; date: string }): string {
	const out: string[] = [];
	out.push(`# Parity report: Claude Agent SDK vs pi-claude`, "");
	out.push(`Model output is scripted by a mock Anthropic API, so both harnesses received identical tool calls. Differences below come from the tools/harness. Model id sent: \`${meta.model}\`. Generated ${meta.date}.`, "");
	out.push(`| Scenario | Steps same | Differ | Missing | File diffs | Extra turns | Errors |`, `|---|---|---|---|---|---|---|`);
	for (const r of results) {
		const n = (v: string) => r.steps.filter((s) => s.verdict === v).length;
		const missing = n("only-claude") + n("only-pi") + n("both-missing");
		const errs = [r.claude.error && "claude", r.pi.error && "pi"].filter(Boolean).join(", ") || "—";
		out.push(`| [${r.scenario.name}](#${r.scenario.name}) | ${n("same")}/${r.steps.length - n("skipped")} | ${n("differs")} | ${missing} | ${r.fileDiffs.length} | ${r.claude.extraTurns.length}/${r.pi.extraTurns.length} | ${errs} |`);
	}
	out.push("", "_Extra turns = claude/pi model requests beyond the script (e.g. background-task wake-ups)._", "");

	const first = results[0];
	if (first) {
		out.push(`## Tool sets declared to the model`, "");
		out.push(`- Only in Claude Code: ${first.toolSetOnlyClaude.map((t) => `\`${t}\``).join(", ") || "—"}`);
		out.push(`- Only in pi-claude: ${first.toolSetOnlyPi.map((t) => `\`${t}\``).join(", ") || "—"}`, "");
		if (first.schemaDiffs.length) {
			out.push(`| Tool | Params only in Claude Code | Params only in pi-claude |`, `|---|---|---|`);
			for (const d of first.schemaDiffs) out.push(`| ${d.tool} | ${d.onlyClaude.join(", ") || "—"} | ${d.onlyPi.join(", ") || "—"} |`);
			out.push("");
		}
	}

	for (const r of results) {
		out.push(`## ${r.scenario.name}`, "", r.scenario.description, "");
		if (r.claude.error) out.push(`**Claude run error:**`, fence(clip(r.claude.error, 800)), "");
		if (r.pi.error) out.push(`**pi run error:**`, fence(clip(r.pi.error, 800)), "");
		out.push(`| # | Step | Claude | pi | Verdict |`, `|---|---|---|---|---|`);
		r.steps.forEach((s, i) => {
			const tools = s.claude.tool === s.pi.tool ? s.claude.tool : `${s.claude.tool} / ${s.pi.tool}`;
			out.push(`| ${i + 1} | ${s.label} (\`${tools}\`) | ${status(s.claude)} | ${status(s.pi)} | ${icon[s.verdict]}${s.statusDiffers && s.verdict === "differs" ? " (error flag)" : ""} |`);
		});
		out.push("");
		r.steps.forEach((s, i) => {
			if (s.verdict === "same" || s.verdict === "skipped" || s.verdict === "both-missing") return;
			out.push(`<details><summary>${i + 1}. ${s.label}: ${icon[s.verdict]}</summary>`, "");
			if (s.diff) out.push(fence(clip(s.diff, 3000), "diff"));
			else {
				out.push("Claude:", fence(clip(s.claudeText)), "pi:", fence(clip(s.piText)));
			}
			out.push("", "</details>", "");
		});
		if (r.subagentToolDiffs.length) {
			out.push(`**Subagent tool sets differ:**`);
			for (const d of r.subagentToolDiffs) out.push(`- ${d.name}: claude [${d.claude.join(", ")}] vs pi [${d.pi.join(", ")}]`);
			out.push("");
		}
		if (r.fileDiffs.length) {
			out.push(`**Workspace differences after the run:**`, "");
			for (const f of r.fileDiffs) out.push(`- \`${f.path}\``, fence(clip(f.diff, 2000), "diff"));
			out.push("");
		}
		for (const [h, o] of [["claude", r.claude], ["pi", r.pi]] as const) {
			if (o.extraTurns.length) out.push(`**Extra ${h} turns:**`, ...o.extraTurns.map((t) => `- ${t}`), "");
		}
	}
	return out.join("\n");
}

/**
 * Replay scripted scenarios against Claude Code (via @anthropic-ai/claude-agent-sdk) and pi-claude,
 * then report the differences.
 *
 *   npx tsx parity/run.ts [--only name1,name2] [--out parity/out] [--model claude-sonnet-4-6]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compare, type ScenarioComparison } from "./compare.js";
import { MockAnthropicServer } from "./mock-server.js";
import { renderReport } from "./report.js";
import { runClaude } from "./runners/claude-sdk.js";
import { runPi } from "./runners/pi.js";
import { scenarios } from "./scenarios/index.js";

const arg = (name: string) => {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
};
const only = arg("only")?.split(",");
const outDir = arg("out") ?? join(import.meta.dirname, "out");
const model = arg("model") ?? "claude-sonnet-4-6";

const mock = new MockAnthropicServer();
const baseUrl = await mock.start();
const results: ScenarioComparison[] = [];
try {
	for (const s of scenarios.filter((x) => !only || only.includes(x.name))) {
		process.stderr.write(`▶ ${s.name}: claude… `);
		const claude = await runClaude(s, mock, baseUrl, model);
		process.stderr.write(`${claude.durationMs}ms, pi… `);
		const pi = await runPi(s, mock, baseUrl, model);
		const cmp = compare(s, claude, pi);
		results.push(cmp);
		const same = cmp.steps.filter((x) => x.verdict === "same").length;
		process.stderr.write(`${pi.durationMs}ms — ${same}/${cmp.steps.length} same, ${cmp.fileDiffs.length} file diffs\n`);
	}
} finally {
	await mock.stop();
}
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "report.md"), renderReport(results, { model, date: new Date().toISOString() }));
writeFileSync(
	join(outDir, "results.json"),
	JSON.stringify(results.map((r) => ({ scenario: r.scenario.name, steps: r.steps, fileDiffs: r.fileDiffs, claude: { ...r.claude, tools: r.claude.tools.map((t) => t.name) }, pi: { ...r.pi, tools: r.pi.tools.map((t) => t.name) } })), null, 2),
);
process.stderr.write(`report: ${join(outDir, "report.md")}\n`);

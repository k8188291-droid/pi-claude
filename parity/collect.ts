import { type MockAnthropicServer, toolUseId } from "./mock-server.js";
import type { Harness, RunOutcome, Scenario, ScenarioTurn, StepResult } from "./types.js";

function collectRoute(mock: MockAnthropicServer, route: string, turns: ScenarioTurn[], harness: Harness, prefix: string): StepResult[] {
	const steps: StepResult[] = [];
	const reqs = mock.requests.filter((r) => r.route === route);
	turns.forEach((turn, t) => {
		let rendered = 0;
		(turn.calls ?? []).forEach((call, i) => {
			const o = call[harness];
			const tool = o && o !== "skip" ? o.tool : call.tool;
			const label = `${prefix}${call.label ?? call.tool}`;
			if (o === "skip") {
				steps.push({ turn: t, index: i, label, tool, toolUseId: "", text: "", isError: false, status: "skipped" });
				return;
			}
			const id = toolUseId(route, t, rendered++);
			// last request that carries this tool_use_id's result
			const hit = reqs
				.flatMap((r) => r.allToolResults)
				.filter((x) => x.toolUseId === id)
				.at(-1);
			steps.push({
				turn: t,
				index: i,
				label,
				tool,
				toolUseId: id,
				text: hit?.text ?? "",
				isError: hit?.isError ?? false,
				status: hit ? (hit.isError ? "error" : "ok") : "missing",
			});
		});
	});
	return steps;
}

export function collectOutcome(
	mock: MockAnthropicServer,
	s: Scenario,
	harness: Harness,
	extra: { files: Record<string, string>; error?: string; durationMs: number; cwd: string },
): RunOutcome {
	const steps = collectRoute(mock, "main", s.turns, harness, "");
	for (const [name, turns] of Object.entries(s.subagents ?? {})) {
		steps.push(...collectRoute(mock, name, turns, harness, `[sub:${name}] `));
	}
	const firstMain = mock.requests.find((r) => r.route === "main");
	const subagentTools: Record<string, string[]> = {};
	for (const name of Object.keys(s.subagents ?? {})) {
		const r = mock.requests.find((x) => x.route === name);
		subagentTools[name] = r ? [...r.toolNames].sort() : [];
	}
	const extraTurns = mock.requests
		.filter((r) => r.route === "main" && r.turnIndex >= s.turns.length)
		.map((r) => `turn ${r.turnIndex}: ${r.lastUserText.replace(/\s+/g, " ").slice(0, 200)}`);
	return {
		harness,
		steps,
		tools: firstMain?.tools ?? [],
		subagentTools,
		extraTurns,
		...extra,
	};
}

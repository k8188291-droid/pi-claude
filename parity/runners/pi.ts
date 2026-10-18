import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createClaudeCodeSession } from "../../src/index.js";
import { collectOutcome } from "../collect.js";
import type { MockAnthropicServer } from "../mock-server.js";
import { toMockTurns, type RunOutcome, type Scenario } from "../types.js";
import { createWorkspace, snapshot } from "../workspace.js";

export async function runPi(s: Scenario, mock: MockAnthropicServer, baseUrl: string, modelId: string): Promise<RunOutcome> {
	const cwd = await createWorkspace(s, "pi");
	mock.load(
		{
			main: toMockTurns(s.turns, "pi", cwd),
			subagents: Object.fromEntries(Object.entries(s.subagents ?? {}).map(([k, v]) => [k, toMockTurns(v, "pi", cwd)])),
			subagentRoutes: s.subagentRoutes?.map((r) => ({ ...r, match: r.match.replaceAll("{{cwd}}", cwd) })),
		},
		"pi",
	);
	const t0 = Date.now();
	let error: string | undefined;
	// running subagents, tracked from host events (the session must not be closed while they work)
	const runningAgents = new Set<string>();
	const home = mkdtempSync(join(tmpdir(), "parity-pi-home-"));
	const modelRuntime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null, refreshOnCreate: false });
	await modelRuntime.setRuntimeApiKey("anthropic", "sk-ant-mock");
	const base = modelRuntime.getModel("anthropic", modelId);
	if (!base) throw new Error(`unknown model ${modelId}`);
	const model = { ...base, baseUrl };
	const { session } = await createClaudeCodeSession({
		cwd,
		agentDir: home,
		model,
		modelRuntime,
		thinkingLevel: "off",
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } } as any),
		claudeCode: {
			loadAgentsFromDisk: false,
			outputSpill: { dir: join(home, "tool-results") },
			onEvent: (e) => {
				if (e.type === "subagent_start") runningAgents.add(e.agentId);
				else if (e.type === "subagent_end") runningAgents.delete(e.agentId);
			},
			onAskUserQuestion: async (qs) => Object.fromEntries(qs.map((q) => [q.question, q.options[0]?.label ?? ""])),
		},
		loader: { noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true, noExtensions: true },
	});
	try {
		await session.bindExtensions({});
		await session.prompt(s.prompt);
		// Let background agents and the turns their notifications start play out, like Claude Code
		// does before its query ends: wait until no agent is running, the session is idle, and no
		// model request has arrived for a while.
		const quietMs = 3000;
		const deadline = Date.now() + 10 * 60_000;
		let seen = -1;
		let quietSince = Date.now();
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 250));
			await session.waitForIdle?.();
			if (runningAgents.size > 0 || mock.requests.length !== seen) {
				seen = mock.requests.length;
				quietSince = Date.now();
			} else if (Date.now() - quietSince >= quietMs) break;
		}
	} catch (e) {
		error = (e as Error).message;
	} finally {
		session.dispose();
	}
	return collectOutcome(mock, s, "pi", { files: snapshot(cwd, s.compareFiles), error, durationMs: Date.now() - t0, cwd });
}

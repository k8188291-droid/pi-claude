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
			subagentRoutes: s.subagentRoutes,
		},
		"pi",
	);
	const t0 = Date.now();
	let error: string | undefined;
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
			onAskUserQuestion: async (qs) => Object.fromEntries(qs.map((q) => [q.question, q.options[0]?.label ?? ""])),
		},
		loader: { noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true, noExtensions: true },
	});
	try {
		await session.bindExtensions({});
		await session.prompt(s.prompt);
		// let background notifications (if any) play out
		await new Promise((r) => setTimeout(r, 300));
		await session.waitForIdle?.();
	} catch (e) {
		error = (e as Error).message;
	} finally {
		session.dispose();
	}
	return collectOutcome(mock, s, "pi", { files: snapshot(cwd, s.compareFiles), error, durationMs: Date.now() - t0, cwd });
}

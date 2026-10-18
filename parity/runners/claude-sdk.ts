import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { collectOutcome } from "../collect.js";
import type { MockAnthropicServer } from "../mock-server.js";
import { toMockTurns, type RunOutcome, type Scenario } from "../types.js";
import { createWorkspace, snapshot } from "../workspace.js";

/** Tools enabled in Claude Code (native builds need Glob/Grep listed explicitly). */
export const CLAUDE_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Agent", "AskUserQuestion", "TaskStop", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "NotebookEdit"];

const firstLabels = (questions: any[]) => Object.fromEntries((questions ?? []).map((q: any) => [q.question, q.options?.[0]?.label ?? ""]));

export async function runClaude(s: Scenario, mock: MockAnthropicServer, baseUrl: string, model: string): Promise<RunOutcome> {
	const cwd = await createWorkspace(s, "claude");
	mock.load(
		{
			main: toMockTurns(s.turns, "claude", cwd),
			subagents: Object.fromEntries(Object.entries(s.subagents ?? {}).map(([k, v]) => [k, toMockTurns(v, "claude", cwd)])),
			subagentRoutes: s.subagentRoutes,
		},
		"claude",
	);
	const t0 = Date.now();
	let error: string | undefined;
	const stderr: string[] = [];
	try {
		for await (const msg of query({
			prompt: s.prompt,
			options: {
				cwd,
				model,
				tools: CLAUDE_TOOLS,
				settingSources: [],
				persistSession: false,
				maxTurns: 60,
				permissionMode: "default",
				// allow everything; answer AskUserQuestion with each question's first option
				canUseTool: async (name, input) =>
					name === "AskUserQuestion"
						? { behavior: "allow", updatedInput: { ...input, answers: firstLabels((input as any).questions) } }
						: { behavior: "allow", updatedInput: input },
				stderr: (d) => stderr.push(d),
				env: {
					PATH: process.env.PATH,
					HOME: mkdtempSync(join(tmpdir(), "parity-home-")),
					LANG: "C.UTF-8",
					IS_SANDBOX: "1",
					ANTHROPIC_BASE_URL: baseUrl,
					ANTHROPIC_API_KEY: "sk-ant-mock",
					CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
					DISABLE_TELEMETRY: "1",
					DISABLE_AUTOUPDATER: "1",
				},
			},
		})) {
			if (msg.type === "result" && msg.subtype !== "success") error = `result ${msg.subtype}`;
		}
	} catch (e) {
		error = `${(e as Error).message}\n${stderr.join("").slice(-2000)}`;
	}
	await new Promise((r) => setTimeout(r, 300));
	return collectOutcome(mock, s, "claude", { files: snapshot(cwd, s.compareFiles), error, durationMs: Date.now() - t0, cwd });
}

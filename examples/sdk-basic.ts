/**
 * Minimal SDK usage: a pi session with Claude Code-compatible tools.
 * Run: ANTHROPIC_API_KEY=... npx tsx examples/sdk-basic.ts
 */
import { getModel } from "@mariozechner/pi-ai";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { createClaudeCodeSession } from "../src/index.js";

const { session } = await createClaudeCodeSession({
	cwd: process.cwd(),
	model: getModel("anthropic", "claude-sonnet-4-6"),
	sessionManager: SessionManager.inMemory(process.cwd()),
	claudeCode: {
		// AskUserQuestion → your UI. Answers are keyed by question text.
		onAskUserQuestion: async (questions) => {
			const answers: Record<string, string> = {};
			for (const q of questions) answers[q.question] = q.options[0].label;
			return answers;
		},
		// Todos, background shells, subagent progress, spilled outputs, ...
		onEvent: (event) => {
			if (event.type === "todos_updated") console.error("[todos]", event.todos.map((t) => `${t.status}: ${t.content}`));
			if (event.type === "subagent_start") console.error(`[subagent ${event.subagentType}] ${event.description}`);
		},
		// Custom subagents (in addition to general-purpose / Explore / Plan and .claude/agents/*.md)
		agents: {
			reviewer: {
				description: "Reviews a diff for bugs. Use after making code changes.",
				prompt: "You are a meticulous code reviewer. Report concrete bugs only.",
				tools: ["Read", "Grep", "Glob", "Bash"],
			},
		},
	},
});

session.subscribe((event) => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
	}
	if (event.type === "tool_execution_start") console.error(`\n[tool] ${event.toolName}`);
});

await session.prompt(process.argv[2] ?? "List the TypeScript files in this project and summarize what each does.");
session.dispose();

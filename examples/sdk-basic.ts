/**
 * Minimal SDK usage: a pi session with Claude Code-compatible tools.
 * Run: ANTHROPIC_API_KEY=... [MODEL=claude-sonnet-5-5] npx tsx examples/sdk-basic.ts "your prompt"
 */
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createClaudeCodeSession } from "../src/index.js";

// ModelRuntime reads ANTHROPIC_API_KEY (or stored credentials) and holds the model catalog.
const modelRuntime = await ModelRuntime.create();
const modelId = process.env.MODEL ?? "claude-sonnet-5-5";
const model = modelRuntime.getModel("anthropic", modelId);
if (!model) throw new Error(`Unknown Anthropic model: ${modelId}`);

const { session } = await createClaudeCodeSession({
	cwd: process.cwd(),
	model,
	modelRuntime,
	sessionManager: SessionManager.inMemory(process.cwd()),
	claudeCode: {
		// Tools the model only sees after finding them with pi's built-in tool_search, e.g. DEFERRED_TOOLS=Glob,Grep
		deferredTools: process.env.DEFERRED_TOOLS?.split(",").filter(Boolean),
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
	if (event.type === "tool_execution_start") console.error(`\n[tool] ${event.toolName} ${JSON.stringify(event.args).slice(0, 120)}`);
	if (event.type === "tool_execution_end" && event.isError) console.error(`[tool error] ${event.toolName}`);
	if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error") {
		console.error(`[model error] ${event.message.errorMessage}`);
	}
});

await session.prompt(process.argv[2] ?? "List the TypeScript files in this project and summarize what each does.");
session.dispose();

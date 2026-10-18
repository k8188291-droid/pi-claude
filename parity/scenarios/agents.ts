import type { InputContext, Scenario } from "../types.js";

/** agentId from the newest "Async agent launched" tool result. */
const lastAgentId = (ctx: InputContext) => {
	const m = [...ctx.all].reverse().join("\n").match(/agentId: (\w+)/);
	return m?.[1] ?? "missing";
};

export const agentScenarios: Scenario[] = [
	{
		name: "subagent",
		description: "Agent: general-purpose subagent reads a file and reports back; Explore subagent tries to write (both run in the background by default).",
		files: { "notes.txt": "The secret word is pineapple.\n" },
		prompt: "Delegate to subagents.",
		subagents: {
			reader: [{ calls: [{ label: "child Read", tool: "Read", input: { file_path: "{{cwd}}/notes.txt" } }] }, { text: "The notes say the secret word is pineapple." }],
			explorer: [{ calls: [{ label: "child Write (read-only agent)", tool: "Write", input: { file_path: "{{cwd}}/explore.txt", content: "x" } }] }, { text: "Explore finished." }],
		},
		turns: [
			{
				calls: [
					{
						label: "general-purpose subagent",
						tool: "Agent",
						input: { description: "Read notes", prompt: "[[sub:reader]] Read notes.txt and report the secret word.", subagent_type: "general-purpose" },
					},
				],
			},
			// the background agent finishes while this runs: its notification is attached to this result
			{ calls: [{ label: "wait (gets notification)", tool: "Bash", input: { command: "sleep 1; echo waited", description: "Wait" } }] },
			{
				calls: [{ label: "Explore subagent", tool: "Agent", input: { description: "Explore repo", prompt: "[[sub:explorer]] Look around.", subagent_type: "Explore" } }],
			},
			{ calls: [{ label: "wait (gets notification)", tool: "Bash", input: { command: "sleep 1; echo waited", description: "Wait" } }] },
			{ text: "done" },
		],
	},
	{
		name: "subagent-sync",
		description: "Agent with run_in_background: false (foreground): general-purpose, Explore and Plan results, default type, model override.",
		files: { "notes.txt": "The secret word is pineapple.\n" },
		prompt: "Run subagents in the foreground.",
		subagents: {
			gp: [{ calls: [{ label: "child Read", tool: "Read", input: { file_path: "{{cwd}}/notes.txt" } }] }, { text: "The secret word is pineapple." }],
			ex: [{ text: "Found notes.txt." }],
			plan: [{ text: "Plan: edit notes.txt." }],
			deflt: [{ text: "Default agent done." }],
			opus: [{ text: "Opus agent done." }],
			empty: [{ text: "" }],
		},
		turns: [
			{ calls: [{ label: "general-purpose foreground", tool: "Agent", input: { description: "Read notes", prompt: "[[sub:gp]] Read notes.txt.", subagent_type: "general-purpose", run_in_background: false } }] },
			{ calls: [{ label: "Explore foreground", tool: "Agent", input: { description: "Find notes", prompt: "[[sub:ex]] Find notes.", subagent_type: "Explore", run_in_background: false } }] },
			{ calls: [{ label: "Plan foreground", tool: "Agent", input: { description: "Plan edit", prompt: "[[sub:plan]] Plan an edit.", subagent_type: "Plan", run_in_background: false } }] },
			{ calls: [{ label: "default type foreground", tool: "Agent", input: { description: "Default agent", prompt: "[[sub:deflt]] Do it.", run_in_background: false } }] },
			{ calls: [{ label: "model override", tool: "Agent", input: { description: "Opus agent", prompt: "[[sub:opus]] Do it.", model: "opus", run_in_background: false } }] },
			{ calls: [{ label: "empty final text", tool: "Agent", input: { description: "Empty agent", prompt: "[[sub:empty]] Say nothing.", run_in_background: false } }] },
			{ text: "done" },
		],
	},
	{
		name: "subagent-errors",
		description: "Agent input errors: unknown subagent_type, case/dash-normalized type name, invalid model, missing prompt.",
		prompt: "Try bad agent calls.",
		subagents: {
			norm: [{ text: "Normalized type worked." }],
			badmodel: [{ text: "should not run" }],
		},
		turns: [
			{ calls: [{ label: "unknown subagent_type", tool: "Agent", input: { description: "Nope", prompt: "x", subagent_type: "nope", run_in_background: false } }] },
			{ calls: [{ label: "normalized subagent_type", tool: "Agent", input: { description: "Explore lower", prompt: "[[sub:norm]] Look.", subagent_type: "explore", run_in_background: false } }] },
			{ calls: [{ label: "invalid model", tool: "Agent", input: { description: "Bad model", prompt: "[[sub:badmodel]] x", model: "gpt-5", run_in_background: false } }] },
			{ calls: [{ label: "missing prompt", tool: "Agent", input: { description: "No prompt" } }] },
			{ text: "done" },
		],
	},
	{
		name: "subagent-nested",
		description: "A general-purpose subagent launches its own subagent (no run_in_background).",
		prompt: "Nest agents.",
		subagents: {
			outer: [
				{ calls: [{ label: "nested Agent", tool: "Agent", input: { description: "Inner agent", prompt: "[[sub:inner]] Say hi.", subagent_type: "general-purpose" } }] },
				{ text: "Outer done." },
			],
			inner: [{ text: "Inner says hi." }],
		},
		turns: [
			{ calls: [{ label: "outer foreground", tool: "Agent", input: { description: "Outer agent", prompt: "[[sub:outer]] Spawn an inner agent.", run_in_background: false } }] },
			{ text: "done" },
		],
	},
	{
		name: "subagent-stop",
		description: "TaskStop on a running background agent (its child is busy in a slow Bash command).",
		prompt: "Start and stop an agent.",
		subagents: {
			slow: [{ calls: [{ label: "child slow Bash", tool: "Bash", input: { command: "sleep 3; echo slept", description: "Sleep" } }] }, { text: "Slow agent done." }],
		},
		turns: [
			{ calls: [{ label: "background agent", tool: "Agent", input: { description: "Slow agent", prompt: "[[sub:slow]] Sleep a while.", run_in_background: true } }] },
			{ calls: [{ label: "TaskStop agent", tool: "TaskStop", input: (ctx) => ({ task_id: lastAgentId(ctx) }) }] },
			{ text: "done" },
		],
	},
];

import type { Scenario } from "../types.js";

export const agentScenarios: Scenario[] = [
	{
		name: "subagent",
		description: "Task/Agent: general-purpose subagent reads a file and reports back; Explore subagent tries to write.",
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
						tool: "Task",
						input: { description: "Read notes", prompt: "[[sub:reader]] Read notes.txt and report the secret word.", subagent_type: "general-purpose" },
						claude: { tool: "Agent", input: { description: "Read notes", prompt: "[[sub:reader]] Read notes.txt and report the secret word.", subagent_type: "general-purpose" } },
					},
				],
			},
			{
				calls: [
					{
						label: "Explore subagent",
						tool: "Task",
						input: { description: "Explore repo", prompt: "[[sub:explorer]] Look around.", subagent_type: "Explore" },
						claude: { tool: "Agent", input: { description: "Explore repo", prompt: "[[sub:explorer]] Look around.", subagent_type: "Explore" } },
					},
				],
			},
			{ text: "done" },
		],
	},
];

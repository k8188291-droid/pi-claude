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
	{
		name: "ask-user",
		description: "AskUserQuestion answered by the host (first option).",
		prompt: "Ask me something.",
		turns: [
			{
				calls: [
					{
						label: "two questions",
						tool: "AskUserQuestion",
						input: {
							questions: [
								{ question: "Which database?", header: "DB", multiSelect: false, options: [{ label: "Postgres", description: "SQL" }, { label: "Mongo", description: "NoSQL" }] },
								{ question: "Which features?", header: "Features", multiSelect: true, options: [{ label: "Auth", description: "login" }, { label: "Billing", description: "payments" }] },
							],
						},
					},
				],
			},
			{ calls: [{ label: "invalid (1 option)", tool: "AskUserQuestion", input: { questions: [{ question: "Only one?", header: "One", multiSelect: false, options: [{ label: "A", description: "a" }] }] } }] },
			{ text: "done" },
		],
	},
	{
		name: "todos",
		description: "Task tracking: pi-claude's TodoWrite vs Claude Code's TaskCreate/TaskUpdate/TaskList.",
		prompt: "Track tasks.",
		turns: [
			{
				calls: [
					{
						label: "create todos",
						tool: "TodoWrite",
						input: { todos: [{ content: "Write code", activeForm: "Writing code", status: "in_progress" }, { content: "Test", activeForm: "Testing", status: "pending" }] },
						claude: { tool: "TaskCreate", input: { subject: "Write code", description: "Write code" } },
					},
				],
			},
			{
				calls: [
					{
						label: "complete first",
						tool: "TodoWrite",
						input: { todos: [{ content: "Write code", activeForm: "Writing code", status: "completed" }, { content: "Test", activeForm: "Testing", status: "in_progress" }] },
						claude: { tool: "TaskUpdate", input: { taskId: "1", status: "completed" } },
					},
				],
			},
			{ calls: [{ label: "list", tool: "TodoWrite", input: { todos: [] }, claude: { tool: "TaskList", input: {} } }] },
			{ text: "done" },
		],
	},
	{
		name: "notebook-edit",
		description: "NotebookEdit exists in Claude Code but not in pi-claude.",
		files: { "nb.ipynb": JSON.stringify({ cells: [{ cell_type: "code", id: "c1", metadata: {}, source: ["x = 1"], outputs: [], execution_count: null }], metadata: {}, nbformat: 4, nbformat_minor: 5 }) },
		prompt: "Edit the notebook.",
		turns: [
			{ calls: [{ label: "Read notebook", tool: "Read", input: { file_path: "{{cwd}}/nb.ipynb" } }] },
			{ calls: [{ label: "replace cell", tool: "NotebookEdit", input: { notebook_path: "{{cwd}}/nb.ipynb", cell_id: "c1", new_source: "x = 2" } }] },
			{ text: "done" },
		],
	},
];

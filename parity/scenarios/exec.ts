import type { Scenario } from "../types.js";

const idFrom = (text: string) => /(?:ID|id)[:\s]+["']?([\w-]+)/.exec(text)?.[1] ?? "unknown";
const outputPathFrom = (text: string) => /(\/[^\s"']+\.(?:output|log|txt))/.exec(text)?.[1] ?? "/nonexistent";

export const execScenarios: Scenario[] = [
	{
		name: "bash-basics",
		description: "Bash: output, persistent cwd, env not persisted, exit codes, stderr, timeout, empty output.",
		files: { "sub/marker.txt": "m\n" },
		prompt: "Run some commands.",
		turns: [
			{ calls: [{ label: "echo", tool: "Bash", input: { command: "echo hello", description: "Print hello" } }] },
			{ calls: [{ label: "cd sub", tool: "Bash", input: { command: "cd sub && pwd" } }] },
			{ calls: [{ label: "pwd after cd", tool: "Bash", input: { command: "pwd && ls" } }] },
			{ calls: [{ label: "export var", tool: "Bash", input: { command: "export FOO=bar; echo set" } }] },
			{ calls: [{ label: "var after export", tool: "Bash", input: { command: 'echo "FOO=[$FOO]"' } }] },
			{ calls: [{ label: "exit 3", tool: "Bash", input: { command: "echo before; exit 3" } }] },
			{ calls: [{ label: "stderr + stdout", tool: "Bash", input: { command: "echo out; echo err >&2" } }] },
			{ calls: [{ label: "timeout", tool: "Bash", input: { command: "echo start; sleep 5; echo never", timeout: 1000 } }] },
			{ calls: [{ label: "no output", tool: "Bash", input: { command: "true" } }] },
			{ calls: [{ label: "command not found", tool: "Bash", input: { command: "definitely_not_a_command_xyz" } }] },
			{ text: "done" },
		],
	},
	{
		name: "bash-background",
		description: "Background shells: start, read output after completion, stop a long-running one.",
		prompt: "Run background jobs.",
		turns: [
			{ calls: [{ label: "start bg job", tool: "Bash", input: { command: "echo bg-start; sleep 1; echo bg-done", run_in_background: true } }] },
			{ calls: [{ label: "wait", tool: "Bash", input: { command: "sleep 2; echo waited" } }] },
			{
				calls: [
					{
						label: "read bg output",
						tool: "BashOutput",
						input: ({ all }) => ({ bash_id: idFrom(all[0] ?? "") }),
						// Claude Code has no BashOutput: background output goes to a file the model Reads
						claude: { tool: "Read", input: ({ all }) => ({ file_path: outputPathFrom(all[0] ?? "") }) },
					},
				],
			},
			{ calls: [{ label: "start long bg job", tool: "Bash", input: { command: "sleep 30", run_in_background: true } }] },
			{
				calls: [
					{
						label: "stop long job",
						tool: "KillShell",
						input: ({ results }) => ({ shell_id: idFrom(results[0] ?? "") }),
						claude: { tool: "TaskStop", input: ({ results }) => ({ task_id: idFrom(results[0] ?? "") }) },
					},
				],
			},
			{ text: "done" },
		],
	},
	{
		name: "large-output",
		description: "Very large tool output: how each harness truncates or persists it.",
		files: { "big.txt": Array.from({ length: 20000 }, (_, i) => `row ${i} needle`).join("\n") + "\n" },
		prompt: "Produce big output.",
		turns: [
			{ calls: [{ label: "seq 1 40000", tool: "Bash", input: { command: "seq 1 40000" } }] },
			{ calls: [{ label: "Grep 20000 lines", tool: "Grep", input: { pattern: "needle", path: "{{cwd}}/big.txt", output_mode: "content", head_limit: 0 } }] },
			{ text: "done" },
		],
	},
];

export { outputPathFrom };

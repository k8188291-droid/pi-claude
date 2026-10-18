import { utimesSync } from "node:fs";
import { join } from "node:path";
import type { Scenario } from "../types.js";

const lines = (n: number, f = (i: number) => `line ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1)).join("\n") + "\n";

// 1x1 transparent PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const notebook = JSON.stringify({
	cells: [
		{ cell_type: "markdown", id: "intro", metadata: {}, source: ["# Title\n", "Some text"] },
		{ cell_type: "code", id: "c1", metadata: {}, execution_count: 1, source: ["print('hi')"], outputs: [{ output_type: "stream", name: "stdout", text: ["hi\n"] }] },
	],
	metadata: { kernelspec: { name: "python3", language: "python", display_name: "Python 3" } },
	nbformat: 4,
	nbformat_minor: 5,
});

export const searchScenarios: Scenario[] = [
	{
		name: "grep-modes",
		description: "Grep output modes, context, case, glob/type filters, pagination, multiline, no match, single file.",
		files: {
			"src/app.ts": "export function hello() {\n  return 'Hello';\n}\n// TODO: refactor\n",
			"src/util.ts": "export const HELLO = 1;\n// todo lower\n",
			"lib/tool.py": "def hello():\n    pass\n# TODO python\n",
			"README.md": "Hello readme\n",
			"multi.txt": "start\nmiddle\nend\n",
		},
		setup(cwd) {
			const t = Date.now() / 1000;
			["README.md", "lib/tool.py", "src/util.ts", "src/app.ts", "multi.txt"].forEach((f, i) => utimesSync(join(cwd, f), t - 1000 + i * 100, t - 1000 + i * 100));
		},
		prompt: "Search the code.",
		turns: [
			{
				calls: [
					{ label: "files_with_matches (default)", tool: "Grep", input: { pattern: "hello", path: "{{cwd}}" } },
					{ label: "content -n", tool: "Grep", input: { pattern: "TODO", path: "{{cwd}}", output_mode: "content", "-n": true } },
					{ label: "content context=1", tool: "Grep", input: { pattern: "return", path: "{{cwd}}", output_mode: "content", context: 1 } },
					{ label: "count", tool: "Grep", input: { pattern: "o", path: "{{cwd}}/src", output_mode: "count" } },
				],
			},
			{
				calls: [
					{ label: "-i", tool: "Grep", input: { pattern: "todo", path: "{{cwd}}", "-i": true, output_mode: "content" } },
					{ label: "glob *.ts", tool: "Grep", input: { pattern: "hello", path: "{{cwd}}", glob: "*.ts", "-i": true } },
					{ label: "type py", tool: "Grep", input: { pattern: "hello", path: "{{cwd}}", type: "py" } },
					{ label: "head_limit 1 offset 1", tool: "Grep", input: { pattern: "hello", path: "{{cwd}}", "-i": true, head_limit: 1, offset: 1 } },
				],
			},
			{
				calls: [
					{ label: "multiline", tool: "Grep", input: { pattern: "start.*end", path: "{{cwd}}", multiline: true, output_mode: "content" } },
					{ label: "no match", tool: "Grep", input: { pattern: "zzz_nothing", path: "{{cwd}}" } },
					{ label: "single file", tool: "Grep", input: { pattern: "Hello", path: "{{cwd}}/README.md", output_mode: "content" } },
					{ label: "-o", tool: "Grep", input: { pattern: "H[a-z]+", path: "{{cwd}}/src", output_mode: "content", "-o": true } },
				],
			},
			{ text: "done" },
		],
	},
	{
		name: "glob",
		description: "Glob: recursive pattern, mtime ordering, subdirectory, no match, missing directory.",
		files: { "a.ts": "", "b.ts": "", "src/c.ts": "", "src/deep/d.ts": "", "notes.md": "", "node_modules/pkg/index.ts": "" },
		setup(cwd) {
			const t = Date.now() / 1000;
			["src/deep/d.ts", "a.ts", "src/c.ts", "b.ts", "notes.md"].forEach((f, i) => utimesSync(join(cwd, f), t - 1000 + i * 100, t - 1000 + i * 100));
		},
		prompt: "Find files.",
		turns: [
			{
				calls: [
					{ label: "**/*.ts", tool: "Glob", input: { pattern: "**/*.ts" } },
					{ label: "*.md", tool: "Glob", input: { pattern: "*.md" } },
					{ label: "path=src", tool: "Glob", input: { pattern: "*.ts", path: "{{cwd}}/src" } },
					{ label: "no match", tool: "Glob", input: { pattern: "*.rs" } },
					{ label: "missing dir", tool: "Glob", input: { pattern: "*", path: "{{cwd}}/missing" } },
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

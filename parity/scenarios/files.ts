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

export const fileScenarios: Scenario[] = [
	{
		name: "read-basic",
		description: "Read: offset/limit, long file, empty file, full file, unchanged re-read, missing file, directory, relative path, offset past EOF.",
		files: { "hello.txt": lines(5), "long.txt": lines(2500), "empty.txt": "", "dir/a.txt": "a\n" },
		prompt: "Read some files.",
		turns: [
			{
				calls: [
					{ label: "offset+limit", tool: "Read", input: { file_path: "{{cwd}}/hello.txt", offset: 2, limit: 2 } },
					{ label: "2500-line file", tool: "Read", input: { file_path: "{{cwd}}/long.txt" } },
					{ label: "empty file", tool: "Read", input: { file_path: "{{cwd}}/empty.txt" } },
				],
			},
			{ calls: [{ label: "full file", tool: "Read", input: { file_path: "{{cwd}}/hello.txt" } }] },
			{ calls: [{ label: "same file again (unchanged)", tool: "Read", input: { file_path: "{{cwd}}/hello.txt" } }] },
			{
				calls: [
					{ label: "missing file", tool: "Read", input: { file_path: "{{cwd}}/nope.txt" } },
					{ label: "directory", tool: "Read", input: { file_path: "{{cwd}}/dir" } },
					{ label: "relative path", tool: "Read", input: { file_path: "long.txt", limit: 3 } },
					{ label: "offset past EOF", tool: "Read", input: { file_path: "{{cwd}}/hello.txt", offset: 50 } },
				],
			},
			{ text: "done" },
		],
	},
	{
		name: "read-media",
		description: "Read: PNG image and Jupyter notebook.",
		files: { "pixel.png": PNG, "nb.ipynb": notebook },
		prompt: "Look at the image and notebook.",
		turns: [
			{
				calls: [
					{ label: "png", tool: "Read", input: { file_path: "{{cwd}}/pixel.png" } },
					{ label: "ipynb", tool: "Read", input: { file_path: "{{cwd}}/nb.ipynb" } },
				],
			},
			{ text: "done" },
		],
	},
	{
		name: "edit-guards",
		description: "Write/Edit safety: modify without reading, not found, ambiguous match, replace_all, no-op, stale after external change, create files.",
		files: { "a.txt": "hello world\nhello again\n" },
		prompt: "Edit a.txt.",
		turns: [
			{ calls: [{ label: "Edit before Read", tool: "Edit", input: { file_path: "{{cwd}}/a.txt", old_string: "world", new_string: "there" } }] },
			{ calls: [{ label: "Write existing before Read", tool: "Write", input: { file_path: "{{cwd}}/a.txt", content: "x" } }] },
			{ calls: [{ label: "Read", tool: "Read", input: { file_path: "{{cwd}}/a.txt" } }] },
			{ calls: [{ label: "old_string not found", tool: "Edit", input: { file_path: "{{cwd}}/a.txt", old_string: "nothing", new_string: "x" } }] },
			{ calls: [{ label: "ambiguous match", tool: "Edit", input: { file_path: "{{cwd}}/a.txt", old_string: "hello", new_string: "bye" } }] },
			{ calls: [{ label: "old == new", tool: "Edit", input: { file_path: "{{cwd}}/a.txt", old_string: "world", new_string: "world" } }] },
			{ calls: [{ label: "replace_all", tool: "Edit", input: { file_path: "{{cwd}}/a.txt", old_string: "hello", new_string: "bye", replace_all: true } }] },
			{ calls: [{ label: "external change", tool: "Bash", input: { command: "echo extra >> a.txt" } }] },
			{ calls: [{ label: "Edit stale file", tool: "Edit", input: { file_path: "{{cwd}}/a.txt", old_string: "world", new_string: "planet" } }] },
			{ calls: [{ label: "Read again", tool: "Read", input: { file_path: "{{cwd}}/a.txt" } }] },
			{ calls: [{ label: "Edit after re-read", tool: "Edit", input: { file_path: "{{cwd}}/a.txt", old_string: "world", new_string: "planet" } }] },
			{ calls: [{ label: "Write new file (nested dir)", tool: "Write", input: { file_path: "{{cwd}}/sub/dir/new.txt", content: "new\n" } }] },
			{ calls: [{ label: "Edit create (empty old_string)", tool: "Edit", input: { file_path: "{{cwd}}/created.txt", old_string: "", new_string: "created\n" } }] },
			{ calls: [{ label: "Write after own Write", tool: "Write", input: { file_path: "{{cwd}}/sub/dir/new.txt", content: "rewritten\n" } }] },
			{ text: "done" },
		],
	},
	{
		name: "edit-formats",
		description: "Edit preserves CRLF line endings and UTF-8 BOM; curly-quote tolerance.",
		files: { "crlf.txt": "one\r\ntwo\r\nthree\r\n", "bom.txt": "﻿alpha\nbeta\n", "quotes.txt": "She said “hello” and ‘bye’.\n" },
		prompt: "Edit the files.",
		turns: [
			{
				calls: [
					{ label: "Read crlf", tool: "Read", input: { file_path: "{{cwd}}/crlf.txt" } },
					{ label: "Read bom", tool: "Read", input: { file_path: "{{cwd}}/bom.txt" } },
					{ label: "Read quotes", tool: "Read", input: { file_path: "{{cwd}}/quotes.txt" } },
				],
			},
			{
				calls: [
					{ label: "Edit crlf (multi-line)", tool: "Edit", input: { file_path: "{{cwd}}/crlf.txt", old_string: "one\ntwo", new_string: "uno\ndos" } },
					{ label: "Edit bom", tool: "Edit", input: { file_path: "{{cwd}}/bom.txt", old_string: "beta", new_string: "gamma" } },
					{ label: "Edit with straight quotes", tool: "Edit", input: { file_path: "{{cwd}}/quotes.txt", old_string: 'said "hello"', new_string: 'said "hi"' } },
				],
			},
			{ text: "done" },
		],
	},
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
];

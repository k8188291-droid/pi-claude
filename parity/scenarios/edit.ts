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

export const editScenarios: Scenario[] = [
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
];

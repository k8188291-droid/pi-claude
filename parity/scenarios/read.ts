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

export const readScenarios: Scenario[] = [
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
];

import { utimesSync } from "node:fs";
import { join } from "node:path";
import type { Scenario } from "../types.js";

/** Fixed base mtime so ordering by modification time is reproducible. */
const BASE = 1_700_000_000;

/** Give each listed file a distinct mtime, oldest first. */
function stamp(cwd: string, files: string[], step = 100) {
	files.forEach((f, i) => utimesSync(join(cwd, f), BASE + i * step, BASE + i * step));
}

/**
 * A file whose Grep content output (`N:line` per match, joined by "\n") is exactly `total` characters.
 * Every line contains "needle".
 */
function grepOutputOfLength(total: number): string {
	const rows: string[] = [];
	let len = 0;
	for (let i = 1; ; i++) {
		const prefix = `${i}:`;
		const sep = i === 1 ? 0 : 1;
		const remaining = total - len - sep - prefix.length;
		if (remaining <= 60) {
			// last line takes the rest (at least "needle")
			rows.push("needle" + "x".repeat(Math.max(0, remaining - 6)));
			break;
		}
		const body = "needle " + "y".repeat(33);
		rows.push(body);
		len += sep + prefix.length + body.length;
	}
	return rows.join("\n") + "\n";
}

const many = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`many/f${String(i).padStart(3, "0")}.txt`, ""]));

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
			stamp(cwd, ["README.md", "lib/tool.py", "src/util.ts", "src/app.ts", "multi.txt"]);
		},
		prompt: "Search the code.",
		turns: [
			{
				calls: [
					{ label: "files_with_matches (default)", tool: "Grep", input: { pattern: "hello", path: "{{cwd}}" } },
					// Claude runs rg multi-threaded without --sort, so the order of files in content/count
					// output is not stable across runs; these steps keep matches in one file per directory search.
					{ label: "content -n", tool: "Grep", input: { pattern: "TODO:", path: "{{cwd}}", output_mode: "content", "-n": true } },
					{ label: "content context=1", tool: "Grep", input: { pattern: "return", path: "{{cwd}}", output_mode: "content", context: 1 } },
					{ label: "count", tool: "Grep", input: { pattern: "o", path: "{{cwd}}/src", glob: "app.ts", output_mode: "count" } },
				],
			},
			{
				calls: [
					{ label: "-i", tool: "Grep", input: { pattern: "todo LOWER", path: "{{cwd}}", "-i": true, output_mode: "content" } },
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
					{ label: "-o", tool: "Grep", input: { pattern: "H[a-z]+", path: "{{cwd}}/src", glob: "app.ts", output_mode: "content", "-o": true } },
				],
			},
			{ text: "done" },
		],
	},
	{
		name: "grep-edge",
		description: "Grep: hidden/.git/gitignored files, context breaks, -n false, long lines, binary, pagination edges, errors, count.",
		files: {
			"a.txt": "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\n",
			"long.txt": "x".repeat(600) + " needle\nshort needle\n",
			"bin.dat": Buffer.from("needle one\n\0binary tail needle\n"),
			"dash.txt": "-v flag\nplain\n",
			"words.txt": "foo bar foo\nbaz foo\n",
			".hidden/h.txt": "needle hidden\n",
			".git/config": "needle git\n",
			".gitignore": "ignored/\n",
			"ignored/i.txt": "needle ignored\n",
			"sub/s.txt": "needle sub\n",
		},
		setup(cwd) {
			stamp(cwd, ["a.txt", "long.txt", "bin.dat", "dash.txt", "words.txt", ".hidden/h.txt", ".git/config", ".gitignore", "ignored/i.txt", "sub/s.txt"]);
		},
		prompt: "Search edge cases.",
		turns: [
			{
				calls: [
					{ label: "files: hidden/.git/ignored", tool: "Grep", input: { pattern: "needle" } },
					{ label: "context=1 -n false (single file)", tool: "Grep", input: { pattern: "gamma|^eta", path: "{{cwd}}/a.txt", output_mode: "content", context: 1, "-n": false } },
					{ label: "-A 1 dir mode", tool: "Grep", input: { pattern: "beta|zeta", path: "{{cwd}}", glob: "a.txt", output_mode: "content", "-A": 1 } },
					{ label: "-B 1 -n false dir mode", tool: "Grep", input: { pattern: "delta", path: "{{cwd}}", glob: "a.txt", output_mode: "content", "-B": 1, "-n": false } },
					{ label: "-C 2 (single file)", tool: "Grep", input: { pattern: "epsilon", path: "{{cwd}}/a.txt", output_mode: "content", "-C": 2 } },
				],
			},
			{
				calls: [
					{ label: "long line", tool: "Grep", input: { pattern: "needle", path: "{{cwd}}/long.txt", output_mode: "content" } },
					{ label: "binary (dir mode)", tool: "Grep", input: { pattern: "needle", path: "{{cwd}}", glob: "bin.dat", output_mode: "content" } },
					{ label: "binary files mode", tool: "Grep", input: { pattern: "tail", path: "{{cwd}}", glob: "*.dat" } },
					{ label: "pattern starting with -", tool: "Grep", input: { pattern: "-v", path: "{{cwd}}/dash.txt", output_mode: "content" } },
					{ label: "-o multiple per line", tool: "Grep", input: { pattern: "foo", path: "{{cwd}}/words.txt", output_mode: "content", "-o": true } },
				],
			},
			{
				calls: [
					{ label: "content head_limit 2", tool: "Grep", input: { pattern: "a", path: "{{cwd}}/a.txt", output_mode: "content", head_limit: 2 } },
					{ label: "content offset 2 head_limit 2", tool: "Grep", input: { pattern: "a", path: "{{cwd}}/a.txt", output_mode: "content", head_limit: 2, offset: 2 } },
					{ label: "content offset beyond", tool: "Grep", input: { pattern: "a", path: "{{cwd}}/a.txt", output_mode: "content", offset: 100 } },
					{ label: "files offset beyond", tool: "Grep", input: { pattern: "needle", offset: 50 } },
					{ label: "content no match", tool: "Grep", input: { pattern: "zzz", path: "{{cwd}}", output_mode: "content" } },
				],
			},
			{
				calls: [
					{ label: "count single file", tool: "Grep", input: { pattern: "e", path: "{{cwd}}/a.txt", output_mode: "count" } },
					{ label: "count dir (one file)", tool: "Grep", input: { pattern: "foo", path: "{{cwd}}", glob: "words.txt", output_mode: "count" } },
					{ label: "count no match", tool: "Grep", input: { pattern: "zzz", output_mode: "count" } },
					{ label: "count offset 1", tool: "Grep", input: { pattern: "e", path: "{{cwd}}/a.txt", output_mode: "count", offset: 1 } },
					{ label: "relative path", tool: "Grep", input: { pattern: "needle", path: "sub" } },
				],
			},
			{
				calls: [
					{ label: "missing path", tool: "Grep", input: { pattern: "x", path: "{{cwd}}/nope" } },
					{ label: "head_limit -1", tool: "Grep", input: { pattern: "x", head_limit: -1 } },
					{ label: "offset 1.5", tool: "Grep", input: { pattern: "x", offset: 1.5 } },
					{ label: "unknown type", tool: "Grep", input: { pattern: "x", type: "zzzz" } },
					{ label: "invalid regex", tool: "Grep", input: { pattern: "(", path: "{{cwd}}/a.txt" } },
				],
			},
			{
				calls: [
					{ label: "files head_limit 2", tool: "Grep", input: { pattern: "needle", head_limit: 2 } },
					{ label: "files head_limit 0", tool: "Grep", input: { pattern: "needle", head_limit: 0 } },
					{ label: "file path files mode", tool: "Grep", input: { pattern: "needle", path: "{{cwd}}/sub/s.txt" } },
					{ label: "explicit .git path", tool: "Grep", input: { pattern: "needle", path: "{{cwd}}/.git" } },
					{ label: "multiline context", tool: "Grep", input: { pattern: "beta\\ngamma", path: "{{cwd}}/a.txt", output_mode: "content", multiline: true, context: 1 } },
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
			stamp(cwd, ["node_modules/pkg/index.ts", "src/deep/d.ts", "a.ts", "src/c.ts", "b.ts", "notes.md"]);
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
		name: "glob-edge",
		description: "Glob: hidden/.git/gitignored files, anchored and absolute patterns, repeated dir prefix, braces, truncation, errors.",
		files: {
			...many,
			"top.ts": "",
			"src/x.ts": "",
			"src/sub/y.ts": "",
			"src/sub/z.js": "",
			".hidden/h.ts": "",
			".git/config": "",
			".gitignore": "ignored/\n",
			"ignored/i.ts": "",
			"other/src/w.ts": "",
		},
		setup(cwd) {
			stamp(cwd, Object.keys(many), 1);
			stamp(cwd, ["src/sub/y.ts", "top.ts", ".hidden/h.ts", "src/x.ts", "ignored/i.ts", ".git/config", ".gitignore", "src/sub/z.js", "other/src/w.ts"], 1000);
		},
		prompt: "Find files (edge cases).",
		turns: [
			{
				calls: [
					{ label: "**/*.ts (hidden, ignored)", tool: "Glob", input: { pattern: "**/*.ts" } },
					{ label: "**/config (.git)", tool: "Glob", input: { pattern: "**/config" } },
					{ label: ".git* at root", tool: "Glob", input: { pattern: ".git*" } },
					{ label: "src/*.ts anchored", tool: "Glob", input: { pattern: "src/*.ts" } },
					{ label: "src/**/*.ts", tool: "Glob", input: { pattern: "src/**/*.ts" } },
				],
			},
			{
				calls: [
					{ label: "repeated dir prefix", tool: "Glob", input: { pattern: "src/**/*.ts", path: "{{cwd}}/src" } },
					{ label: "absolute pattern", tool: "Glob", input: { pattern: "{{cwd}}/src/sub/*" } },
					{ label: "relative path", tool: "Glob", input: { pattern: "*.ts", path: "src/sub" } },
					{ label: "braces", tool: "Glob", input: { pattern: "src/**/*.{ts,js}" } },
					{ label: "truncated (120 files)", tool: "Glob", input: { pattern: "many/*.txt" } },
				],
			},
			{
				calls: [
					{ label: "path is a file", tool: "Glob", input: { pattern: "*", path: "{{cwd}}/top.ts" } },
					{ label: "relative missing dir", tool: "Glob", input: { pattern: "*", path: "nope" } },
					{ label: "path=.", tool: "Glob", input: { pattern: "*.ts", path: "." } },
					{ label: "dir only name", tool: "Glob", input: { pattern: "src" } },
					{ label: "path with ..", tool: "Glob", input: { pattern: "*.ts", path: "{{cwd}}/src/../other/src" } },
				],
			},
			{ text: "done" },
		],
	},
	{
		name: "large-output",
		description: "Very large tool output: how each harness truncates or persists it.",
		files: {
			"big.txt": Array.from({ length: 20000 }, (_, i) => `row ${i} needle`).join("\n") + "\n",
			"g20000.txt": grepOutputOfLength(20000),
			"g20001.txt": grepOutputOfLength(20001),
			"b30000.txt": "b".repeat(30000),
			"b30001.txt": "b".repeat(30001),
		},
		prompt: "Produce big output.",
		turns: [
			{ calls: [{ label: "seq 1 40000", tool: "Bash", input: { command: "seq 1 40000" } }] },
			{ calls: [{ label: "Grep 20000 lines", tool: "Grep", input: { pattern: "needle", path: "{{cwd}}/big.txt", output_mode: "content", head_limit: 0 } }] },
			{ calls: [{ label: "Grep output = 20000 chars", tool: "Grep", input: { pattern: "needle", path: "{{cwd}}/g20000.txt", output_mode: "content", head_limit: 0 } }] },
			{ calls: [{ label: "Grep output = 20001 chars", tool: "Grep", input: { pattern: "needle", path: "{{cwd}}/g20001.txt", output_mode: "content", head_limit: 0 } }] },
			{ calls: [{ label: "Bash output = 30000 chars", tool: "Bash", input: { command: "cat b30000.txt" } }] },
			{ calls: [{ label: "Bash output = 30001 chars", tool: "Bash", input: { command: "cat b30001.txt" } }] },
			{ text: "done" },
		],
	},
];

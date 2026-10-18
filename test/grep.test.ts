import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createCCContext } from "../src/shared/context.js";
import { buildRgArgs, executeGrep, formatGrep, parseRgJson, registerGrep, splitGlobs, splitNullOutput } from "../src/tools/grep.js";
import { captureTools, createTestSession, fakeCtx, fauxAssistantMessage, fauxToolCall, resultText, tempDir } from "./helpers.js";

const { tools } = captureTools((pi) => {
	const cc = createCCContext({});
	registerGrep(pi, cc);
});
const grep = tools.get("Grep")!;

let dir: string;

function write(rel: string, content: string, mtimeSec?: number) {
	const p = join(dir, rel);
	mkdirSync(join(p, ".."), { recursive: true });
	writeFileSync(p, content);
	if (mtimeSec !== undefined) utimesSync(p, mtimeSec, mtimeSec);
}

async function run(params: Record<string, unknown>, cwd = dir, signal?: AbortSignal) {
	const r = await grep.execute("id", params as any, signal, undefined, fakeCtx(cwd));
	return { text: resultText(r as any), details: (r as any).details };
}

beforeAll(() => {
	dir = tempDir("pi-cc-grep-");
	const base = 1_700_000_000;
	write("old.ts", "const needle = 1;\nexport {};\n", base);
	write("mid.ts", "// Needle here\nfunction foo() {\n  return needle;\n}\n", base + 100);
	write("new.js", "let needle = 'x';\n", base + 200);
	write("src/deep/a.py", "line1\nline2\nneedle in python\nline4\nline5\nline6\n", base + 50);
	write("multi.txt", "start of block\nmiddle\nend of block\n", base + 10);
	write("dash.txt", "foo -v bar\n--flag value\n", base + 5);
	write(".hidden/secret.ts", "needle hidden\n", base + 1);
	write(".gitignore", "ignored/\n", base);
	write("ignored/skip.ts", "needle ignored\n", base + 300);
	mkdirSync(join(dir, ".git"), { recursive: true });
	write(".git/config", "needle in git\n", base + 400);
	// many-lines file for paging
	write("many/lines.txt", Array.from({ length: 30 }, (_, i) => `hit ${i}`).join("\n") + "\n", base);
	for (let i = 0; i < 12; i++) write(`many/f${String(i).padStart(2, "0")}.md`, "hit\n", base + 1000 + i);
});

describe("Grep schema", () => {
	it("matches Claude Code parameter names", () => {
		const props = Object.keys((grep.parameters as any).properties).sort();
		expect(props).toEqual(
			["-A", "-B", "-C", "-i", "-n", "-o", "context", "glob", "head_limit", "multiline", "offset", "output_mode", "path", "pattern", "type"].sort(),
		);
		expect((grep.parameters as any).required).toEqual(["pattern"]);
		expect((grep.parameters as any).properties.output_mode.enum).toEqual(["content", "files_with_matches", "count"]);
	});
});

describe("Grep files_with_matches", () => {
	it("defaults to files_with_matches, sorted newest first, relative paths, respects .gitignore, skips .git, includes hidden", async () => {
		const { text, details } = await run({ pattern: "needle" });
		const lines = text.split("\n");
		expect(lines[0]).toBe("Found 5 files");
		expect(lines.slice(1)).toEqual(["new.js", "mid.ts", "src/deep/a.py", ".hidden/secret.ts", "old.ts"]);
		expect(text).not.toContain("ignored/skip.ts");
		expect(text).not.toContain(".git/config");
		expect(details).toMatchObject({ mode: "files_with_matches", numFiles: 5 });
	});

	it("is case sensitive by default and supports -i", async () => {
		const cs = await run({ pattern: "Needle" });
		expect(cs.text).toBe("Found 1 file\nmid.ts");
		const ci = await run({ pattern: "NEEDLE", "-i": true });
		expect(ci.text.split("\n")[0]).toBe("Found 5 files");
	});

	it("returns 'No files found' on no match (exit code 1 is not an error)", async () => {
		const r = await run({ pattern: "zzz_no_such_thing_zzz" });
		expect(r.text).toBe("No files found");
	});

	it("filters by type", async () => {
		const r = await run({ pattern: "needle", type: "py" });
		expect(r.text).toBe("Found 1 file\nsrc/deep/a.py");
		const ts = await run({ pattern: "needle", type: "ts" });
		expect(ts.text.split("\n").slice(1).sort()).toEqual([".hidden/secret.ts", "mid.ts", "old.ts"]);
	});

	it("filters by glob, including brace and comma lists", async () => {
		expect((await run({ pattern: "needle", glob: "*.js" })).text).toBe("Found 1 file\nnew.js");
		const brace = await run({ pattern: "needle", glob: "*.{js,py}" });
		expect(brace.text.split("\n").slice(1)).toEqual(["new.js", "src/deep/a.py"]);
		const comma = await run({ pattern: "needle", glob: "*.js,*.py" });
		expect(comma.text.split("\n").slice(1)).toEqual(["new.js", "src/deep/a.py"]);
	});

	it("searches a subdirectory path and outputs paths relative to cwd", async () => {
		const r = await run({ pattern: "needle", path: "src" });
		expect(r.text).toBe("Found 1 file\nsrc/deep/a.py");
		const abs = await run({ pattern: "needle", path: join(dir, "src") });
		expect(abs.text).toBe("Found 1 file\nsrc/deep/a.py");
	});

	it("outputs absolute paths when searching outside cwd", async () => {
		const r = await run({ pattern: "needle", path: dir }, join(dir, "src"));
		expect(r.text.split("\n")).toContain(join(dir, "new.js"));
	});

	it("supports a single file path", async () => {
		const r = await run({ pattern: "needle", path: "old.ts" });
		expect(r.text).toBe("Found 1 file\nold.ts");
	});

	it("errors on a nonexistent path with Claude Code's wording", async () => {
		await expect(run({ pattern: "needle", path: "nope" })).rejects.toThrow(
			`Path does not exist: nope. Note: your current working directory is ${dir}.`,
		);
	});

	it("errors on invalid regex", async () => {
		await expect(run({ pattern: "foo(" })).rejects.toThrow(
			/^Search failed — ripgrep rejected the pattern, glob, or file type without searching:\nrg: regex parse error/,
		);
	});

	it("errors on unknown type", async () => {
		await expect(run({ pattern: "needle", type: "notatype_xyz" })).rejects.toThrow("rg: unrecognized file type: notatype_xyz");
	});

	it("validates head_limit and offset", async () => {
		await expect(run({ pattern: "x", head_limit: -1 })).rejects.toThrow("head_limit must be a whole number of 0 or more, got -1. Pass 0 for unlimited.");
		await expect(run({ pattern: "x", offset: 1.5 })).rejects.toThrow("offset must be a whole number of 0 or more, got 1.5.");
	});

	it("pages with head_limit and offset", async () => {
		const first = await run({ pattern: "^hit$", path: "many", head_limit: 5 });
		const lines = first.text.split("\n");
		expect(lines[0]).toBe("Found 5 files limit: 5");
		expect(lines.slice(1)).toEqual(["many/f11.md", "many/f10.md", "many/f09.md", "many/f08.md", "many/f07.md"]);
		expect(first.details).toMatchObject({ appliedLimit: 5, numFiles: 5, totalFiles: 12 });

		const second = await run({ pattern: "^hit$", path: "many", head_limit: 5, offset: 10 });
		expect(second.text).toBe("Found 2 files offset: 10\nmany/f01.md\nmany/f00.md");
		expect(second.details.appliedLimit).toBeUndefined();

		const mid = await run({ pattern: "^hit$", path: "many", head_limit: 1, offset: 1 });
		expect(mid.text).toBe("Found 1 file limit: 1, offset: 1\nmany/f10.md");

		const unlimited = await run({ pattern: "^hit$", path: "many", head_limit: 0 });
		expect(unlimited.text.split("\n")[0]).toBe("Found 12 files");

		const past = await run({ pattern: "^hit$", path: "many", offset: 50 });
		expect(past.text).toBe("No entries at this offset. [Showing results with pagination = offset: 50]");
	});
});

describe("Grep content mode", () => {
	it("prints line:content for a single file (no filename prefix)", async () => {
		const r = await run({ pattern: "needle", output_mode: "content", path: "mid.ts" });
		expect(r.text).toBe("3:  return needle;");
	});

	it("prints path:line:content when searching a directory", async () => {
		const r = await run({ pattern: "needle", output_mode: "content", glob: "mid.ts" });
		expect(r.text).toBe("mid.ts:3:  return needle;");
	});

	it("omits line numbers when -n is false", async () => {
		const r = await run({ pattern: "needle", output_mode: "content", path: "mid.ts", "-n": false });
		expect(r.text).toBe("  return needle;");
		const d = await run({ pattern: "needle", output_mode: "content", glob: "mid.ts", "-n": false });
		expect(d.text).toBe("mid.ts:  return needle;");
	});

	it("separates non-adjacent context groups with --", async () => {
		const r = await run({ pattern: "line1|line6", output_mode: "content", path: "src/deep/a.py", context: 1 });
		expect(r.text).toBe("1:line1\n2-line2\n--\n5-line5\n6:line6");
	});

	it("replaces lines longer than 500 characters", async () => {
		write("long/l.txt", "x".repeat(600) + " needle\n");
		const r = await run({ pattern: "needle", output_mode: "content", path: "long/l.txt" });
		expect(r.text).toBe("1:[Omitted long matching line]");
	});

	it("supports -A, -B, -C and context", async () => {
		const a = await run({ pattern: "needle", output_mode: "content", path: "src", "-A": 1 });
		expect(a.text).toBe("src/deep/a.py:3:needle in python\nsrc/deep/a.py-4-line4");
		const b = await run({ pattern: "needle", output_mode: "content", path: "src", "-B": 2 });
		expect(b.text).toBe("src/deep/a.py-1-line1\nsrc/deep/a.py-2-line2\nsrc/deep/a.py:3:needle in python");
		const c = await run({ pattern: "needle", output_mode: "content", path: "src", "-C": 1 });
		expect(c.text).toBe("src/deep/a.py-2-line2\nsrc/deep/a.py:3:needle in python\nsrc/deep/a.py-4-line4");
		const ctx = await run({ pattern: "needle", output_mode: "content", path: "src", context: 1 });
		expect(ctx.text).toBe(c.text);
	});

	it("ignores context flags outside content mode", async () => {
		const r = await run({ pattern: "needle", path: "src", "-C": 3 });
		expect(r.text).toBe("Found 1 file\nsrc/deep/a.py");
	});

	it("supports -o only-matching", async () => {
		const r = await run({ pattern: "ne+dle", output_mode: "content", glob: "old.ts", "-o": true });
		expect(r.text).toBe("old.ts:1:needle");
	});

	it("supports multiline", async () => {
		const plain = await run({ pattern: "start.*end", output_mode: "content", path: "multi.txt" });
		expect(plain.text).toBe("No matches found");
		const multi = await run({ pattern: "start.*end", output_mode: "content", path: "multi.txt", multiline: true });
		expect(multi.text).toBe("1:start of block\n2:middle\n3:end of block");
	});

	it("handles patterns starting with '-'", async () => {
		const r = await run({ pattern: "-v", output_mode: "content", path: "dash.txt" });
		expect(r.text).toBe("1:foo -v bar");
		const r2 = await run({ pattern: "--flag", output_mode: "content" });
		expect(r2.text).toBe("dash.txt:2:--flag value");
	});

	it("returns 'No matches found' on no match", async () => {
		const r = await run({ pattern: "zzz_none", output_mode: "content" });
		expect(r.text).toBe("No matches found");
	});

	it("pages lines with head_limit/offset and appends a paging note", async () => {
		const r = await run({ pattern: "hit \\d+", output_mode: "content", path: "many/lines.txt", head_limit: 3 });
		expect(r.text).toBe("1:hit 0\n2:hit 1\n3:hit 2\n\n[Showing results with pagination = limit: 3]");

		const r2 = await run({ pattern: "hit \\d+", output_mode: "content", path: "many/lines.txt", head_limit: 3, offset: 3 });
		expect(r2.text).toBe("4:hit 3\n5:hit 4\n6:hit 5\n\n[Showing results with pagination = limit: 3, offset: 3]");

		const tail = await run({ pattern: "hit \\d+", output_mode: "content", path: "many/lines.txt", offset: 28 });
		expect(tail.text).toBe("29:hit 28\n30:hit 29\n\n[Showing results with pagination = offset: 28]");

		const past = await run({ pattern: "hit \\d+", output_mode: "content", path: "many/lines.txt", offset: 100 });
		expect(past.text).toBe("No entries at this offset\n\n[Showing results with pagination = offset: 100]");
	});

	it("applies the default head_limit of 250", async () => {
		const big = join(dir, "big");
		mkdirSync(big, { recursive: true });
		writeFileSync(join(big, "big.txt"), Array.from({ length: 300 }, (_, i) => `row ${i}`).join("\n"));
		const r = await run({ pattern: "row", output_mode: "content", path: "big" });
		const [body, note] = r.text.split("\n\n");
		expect(body.split("\n")).toHaveLength(250);
		expect(note).toBe("[Showing results with pagination = limit: 250]");
		expect(r.details).toMatchObject({ numLines: 250, totalLines: 300, appliedLimit: 250 });
	});
});

describe("Grep count mode", () => {
	it("prints path:count with a total summary", async () => {
		const r = await run({ pattern: "needle", output_mode: "count", "-i": true, type: "ts" });
		const [body, summary] = r.text.split("\n\n");
		expect(body.split("\n")).toEqual([".hidden/secret.ts:1", "mid.ts:2", "old.ts:1"]);
		expect(summary).toBe("Found 4 total occurrences across 3 files.");
		expect(r.details).toMatchObject({ mode: "count", numFiles: 3, numMatches: 4 });
	});

	it("pages count entries; total still reflects all files", async () => {
		const r = await run({ pattern: "^hit$", output_mode: "count", path: "many", head_limit: 2 });
		const [body, summary] = r.text.split("\n\n");
		expect(body.split("\n")).toHaveLength(2);
		expect(summary).toBe("Found 12 total occurrences across 12 files. with pagination = limit: 2");
	});

	it("single file count has a path prefix", async () => {
		const r = await run({ pattern: "line", output_mode: "count", path: "src/deep/a.py" });
		expect(r.text).toBe("src/deep/a.py:5\n\nFound 5 total occurrences across 1 file.");
	});

	it("no matches", async () => {
		expect((await run({ pattern: "zzz_none", output_mode: "count" })).text).toBe("No matches found\n\nFound 0 total occurrences across 0 files.");
		expect((await run({ pattern: "line", output_mode: "count", path: "src/deep/a.py", offset: 1 })).text).toBe(
			"No entries at this offset\n\nFound 5 total occurrences across 1 file. with pagination = offset: 1",
		);
	});
});

describe("Grep abort and helpers", () => {
	it("rejects when already aborted", async () => {
		const ac = new AbortController();
		ac.abort();
		await expect(run({ pattern: "needle" }, dir, ac.signal)).rejects.toThrow(/aborted/);
	});

	it("rejects when aborted mid-run", async () => {
		const ac = new AbortController();
		const p = run({ pattern: "needle", path: "/usr" }, dir, ac.signal);
		ac.abort();
		await expect(p).rejects.toThrow(/aborted/);
	});

	it("splitGlobs splits on whitespace and commas but keeps braces", () => {
		expect(splitGlobs("*.ts *.js")).toEqual(["*.ts", "*.js"]);
		expect(splitGlobs("*.ts,*.js")).toEqual(["*.ts", "*.js"]);
		expect(splitGlobs("*.{ts,tsx} !dist/**")).toEqual(["*.{ts,tsx}", "!dist/**"]);
	});

	it("buildRgArgs mirrors Claude Code's argument list", () => {
		expect(buildRgArgs({ pattern: "-x" }, ".")).toEqual([
			"--hidden",
			...[".git", ".svn", ".hg", ".bzr", ".jj", ".sl"].flatMap((d) => ["--glob", `!${d}`]),
			"--max-columns",
			"500",
			"-l",
			"--null",
			"-e",
			"-x",
			".",
		]);
		const content = buildRgArgs({ pattern: "a", output_mode: "content", "-i": true, "-o": true, context: 2, "-A": 5, type: "ts", glob: "*.ts" }, "f");
		expect(content.slice(15)).toEqual(["-i", "--json", "-n", "-o", "-C", "2", "a", "--type", "ts", "--glob", "*.ts", "f"]);
		expect(buildRgArgs({ pattern: "a", output_mode: "count", multiline: true }, ".").slice(15)).toEqual(["-U", "--multiline-dotall", "-c", "-H", "--null", "a", "."]);
	});

	it("splitNullOutput parses --null output", () => {
		expect(splitNullOutput(["./a\0./b\0"], "files_with_matches")).toEqual(["./a", "./b"]);
		expect(splitNullOutput(["./a\x002", "./b\x0010"], "count")).toEqual(["./a:2", "./b:10"]);
	});

	it("parseRgJson sorts files by path and reports binary matches", () => {
		const ev = (o: unknown) => JSON.stringify(o);
		const lines = [
			ev({ type: "begin", data: { path: { text: "./b" } } }),
			ev({ type: "match", data: { path: { text: "./b" }, lines: { text: "x\n" }, line_number: 1, submatches: [] } }),
			ev({ type: "end", data: { path: { text: "./b" }, binary_offset: 7 } }),
			ev({ type: "begin", data: { path: { text: "./a" } } }),
			ev({ type: "match", data: { path: { text: "./a" }, lines: { text: "y\n" }, line_number: 3, submatches: [] } }),
			ev({ type: "end", data: { path: { text: "./a" }, binary_offset: null } }),
			ev({ type: "summary", data: {} }),
		];
		expect(parseRgJson(lines, { contextBreaks: false, onlyMatching: false })).toEqual([
			"./a\x003:y",
			"./b\x001:x",
			'./b\x00binary file matches (found "\\0" byte around offset 7)',
		]);
	});

	it("formatGrep matches Claude Code's texts", () => {
		expect(formatGrep({ mode: "files_with_matches", numFiles: 0, filenames: [], totalFiles: 0 })).toBe("No files found");
		expect(formatGrep({ mode: "content", numFiles: 0, filenames: [], content: "", totalLines: 0 })).toBe("No matches found");
	});
});

describe("Grep end-to-end", () => {
	it("runs via a faux session", async () => {
		const cwd = tempDir("pi-cc-grep-e2e-");
		writeFileSync(join(cwd, "a.txt"), "hello world\n");
		const t = await createTestSession({
			cwd,
			responses: [
				fauxAssistantMessage(fauxToolCall("Grep", { pattern: "hello", output_mode: "content" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			],
		});
		try {
			await t.session.prompt("go");
			const res = t.toolResults().find((r) => r.toolName === "Grep");
			expect(res).toMatchObject({ isError: false, text: "a.txt:1:hello world" });
		} finally {
			t.dispose();
		}
	});
});

describe("Grep count ordering", () => {
	it("sorts count output by path so results and paging are deterministic", async () => {
		const dir = tempDir();
		for (const n of ["zeta", "alpha", "mid", "beta", "omega"]) writeFileSync(join(dir, `${n}.txt`), "x\nx\n");
		const r = await executeGrep({ pattern: "x", output_mode: "count" } as any, dir);
		const files = r.text.split("\n").filter((l) => l.includes(".txt:")).map((l) => l.split(":")[0]);
		expect(files).toEqual(["alpha.txt", "beta.txt", "mid.txt", "omega.txt", "zeta.txt"]);
	});
});

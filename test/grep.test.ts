import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createCCContext } from "../src/shared/context.js";
import { buildRgArgs, registerGrep, splitGlobs } from "../src/tools/grep.js";
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

	it("errors on a nonexistent path", async () => {
		await expect(run({ pattern: "needle", path: "nope" })).rejects.toThrow(/does not exist/);
	});

	it("errors on invalid regex", async () => {
		await expect(run({ pattern: "foo(" })).rejects.toThrow(/ripgrep error/);
	});

	it("errors on unknown type", async () => {
		await expect(run({ pattern: "needle", type: "notatype_xyz" })).rejects.toThrow(/notatype_xyz/);
	});

	it("pages with head_limit and offset", async () => {
		const first = await run({ pattern: "^hit$", path: "many", head_limit: 5 });
		const lines = first.text.split("\n");
		expect(lines[0]).toContain("Found 5 files (12 total)");
		expect(lines[0]).toContain("limit: 5, offset: 0");
		expect(lines[0]).toContain("Use offset: 5");
		expect(lines.slice(1)).toEqual(["many/f11.md", "many/f10.md", "many/f09.md", "many/f08.md", "many/f07.md"]);
		expect(first.details).toMatchObject({ appliedLimit: 5, appliedOffset: 0, numFiles: 12 });

		const second = await run({ pattern: "^hit$", path: "many", head_limit: 5, offset: 10 });
		expect(second.text).toBe("Found 2 files\nmany/f01.md\nmany/f00.md");
		expect(second.details.appliedLimit).toBeUndefined();

		const unlimited = await run({ pattern: "^hit$", path: "many", head_limit: 0 });
		expect(unlimited.text.split("\n")[0]).toBe("Found 12 files");

		const past = await run({ pattern: "^hit$", path: "many", offset: 50 });
		expect(past.text).toMatch(/No files found at offset 50/);
	});
});

describe("Grep content mode", () => {
	it("prints path:line:content with line numbers by default", async () => {
		const r = await run({ pattern: "needle", output_mode: "content", path: "mid.ts" });
		expect(r.text).toBe("mid.ts:3:  return needle;");
	});

	it("omits line numbers when -n is false", async () => {
		const r = await run({ pattern: "needle", output_mode: "content", path: "mid.ts", "-n": false });
		expect(r.text).toBe("mid.ts:  return needle;");
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
		const r = await run({ pattern: "ne+dle", output_mode: "content", path: "old.ts", "-o": true });
		expect(r.text).toBe("old.ts:1:needle");
	});

	it("supports multiline", async () => {
		const plain = await run({ pattern: "start.*end", output_mode: "content", path: "multi.txt" });
		expect(plain.text).toBe("No matches found");
		const multi = await run({ pattern: "start.*end", output_mode: "content", path: "multi.txt", multiline: true });
		expect(multi.text).toBe("multi.txt:1:start of block\nmulti.txt:2:middle\nmulti.txt:3:end of block");
	});

	it("handles patterns starting with '-'", async () => {
		const r = await run({ pattern: "-v", output_mode: "content", path: "dash.txt" });
		expect(r.text).toBe("dash.txt:1:foo -v bar");
		const r2 = await run({ pattern: "--flag", output_mode: "content" });
		expect(r2.text).toBe("dash.txt:2:--flag value");
	});

	it("returns 'No matches found' on no match", async () => {
		const r = await run({ pattern: "zzz_none", output_mode: "content" });
		expect(r.text).toBe("No matches found");
	});

	it("pages lines with head_limit/offset and appends a paging note", async () => {
		const r = await run({ pattern: "hit \\d+", output_mode: "content", path: "many/lines.txt", head_limit: 3 });
		const [body, note] = r.text.split("\n\n");
		expect(body.split("\n")).toEqual(["many/lines.txt:1:hit 0", "many/lines.txt:2:hit 1", "many/lines.txt:3:hit 2"]);
		expect(note).toBe("[Showing results with pagination = limit: 3, offset: 0. Use offset: 3 to see more]");

		const r2 = await run({ pattern: "hit \\d+", output_mode: "content", path: "many/lines.txt", head_limit: 3, offset: 3 });
		expect(r2.text.split("\n\n")[0].split("\n")[0]).toBe("many/lines.txt:4:hit 3");
		expect(r2.text).toContain("Use offset: 6");

		const tail = await run({ pattern: "hit \\d+", output_mode: "content", path: "many/lines.txt", offset: 28 });
		expect(tail.text).toBe("many/lines.txt:29:hit 28\nmany/lines.txt:30:hit 29");
	});

	it("applies the default head_limit of 250", async () => {
		const big = join(dir, "big");
		mkdirSync(big, { recursive: true });
		writeFileSync(join(big, "big.txt"), Array.from({ length: 300 }, (_, i) => `row ${i}`).join("\n"));
		const r = await run({ pattern: "row", output_mode: "content", path: "big" });
		const [body, note] = r.text.split("\n\n");
		expect(body.split("\n")).toHaveLength(250);
		expect(note).toContain("limit: 250, offset: 0");
		expect(r.details).toMatchObject({ numLines: 300, appliedLimit: 250 });
	});
});

describe("Grep count mode", () => {
	it("prints path:count with a total summary", async () => {
		const r = await run({ pattern: "needle", output_mode: "count", "-i": true, type: "ts" });
		const [body, summary] = r.text.split("\n\n");
		expect(body.split("\n").sort()).toEqual([".hidden/secret.ts:1", "mid.ts:2", "old.ts:1"]);
		expect(summary).toBe("Found 4 total occurrences across 3 files.");
		expect(r.details).toMatchObject({ mode: "count", numFiles: 3, numMatches: 4 });
	});

	it("pages count entries; total still reflects all files", async () => {
		const r = await run({ pattern: "^hit$", output_mode: "count", path: "many", head_limit: 2 });
		const [body, summary] = r.text.split("\n\n");
		expect(body.split("\n")).toHaveLength(2);
		expect(summary).toContain("Found 12 total occurrences across 12 files.");
		expect(summary).toContain("limit: 2, offset: 0. Use offset: 2");
	});

	it("single file count has a path prefix", async () => {
		const r = await run({ pattern: "line", output_mode: "count", path: "src/deep/a.py" });
		expect(r.text).toBe("src/deep/a.py:5\n\nFound 5 total occurrences across 1 file.");
	});

	it("no matches", async () => {
		expect((await run({ pattern: "zzz_none", output_mode: "count" })).text).toBe("No matches found");
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

	it("buildRgArgs puts the pattern behind --regexp and ends options before the path", () => {
		const args = buildRgArgs({ pattern: "-x" }, ".");
		expect(args.slice(-4)).toEqual(["--regexp", "-x", "--", "."]);
		expect(args).toContain("--files-with-matches");
		expect(args).toContain("!.git");
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

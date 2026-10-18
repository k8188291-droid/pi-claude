import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createCCContext } from "../src/shared/context.js";
import { globTruncationNote, registerGlob, splitAbsolutePattern, stripRepeatedDirPrefix } from "../src/tools/glob.js";
import { captureTools, createTestSession, fakeCtx, fauxAssistantMessage, fauxToolCall, resultText, tempDir } from "./helpers.js";

const { tools } = captureTools((pi) => {
	const cc = createCCContext({});
	registerGlob(pi, cc);
});
const globTool = tools.get("Glob")!;

let dir: string;
const base = 1_700_000_000;

function write(rel: string, mtimeSec?: number, content = "x") {
	const p = join(dir, rel);
	mkdirSync(join(p, ".."), { recursive: true });
	writeFileSync(p, content);
	if (mtimeSec !== undefined) utimesSync(p, mtimeSec, mtimeSec);
}

async function run(params: Record<string, unknown>, cwd = dir, signal?: AbortSignal) {
	const r = await globTool.execute("id", params as any, signal, undefined, fakeCtx(cwd));
	return { text: resultText(r as any), details: (r as any).details };
}

beforeAll(() => {
	dir = tempDir("pi-cc-glob-");
	write("a.ts", base + 10);
	write("b.ts", base + 30);
	write("src/c.ts", base + 20);
	write("src/deep/d.ts", base + 40);
	write("src/e.js", base + 50);
	write(".config/f.ts", base + 5);
	write("node_modules/pkg/index.ts", base + 100);
	write(".git/hooks/x.ts", base + 110);
	write(".gitignore", base + 1, "ignored/\n");
	write("ignored/g.ts", base + 2);
	write("README.md", base);
	for (let i = 0; i < 120; i++) write(`lots/f${String(i).padStart(3, "0")}.txt`, base + i);
});

describe("Glob", () => {
	it("schema matches Claude Code", () => {
		expect(Object.keys((globTool.parameters as any).properties).sort()).toEqual(["path", "pattern"]);
		expect((globTool.parameters as any).required).toEqual(["pattern"]);
	});

	it("returns cwd-relative paths oldest first, including node_modules, .git, dotfiles and gitignored files", async () => {
		const r = await run({ pattern: "**/*.ts" });
		expect(r.text.split("\n")).toEqual([
			"ignored/g.ts",
			".config/f.ts",
			"a.ts",
			"src/c.ts",
			"b.ts",
			"src/deep/d.ts",
			"node_modules/pkg/index.ts",
			".git/hooks/x.ts",
		]);
		expect(r.details).toMatchObject({ numFiles: 8, truncated: false, totalMatches: 8 });
	});

	it("a pattern without a slash matches at any depth (rg --glob semantics)", async () => {
		const r = await run({ pattern: "*.js" });
		expect(r.text).toBe("src/e.js");
	});

	it("a pattern with a slash is anchored to the search directory", async () => {
		const r = await run({ pattern: "src/*" });
		expect(r.text.split("\n")).toEqual(["src/c.ts", "src/e.js"]);
	});

	it("supports brace expansion", async () => {
		const r = await run({ pattern: "src/**/*.{ts,js}" });
		expect(r.text.split("\n")).toEqual(["src/c.ts", "src/deep/d.ts", "src/e.js"]);
	});

	it("honors the path parameter (relative and absolute)", async () => {
		const rel = await run({ pattern: "*.ts", path: "src" });
		expect(rel.text.split("\n")).toEqual(["src/c.ts", "src/deep/d.ts"]);
		const abs = await run({ pattern: "deep/*", path: join(dir, "src") });
		expect(abs.text).toBe("src/deep/d.ts");
	});

	it("drops a pattern prefix that repeats the search directory", async () => {
		const r = await run({ pattern: "src/**/*.ts", path: "src" });
		expect(r.text.split("\n")).toEqual(["src/c.ts", "src/deep/d.ts"]);
		expect(stripRepeatedDirPrefix("src/**/*.ts", "/x/src")).toBe("/**/*.ts");
		expect(stripRepeatedDirPrefix("a/b/*.ts", "/x/a/b")).toBe("/*.ts");
		expect(stripRepeatedDirPrefix("lib/*.ts", "/x/src")).toBe("lib/*.ts");
	});

	it("an absolute pattern searches its literal base directory", async () => {
		const r = await run({ pattern: join(dir, "src", "*.js") });
		expect(r.text).toBe("src/e.js");
		expect(splitAbsolutePattern("/a/b/**/*.ts")).toEqual({ baseDir: "/a/b", relativePattern: "**/*.ts" });
		expect(splitAbsolutePattern("/a/b/c.ts")).toEqual({ baseDir: "/a/b", relativePattern: "c.ts" });
		expect(splitAbsolutePattern("src/*.ts")).toBeNull();
	});

	it("prints absolute paths outside cwd", async () => {
		const r = await run({ pattern: "*.ts", path: join(dir, "src") }, join(dir, "lots"));
		expect(r.text.split("\n")).toEqual([join(dir, "src/c.ts"), join(dir, "src/deep/d.ts")]);
	});

	it("returns 'No files found' when empty, and for directory-only matches", async () => {
		expect((await run({ pattern: "**/*.nothing" })).text).toBe("No files found");
		expect((await run({ pattern: "src" })).text).toBe("No files found");
	});

	it("truncates at 100 results (oldest first) with Claude Code's note", async () => {
		const r = await run({ pattern: "lots/*.txt" });
		const lines = r.text.split("\n");
		expect(lines).toHaveLength(101);
		expect(lines[0]).toBe("lots/f000.txt");
		expect(lines[99]).toBe("lots/f099.txt");
		expect(lines[100]).toBe("(Showing 100 of 120 matching files; 20 more are not listed. Narrow the pattern or path to see the rest.)");
		expect(globTruncationNote(100, 120)).toBe(lines[100]);
		expect(r.details).toMatchObject({ numFiles: 100, truncated: true, totalMatches: 120, countIsComplete: true });
	});

	it("errors when path does not exist", async () => {
		await expect(run({ pattern: "*", path: "nope" })).rejects.toThrow(
			`Directory does not exist: nope. Note: your current working directory is ${dir}.`,
		);
	});

	it("errors when path is a file", async () => {
		await expect(run({ pattern: "*", path: "a.ts" })).rejects.toThrow("Path is not a directory: a.ts");
	});

	it("rejects when aborted", async () => {
		const ac = new AbortController();
		ac.abort();
		await expect(run({ pattern: "**/*" }, dir, ac.signal)).rejects.toThrow(/aborted/i);
	});

	it("runs end-to-end via a faux session", async () => {
		const cwd = tempDir("pi-cc-glob-e2e-");
		writeFileSync(join(cwd, "z.md"), "z");
		const t = await createTestSession({
			cwd,
			responses: [fauxAssistantMessage(fauxToolCall("Glob", { pattern: "*.md" }), { stopReason: "toolUse" }), fauxAssistantMessage("done")],
		});
		try {
			await t.session.prompt("go");
			const res = t.toolResults().find((r) => r.toolName === "Glob");
			expect(res).toMatchObject({ isError: false, text: "z.md" });
		} finally {
			t.dispose();
		}
	});
});

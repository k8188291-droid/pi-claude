import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createCCContext } from "../src/shared/context.js";
import { defaultIgnores, GLOB_TRUNCATION_NOTE, registerGlob } from "../src/tools/glob.js";
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
	write(".git/hooks/x.ts", base + 100);
	write("README.md", base);
	for (let i = 0; i < 120; i++) write(`lots/f${String(i).padStart(3, "0")}.txt`, base + i);
});

describe("Glob", () => {
	it("schema matches Claude Code", () => {
		expect(Object.keys((globTool.parameters as any).properties).sort()).toEqual(["path", "pattern"]);
		expect((globTool.parameters as any).required).toEqual(["pattern"]);
	});

	it("returns absolute paths sorted newest first; skips node_modules and .git; includes dotfiles", async () => {
		const r = await run({ pattern: "**/*.ts" });
		expect(r.text.split("\n")).toEqual([
			join(dir, "src/deep/d.ts"),
			join(dir, "b.ts"),
			join(dir, "src/c.ts"),
			join(dir, "a.ts"),
			join(dir, ".config/f.ts"),
		]);
		expect(r.details).toMatchObject({ numFiles: 5, truncated: false });
	});

	it("top-level patterns do not recurse", async () => {
		const r = await run({ pattern: "*.ts" });
		expect(r.text.split("\n")).toEqual([join(dir, "b.ts"), join(dir, "a.ts")]);
	});

	it("supports brace expansion", async () => {
		const r = await run({ pattern: "src/**/*.{ts,js}" });
		expect(r.text.split("\n")).toEqual([join(dir, "src/e.js"), join(dir, "src/deep/d.ts"), join(dir, "src/c.ts")]);
	});

	it("honors the path parameter (relative and absolute)", async () => {
		const rel = await run({ pattern: "*.ts", path: "src" });
		expect(rel.text).toBe(join(dir, "src/c.ts"));
		const abs = await run({ pattern: "**/*.ts", path: join(dir, "src") });
		expect(abs.text.split("\n")).toEqual([join(dir, "src/deep/d.ts"), join(dir, "src/c.ts")]);
	});

	it("treats literal 'undefined'/'null' path as omitted", async () => {
		const r = await run({ pattern: "*.ts", path: "undefined" });
		expect(r.text.split("\n")).toEqual([join(dir, "b.ts"), join(dir, "a.ts")]);
	});

	it("includes node_modules / .git when the pattern explicitly targets them", async () => {
		const nm = await run({ pattern: "node_modules/**/*.ts" });
		expect(nm.text).toBe(join(dir, "node_modules/pkg/index.ts"));
		const git = await run({ pattern: ".git/**" });
		expect(git.text).toBe(join(dir, ".git/hooks/x.ts"));
		expect(defaultIgnores("**/*.ts")).toContain("**/node_modules/**");
		expect(defaultIgnores("**/node_modules/**/*.ts")).not.toContain("**/node_modules/**");
	});

	it("returns 'No files found' when empty", async () => {
		expect((await run({ pattern: "**/*.nothing" })).text).toBe("No files found");
	});

	it("truncates at 100 results (newest first) with a note", async () => {
		const r = await run({ pattern: "lots/*.txt" });
		const lines = r.text.split("\n");
		expect(lines).toHaveLength(101);
		expect(lines[0]).toBe(join(dir, "lots/f119.txt"));
		expect(lines[99]).toBe(join(dir, "lots/f020.txt"));
		expect(lines[100]).toBe(GLOB_TRUNCATION_NOTE);
		expect(GLOB_TRUNCATION_NOTE).toContain("Results are truncated. Consider using a more specific path or pattern.");
		expect(r.details).toMatchObject({ numFiles: 120, truncated: true });
	});

	it("does not return directories", async () => {
		const r = await run({ pattern: "src/*" });
		expect(r.text.split("\n")).toEqual([join(dir, "src/e.js"), join(dir, "src/c.ts")]);
	});

	it("errors when path does not exist", async () => {
		await expect(run({ pattern: "*", path: "nope" })).rejects.toThrow(/Directory does not exist/);
	});

	it("errors when path is a file", async () => {
		await expect(run({ pattern: "*", path: "a.ts" })).rejects.toThrow(/not a directory/);
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
			expect(res).toMatchObject({ isError: false, text: join(cwd, "z.md") });
		} finally {
			t.dispose();
		}
	});
});

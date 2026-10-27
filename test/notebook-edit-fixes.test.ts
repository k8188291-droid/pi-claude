import { execFileSync } from "node:child_process";
import { readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCCContext } from "../src/shared/context.js";
import type { Quirk } from "../src/shared/quirks.js";
import { NOTEBOOK_MESSAGES, registerNotebookEdit } from "../src/tools/notebook-edit.js";
import { captureTools, fakeCtx, resultText, tempDir } from "./helpers.js";

// Regression tests for docs/review-2026-10-18.md on NotebookEdit: FIFOs (#7b) and the quirks #5,
// #6b, #8 and #27 in both modes.

const nb = (cells: unknown[]) => JSON.stringify({ cells, metadata: { language_info: { name: "python" } }, nbformat: 4, nbformat_minor: 5 });
const code = (id: string, source: string) => ({ cell_type: "code", id, metadata: {}, source, outputs: [{ output_type: "stream", text: ["x"] }], execution_count: 2 });
const md = (id: string, source: string) => ({ cell_type: "markdown", id, metadata: {}, source });

function setup(fixed: Quirk[] = []) {
	const cwd = tempDir("pi-cc-nb-fix-");
	const cc = createCCContext({ quirks: Object.fromEntries(fixed.map((q) => [q, "fixed"])) });
	const { tools } = captureTools((pi) => registerNotebookEdit(pi, cc));
	const tool = tools.get("NotebookEdit")!;
	const write = async (name: string, content: string, read = true) => {
		const p = join(cwd, name);
		writeFileSync(p, content);
		if (read) await cc.fileState.recordRead(p, readFileSync(p));
		return p;
	};
	const run = async (params: Record<string, unknown>) => {
		const args = tool.prepareArguments!({ ...params, notebook_path: join(cwd, params.notebook_path as string) });
		return resultText(await tool.execute("id", args as any, undefined, undefined, fakeCtx(cwd)));
	};
	const cells = (name: string) => JSON.parse(readFileSync(join(cwd, name), "utf8")).cells;
	return { cwd, cc, write, run, cells };
}
function rewriteKeepingMtime(p: string, content: string): void {
	const { atimeMs, mtimeMs } = statSync(p);
	writeFileSync(p, content);
	utimesSync(p, atimeMs / 1000, (Math.floor(mtimeMs) + 0.5) / 1000);
	expect(Math.floor(statSync(p).mtimeMs)).toBe(Math.floor(mtimeMs));
}

describe("#27 notebookCellTypeConversion", () => {
	it("default: fields are kept/dropped like Claude Code", async () => {
		const { write, run, cells } = setup();
		await write("a.ipynb", nb([code("aa", "print(1)"), md("bb", "# H")]));
		await run({ notebook_path: "a.ipynb", cell_id: "aa", new_source: "## md", cell_type: "markdown" });
		await run({ notebook_path: "a.ipynb", cell_id: "bb", new_source: "y = 2", cell_type: "code" });
		expect(cells("a.ipynb")).toEqual([
			{ cell_type: "markdown", id: "aa", metadata: {}, source: "## md", outputs: [], execution_count: null },
			{ cell_type: "code", id: "bb", metadata: {}, source: "y = 2" },
		]);
	});

	it("fixed: markdown cells lose outputs/execution_count, code cells get cleared ones (nbformat 4)", async () => {
		const { write, run, cells } = setup(["notebookCellTypeConversion"]);
		await write("a.ipynb", nb([code("aa", "print(1)"), md("bb", "# H"), code("cc", "z")]));
		await run({ notebook_path: "a.ipynb", cell_id: "aa", new_source: "## md", cell_type: "markdown" });
		await run({ notebook_path: "a.ipynb", cell_id: "bb", new_source: "y = 2", cell_type: "code" });
		await run({ notebook_path: "a.ipynb", cell_id: "cc", new_source: "w" });
		expect(cells("a.ipynb")).toEqual([
			{ cell_type: "markdown", id: "aa", metadata: {}, source: "## md" },
			{ cell_type: "code", id: "bb", metadata: {}, source: "y = 2", execution_count: null, outputs: [] },
			{ cell_type: "code", id: "cc", metadata: {}, source: "w", outputs: [], execution_count: null },
		]);
	});
});

describe("#5 mtimeOnlyChangeDetection (NotebookEdit)", () => {
	const before = nb([code("aa", "print(1)")]);
	const external = nb([code("aa", "print(2)")]);

	it("default: overwrites a notebook rewritten with its mtime restored, like Claude Code", async () => {
		const { write, run, cells } = setup();
		const p = await write("a.ipynb", before);
		rewriteKeepingMtime(p, external);
		await run({ notebook_path: "a.ipynb", cell_id: "aa", new_source: "print(3)" });
		expect(cells("a.ipynb")[0].source).toBe("print(3)");
	});

	it("fixed: the content change is detected", async () => {
		const { write, run, cells } = setup(["mtimeOnlyChangeDetection"]);
		const p = await write("a.ipynb", before);
		rewriteKeepingMtime(p, external);
		await expect(run({ notebook_path: "a.ipynb", cell_id: "aa", new_source: "print(3)" })).rejects.toThrow(NOTEBOOK_MESSAGES.modified);
		expect(cells("a.ipynb")[0].source).toBe("print(2)");
	});
});

describe("#6b notebookStaleBeforeSize", () => {
	// A stale notebook over the 100MB limit: which check answers first?
	const huge = () => nb([code("aa", "x".repeat(101 * 1024 * 1024))]);

	it("default: the staleness check (reading the whole file) comes first, like Claude Code", async () => {
		const { write, run } = setup();
		const p = await write("big.ipynb", nb([code("aa", "small")]));
		writeFileSync(p, huge());
		utimesSync(p, new Date(), new Date(Date.now() + 5000));
		await expect(run({ notebook_path: "big.ipynb", cell_id: "aa", new_source: "y" })).rejects.toThrow(NOTEBOOK_MESSAGES.modified);
	});

	it("fixed: the size check (a stat) comes first", async () => {
		const { write, run } = setup(["notebookStaleBeforeSize"]);
		const p = await write("big.ipynb", nb([code("aa", "small")]));
		writeFileSync(p, huge());
		utimesSync(p, new Date(), new Date(Date.now() + 5000));
		await expect(run({ notebook_path: "big.ipynb", cell_id: "aa", new_source: "y" })).rejects.toThrow(NOTEBOOK_MESSAGES.tooLarge);
	});
});

describe("FIFOs", () => {
	it("a FIFO notebook is refused without blocking or being written", async () => {
		const { cwd, cc, run } = setup();
		const p = join(cwd, "f.ipynb");
		execFileSync("mkfifo", [p]);
		await cc.fileState.recordRead(p, "");
		await expect(run({ notebook_path: "f.ipynb", cell_id: "aa", new_source: "y" })).rejects.toThrow(NOTEBOOK_MESSAGES.notRegular);
	});
});

describe("#8 pathTrim (NotebookEdit)", () => {
	it("default: 'a.ipynb ' edits 'a.ipynb'", async () => {
		const { write, run, cells } = setup();
		await write("a.ipynb", nb([code("aa", "1")]));
		await run({ notebook_path: "a.ipynb ", cell_id: "aa", new_source: "2" });
		expect(cells("a.ipynb")[0].source).toBe("2");
	});

	it("fixed: the path is used verbatim; an empty path is rejected", async () => {
		const { cwd, write, run, cells } = setup(["pathTrim"]);
		await write("a.ipynb", nb([code("aa", "1")]));
		await expect(run({ notebook_path: "a.ipynb ", cell_id: "aa", new_source: "2" })).rejects.toThrow(NOTEBOOK_MESSAGES.notNotebook);
		expect(cells("a.ipynb")[0].source).toBe("1");
		const { tools } = captureTools((pi) => registerNotebookEdit(pi, createCCContext({ quirks: { pathTrim: "fixed" } })));
		const tool = tools.get("NotebookEdit")!;
		await expect(tool.execute("id", { notebook_path: "", new_source: "x" } as any, undefined, undefined, fakeCtx(cwd))).rejects.toThrow(
			"notebook_path must not be empty.",
		);
	});
});

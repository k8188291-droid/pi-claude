import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCCContext } from "../src/shared/context.js";
import { NOTEBOOK_MESSAGES, registerNotebookEdit } from "../src/tools/notebook-edit.js";
import { captureTools, createTestSession, fakeCtx, fauxAssistantMessage, fauxToolCall, resultText, tempDir } from "./helpers.js";

const nb = (cells: unknown[], minor = 5) => JSON.stringify({ cells, metadata: { language_info: { name: "python" } }, nbformat: 4, nbformat_minor: minor });
const code = (id: string | undefined, source: string | string[]) => ({ cell_type: "code", ...(id ? { id } : {}), metadata: {}, source, outputs: [{ output_type: "stream", text: ["x"] }], execution_count: 2 });
const md = (id: string | undefined, source: string) => ({ cell_type: "markdown", ...(id ? { id } : {}), metadata: {}, source });

function setup(files: Record<string, string>, read: string[] = Object.keys(files)) {
	const cwd = tempDir();
	const cc = createCCContext({});
	for (const [name, content] of Object.entries(files)) writeFileSync(join(cwd, name), content);
	for (const name of read) cc.fileState.recordRead(join(cwd, name), readFileSync(join(cwd, name)));
	const { tools } = captureTools((pi) => registerNotebookEdit(pi, cc));
	const tool = tools.get("NotebookEdit")!;
	const run = async (params: Record<string, unknown>) => {
		const args = tool.prepareArguments!({ ...params, notebook_path: join(cwd, params.notebook_path as string) });
		return resultText(await tool.execute("id", args as any, undefined, undefined, fakeCtx(cwd)));
	};
	const file = (name: string) => readFileSync(join(cwd, name), "utf8");
	return { cwd, cc, tool, run, file };
}

describe("NotebookEdit", () => {
	it("declares Claude Code's schema", () => {
		const { tool } = setup({});
		const p = tool.parameters as any;
		expect(Object.keys(p.properties)).toEqual(["notebook_path", "cell_id", "new_source", "cell_type", "edit_mode"]);
		expect(p.required).toEqual(["notebook_path", "new_source"]);
		expect(tool.description).toMatch(/^Replaces, inserts, or deletes a single cell/);
	});

	it("replaces, changes cell type, deletes; writes JSON with 1-space indent", async () => {
		const { run, file } = setup({ "a.ipynb": nb([code("aa", "print(1)"), md("bb", "# H"), code("cc", "z")]) });
		expect(await run({ notebook_path: "a.ipynb", cell_id: "aa", new_source: "## md", cell_type: "markdown" })).toBe("Updated cell aa with ## md");
		expect(await run({ notebook_path: "a.ipynb", cell_id: "bb", new_source: "y = 2", cell_type: "code" })).toBe("Updated cell bb with y = 2");
		expect(await run({ notebook_path: "a.ipynb", cell_id: "cc", new_source: "", edit_mode: "delete" })).toBe("Deleted cell cc");
		const out = file("a.ipynb");
		expect(out).toBe(
			JSON.stringify(
				{
					cells: [
						{ cell_type: "markdown", id: "aa", metadata: {}, source: "## md", outputs: [], execution_count: null },
						{ cell_type: "code", id: "bb", metadata: {}, source: "y = 2" },
					],
					metadata: { language_info: { name: "python" } },
					nbformat: 4,
					nbformat_minor: 5,
				},
				null,
				1,
			),
		);
	});

	it("cell-N ids, inserts in an nbformat 4.4 notebook, CRLF preserved", async () => {
		const { run, file } = setup({ "o.ipynb": nb([code(undefined, ["a\n", "b"]), md(undefined, "# T")], 4), "c.ipynb": nb([code("k", "v")]).replace(/,/g, ",\r\n") });
		expect(await run({ notebook_path: "o.ipynb", new_source: "import os", cell_type: "code", edit_mode: "insert" })).toBe("Inserted cell undefined with import os");
		expect(await run({ notebook_path: "o.ipynb", cell_id: "cell-1", new_source: "note", cell_type: "markdown", edit_mode: "insert" })).toBe("Inserted cell undefined with note");
		expect(JSON.parse(file("o.ipynb")).cells.map((c: any) => c.source)).toEqual(["import os", ["a\n", "b"], "note", "# T"]);
		expect(await run({ notebook_path: "o.ipynb", cell_id: "cell-3", new_source: "end" })).toBe("Updated cell undefined with end");
		expect(await run({ notebook_path: "c.ipynb", cell_id: "k", new_source: "v = 2" })).toBe("Updated cell k with v = 2");
		expect(file("c.ipynb")).toContain('"source": "v = 2",\r\n');
	});

	it("inserted cells in nbformat >= 4.5 get a random 8-char id", async () => {
		const { run, file } = setup({ "a.ipynb": nb([code("aa", "x")]) });
		const text = await run({ notebook_path: "a.ipynb", cell_id: "aa", new_source: "y", cell_type: "code", edit_mode: "insert" });
		const id = JSON.parse(file("a.ipynb")).cells[1].id;
		expect(id).toMatch(/^[0-9a-f]{8}$/);
		expect(text).toBe(`Inserted cell ${id} with y`);
	});

	it.each([
		["not a notebook", { notebook_path: "n.txt", cell_id: "x", new_source: "x" }, NOTEBOOK_MESSAGES.notNotebook],
		["insert without cell_type", { notebook_path: "a.ipynb", cell_id: "aa", new_source: "x", edit_mode: "insert" }, NOTEBOOK_MESSAGES.cellTypeRequired],
		["unread notebook", { notebook_path: "u.ipynb", cell_id: "u", new_source: "x" }, NOTEBOOK_MESSAGES.notRead],
		["unknown cell", { notebook_path: "a.ipynb", cell_id: "nope", new_source: "x" }, 'Cell with ID "nope" not found in notebook.'],
		["cell-N out of range", { notebook_path: "a.ipynb", cell_id: "cell-9", new_source: "x" }, "Cell with index 9 does not exist in notebook."],
		["replace without cell_id", { notebook_path: "a.ipynb", new_source: "x" }, NOTEBOOK_MESSAGES.cellIdRequired],
		["invalid notebook", { notebook_path: "bad.ipynb", cell_id: "x", new_source: "x" }, NOTEBOOK_MESSAGES.invalidNotebook],
		["invalid JSON", { notebook_path: "j.ipynb", cell_id: "x", new_source: "x" }, NOTEBOOK_MESSAGES.invalidJson],
	])("rejects: %s", async (_name, params, message) => {
		const { run } = setup({ "a.ipynb": nb([code("aa", "x")]), "u.ipynb": nb([code("u", "x")]), "n.txt": "x", "bad.ipynb": "{}", "j.ipynb": "{x" }, ["a.ipynb", "n.txt", "bad.ipynb", "j.ipynb"]);
		await expect(run(params)).rejects.toThrow(message);
	});

	it("refuses a notebook whose content changed since it was read", async () => {
		const { run, cwd } = setup({ "a.ipynb": nb([code("aa", "x")]) });
		await new Promise((r) => setTimeout(r, 20));
		writeFileSync(join(cwd, "a.ipynb"), nb([code("aa", "changed")]));
		await expect(run({ notebook_path: "a.ipynb", cell_id: "aa", new_source: "y" })).rejects.toThrow(NOTEBOOK_MESSAGES.modified);
	});

	it("validation errors use Claude Code's wording", () => {
		const { tool } = setup({});
		expect(() => tool.prepareArguments!({ notebook_path: "/x.ipynb", cell_id: "a" })).toThrow(
			"InputValidationError: NotebookEdit failed due to the following issue:\nThe required parameter `new_source` is missing",
		);
		expect(() => tool.prepareArguments!({ notebook_path: "/x.ipynb", new_source: "", edit_mode: "append" })).toThrow(/"code": "invalid_value"/);
	});

	it("end-to-end: Read then NotebookEdit through a session", async () => {
		const cwd = tempDir();
		const path = join(cwd, "nb.ipynb");
		writeFileSync(path, nb([code("c1", "x = 1")]));
		const t = await createTestSession({
			cwd,
			responses: [
				fauxAssistantMessage(fauxToolCall("NotebookEdit", { notebook_path: path, cell_id: "c1", new_source: "x = 2" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("Read", { file_path: path }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("NotebookEdit", { notebook_path: path, cell_id: "c1", new_source: "x = 2" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			],
			claudeCode: { subagents: false },
		});
		await t.session.prompt("edit");
		const r = t.toolResults();
		expect(r[0]).toMatchObject({ toolName: "NotebookEdit", isError: true, text: NOTEBOOK_MESSAGES.notRead });
		expect(r[2]).toMatchObject({ toolName: "NotebookEdit", isError: false, text: "Updated cell c1 with x = 2" });
		expect(JSON.parse(readFileSync(path, "utf8")).cells[0].source).toBe("x = 2");
		t.dispose();
	});
});

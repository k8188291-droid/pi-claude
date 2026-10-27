import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CCContext } from "../shared/context.js";
import { resolveToolPath } from "../shared/paths.js";
import { isFixed } from "../shared/quirks.js";
import { textResult } from "../shared/text.js";
import { NotRegularFileError, readRegularFile, writeRegularFile } from "./write.js";
import { claudeInputValidator, type Spec } from "./input-validation.js";

export const NOTEBOOK_EDIT_TOOL_NAME = "NotebookEdit";

export const NOTEBOOK_EDIT_DESCRIPTION = `Replaces, inserts, or deletes a single cell in a Jupyter notebook (.ipynb file).

Usage:
- You must use the Read tool on the notebook in this conversation before editing — this tool will fail otherwise.
- \`notebook_path\` must be an absolute path.
- \`cell_id\` is the \`id\` attribute shown in the Read tool's \`<cell id="...">\` output. It is required for \`replace\` and \`delete\`.
- \`edit_mode\` defaults to \`replace\`. Use \`insert\` to add a new cell after the cell with the given \`cell_id\` (or at the beginning of the notebook if \`cell_id\` is omitted) — \`cell_type\` is required when inserting. Use \`delete\` to remove the cell.`;

/** JSON schema exactly as Claude Code declares it. */
export const NotebookEditParams = {
	type: "object",
	properties: {
		notebook_path: { description: "The absolute path to the Jupyter notebook file to edit (must be absolute, not relative)", type: "string" },
		cell_id: {
			description: "The ID of the cell to edit. When inserting a new cell, the new cell will be inserted after the cell with this ID, or at the beginning if not specified.",
			type: "string",
		},
		new_source: { description: "The new source for the cell", type: "string" },
		cell_type: {
			description: "The type of the cell (code or markdown). If not specified, it defaults to the current cell type. If using edit_mode=insert, this is required.",
			type: "string",
			enum: ["code", "markdown"],
		},
		edit_mode: { description: "The type of edit to make (replace, insert, delete). Defaults to replace.", type: "string", enum: ["replace", "insert", "delete"] },
	},
	required: ["notebook_path", "new_source"],
	additionalProperties: false,
};

const NotebookEditSpec: Spec = {
	kind: "object",
	props: {
		notebook_path: { spec: { kind: "string" } },
		cell_id: { spec: { kind: "string" }, optional: true },
		new_source: { spec: { kind: "string" } },
		cell_type: { spec: { kind: "enum", values: ["code", "markdown"] }, optional: true },
		edit_mode: { spec: { kind: "enum", values: ["replace", "insert", "delete"] }, optional: true },
	},
};

export interface NotebookEditInput {
	notebook_path: string;
	cell_id?: string;
	new_source: string;
	cell_type?: "code" | "markdown";
	edit_mode?: "replace" | "insert" | "delete";
}

export interface NotebookEditDetails {
	notebook_path: string;
	cell_id?: string;
	cell_type: "code" | "markdown";
	edit_mode: string;
	language: string;
	new_source: string;
	old_source?: string;
}

/** Largest notebook the tool reads or writes (Claude Code: 100 MB). */
const MAX_NOTEBOOK_BYTES = 100 * 1024 * 1024;

export const NOTEBOOK_MESSAGES = {
	notNotebook: "File must be a Jupyter notebook (.ipynb file). For editing other file types, use the FileEdit tool.",
	cellTypeRequired: "Cell type is required when using edit_mode=insert.",
	notRead: "File has not been read yet. Read it first before writing to it.",
	modified: "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.",
	missing: "Notebook file does not exist.",
	invalidJson: "Notebook is not valid JSON.",
	invalidNotebook: 'Notebook file is not a valid Jupyter notebook (top-level "cells" must be an array of cell objects, each with a string or string-array "source").',
	cellIdRequired: "Cell ID must be specified when not inserting a new cell.",
	tooLarge: "Notebook file exceeds the maximum size this tool can read (100MB).",
	notRegular: "Notebook path is not a regular file (device, FIFO, or socket).",
} as const;

class NotebookEditError extends Error {}

/** "cell-3" → 3 (the ids Read shows for cells without an `id`). */
function cellIndexFromId(id: string): number | undefined {
	const m = id.match(/^cell-(\d+)$/);
	if (!m?.[1]) return undefined;
	const n = Number.parseInt(m[1], 10);
	return Number.isNaN(n) ? undefined : n;
}

function isNotebook(nb: any): nb is { cells: any[]; metadata?: any; nbformat?: number; nbformat_minor?: number } {
	const cells = nb?.cells;
	return (
		Array.isArray(cells) &&
		!cells.some((c) => c === null || typeof c !== "object" || (typeof c.source !== "string" && !(Array.isArray(c.source) && c.source.every((s: unknown) => typeof s === "string"))))
	);
}

function sourceText(source: string | string[]): string {
	return Array.isArray(source) ? source.join("") : source;
}

function lineEndings(text: string): "CRLF" | "LF" {
	const crlf = text.split("\r\n").length - 1;
	const lf = text.split("\n").length - 1 - crlf;
	return crlf > lf ? "CRLF" : "LF";
}

function resultText(mode: string, cellId: string | undefined, newSource: string): string {
	switch (mode) {
		case "replace":
			return `Updated cell ${cellId} with ${newSource}`;
		case "insert":
			return `Inserted cell ${cellId} with ${newSource}`;
		case "delete":
			return `Deleted cell ${cellId}`;
		default:
			return "Unknown edit mode";
	}
}

export function registerNotebookEdit(pi: ExtensionAPI, cc: CCContext): void {
	pi.registerTool({
		name: NOTEBOOK_EDIT_TOOL_NAME,
		label: "Edit Notebook",
		description: NOTEBOOK_EDIT_DESCRIPTION,
		promptSnippet: "NotebookEdit: replace, insert or delete a cell in a Jupyter notebook",
		parameters: NotebookEditParams as any,
		prepareArguments: claudeInputValidator<NotebookEditInput>(NOTEBOOK_EDIT_TOOL_NAME, NotebookEditSpec),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const { notebook_path, new_source, cell_id, edit_mode } = params as NotebookEditInput;
			let cellType = (params as NotebookEditInput).cell_type;
			const cwd = ctx?.cwd ?? process.cwd();
			const absPath = resolveToolPath(cc, cwd, notebook_path, "notebook_path");
			const contentCheck = isFixed(cc, "mtimeOnlyChangeDetection");
			const sizeFirst = isFixed(cc, "notebookStaleBeforeSize");
			const fixCellFields = isFixed(cc, "notebookCellTypeConversion");
			const fs = cc.host.fs;

			return withFileMutationQueue(absPath, async () => {
				// ---- validation (Claude Code's validateInput order) ----
				const mode = edit_mode ?? "replace";
				if (extname(absPath) !== ".ipynb") throw new NotebookEditError(NOTEBOOK_MESSAGES.notNotebook);
				if (mode === "insert" && !cellType) throw new NotebookEditError(NOTEBOOK_MESSAGES.cellTypeRequired);
				if (!cc.fileState.has(absPath)) throw new NotebookEditError(NOTEBOOK_MESSAGES.notRead);
				// Size (a stat) before staleness (which may read the whole file): #6b fixed.
				// Claude Code checks staleness first.
				const checkSize = async () => {
					try {
						const st = await fs.stat(absPath);
						if (st.size > MAX_NOTEBOOK_BYTES) throw new NotebookEditError(NOTEBOOK_MESSAGES.tooLarge);
					} catch (err: any) {
						if (err?.code === "ENOENT") throw new NotebookEditError(NOTEBOOK_MESSAGES.missing);
						throw err;
					}
				};
				if (sizeFirst) await checkSize();
				if (await cc.fileState.isStale(absPath, undefined, { contentCheck })) throw new NotebookEditError(NOTEBOOK_MESSAGES.modified);
				if (!sizeFirst) await checkSize();
				let raw: string;
				try {
					// Checked before reading: a FIFO or device is refused, never read or written.
					raw = (await readRegularFile(fs, absPath)).toString("utf8");
				} catch (err: any) {
					if (err?.code === "ENOENT") throw new NotebookEditError(NOTEBOOK_MESSAGES.missing);
					if (err instanceof NotRegularFileError) throw new NotebookEditError(NOTEBOOK_MESSAGES.notRegular);
					throw err;
				}
				let nb: any;
				try {
					nb = JSON.parse(raw);
				} catch {
					throw new NotebookEditError(NOTEBOOK_MESSAGES.invalidJson);
				}
				if (!isNotebook(nb)) throw new NotebookEditError(NOTEBOOK_MESSAGES.invalidNotebook);
				if (!cell_id) {
					if (mode !== "insert") throw new NotebookEditError(NOTEBOOK_MESSAGES.cellIdRequired);
				} else if (!nb.cells.some((c) => c.id === cell_id)) {
					const idx = cellIndexFromId(cell_id);
					if (idx === undefined) throw new NotebookEditError(`Cell with ID "${cell_id}" not found in notebook.`);
					if (!nb.cells[idx]) throw new NotebookEditError(`Cell with index ${idx} does not exist in notebook.`);
				}

				// ---- edit (Claude Code's call) ----
				let index = 0;
				if (cell_id) {
					index = nb.cells.findIndex((c) => c.id === cell_id);
					if (index === -1) index = cellIndexFromId(cell_id) ?? -1;
					if (edit_mode === "insert") index += 1;
				}
				let effectiveMode = edit_mode;
				if (effectiveMode === "replace" && index === nb.cells.length) {
					effectiveMode = "insert";
					cellType ||= "code";
				}
				const language: string = nb.metadata?.language_info?.name ?? "python";
				let newCellId: string | undefined;
				if ((nb.nbformat ?? 0) > 4 || (nb.nbformat === 4 && (nb.nbformat_minor ?? 0) >= 5)) {
					if (effectiveMode === "insert") newCellId = randomUUID().slice(0, 8);
					else newCellId = cell_id;
				}
				let oldSource: string | undefined;
				if (effectiveMode === "delete") {
					oldSource = sourceText(nb.cells[index].source);
					nb.cells.splice(index, 1);
				} else if (effectiveMode === "insert") {
					const cell =
						cellType === "markdown"
							? { cell_type: "markdown", id: newCellId, source: new_source, metadata: {} }
							: { cell_type: "code", id: newCellId, source: new_source, metadata: {}, execution_count: null, outputs: [] };
					nb.cells.splice(index, 0, cell);
				} else {
					const cell = nb.cells[index];
					oldSource = sourceText(cell.source);
					cell.source = new_source;
					if (fixCellFields) {
						// #27 fixed: give the cell the fields its (new) type has in nbformat 4: code cells
						// get cleared outputs and execution_count, markdown/raw cells have neither.
						if (cellType && cellType !== cell.cell_type) cell.cell_type = cellType;
						if (cell.cell_type === "code") {
							cell.execution_count = null;
							cell.outputs = [];
						} else {
							delete cell.execution_count;
							delete cell.outputs;
						}
					} else {
						if (cell.cell_type === "code") {
							cell.execution_count = null;
							cell.outputs = [];
						}
						if (cellType && cellType !== cell.cell_type) cell.cell_type = cellType;
					}
				}
				let out = JSON.stringify(nb, null, 1);
				if (lineEndings(raw) === "CRLF") out = out.replace(/\n/g, "\r\n");
				if (Buffer.byteLength(out, "utf8") > MAX_NOTEBOOK_BYTES) {
					throw new NotebookEditError("Edit rejected: the updated notebook would exceed the maximum size this tool can read (100MB). The file was left unchanged.");
				}
				if (signal?.aborted) throw new Error("Operation aborted");
				try {
					await writeRegularFile(fs, absPath, out);
				} catch (err) {
					if (err instanceof NotRegularFileError) throw new NotebookEditError(NOTEBOOK_MESSAGES.notRegular);
					throw err;
				}
				await cc.fileState.recordWrite(absPath, out);
				const resultMode = effectiveMode ?? "replace";
				const resultCellId = newCellId || undefined;
				return textResult<NotebookEditDetails>(resultText(resultMode, resultCellId, new_source), {
					notebook_path: absPath,
					cell_id: resultCellId,
					cell_type: cellType ?? "code",
					edit_mode: resultMode,
					language,
					new_source,
					old_source: oldSource,
				});
			});
		},
	});
}

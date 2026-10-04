import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentToolResult, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import type { CCContext } from "../shared/context.js";
import { resolvePath } from "../shared/paths.js";
import { formatNumberedLine, splitLines } from "./read.js";

const DESCRIPTION = `Performs exact string replacements in files.

Usage:
- You must use your \`Read\` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.
- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: spaces + line number + tab. Everything after that tab is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if \`old_string\` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use \`replace_all\` to change every instance of \`old_string\`.
- Use \`replace_all\` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.
- To make several changes to the same file in one call, pass \`edits\` (an array of {old_string, new_string, replace_all?}) instead of the top-level old_string/new_string. Edits are applied sequentially, each to the result of the previous one, and atomically: if any edit fails, none are applied.
- To create a new file, use an empty old_string and the file's contents as new_string (the file must not already exist with content).`;

const editItemSchema = Type.Object(
	{
		old_string: Type.String({ description: "The text to replace" }),
		new_string: Type.String({ description: "The text to replace it with (must be different from old_string)" }),
		replace_all: Type.Optional(Type.Boolean({ description: "Replace all occurences of old_string (default false)", default: false })),
	},
	{ additionalProperties: false },
);

const editSchema = Type.Object(
	{
		file_path: Type.String({ description: "The absolute path to the file to modify" }),
		old_string: Type.Optional(Type.String({ description: "The text to replace" })),
		new_string: Type.Optional(Type.String({ description: "The text to replace it with (must be different from old_string)" })),
		replace_all: Type.Optional(Type.Boolean({ description: "Replace all occurences of old_string (default false)", default: false })),
		edits: Type.Optional(
			Type.Array(editItemSchema, {
				description:
					"Optional: multiple edits to apply to the same file in one call, sequentially and atomically (all or nothing). Use instead of the top-level old_string/new_string.",
				minItems: 1,
			}),
		),
	},
	{ additionalProperties: false },
);

export interface EditSpec {
	old_string: string;
	new_string: string;
	replace_all?: boolean;
}

export interface EditToolDetails {
	filePath: string;
	created: boolean;
	/** total number of replacements performed across all edits */
	replacements: number;
	/** first changed line (1-based) in the new file, if any */
	firstChangedLine?: number;
}

const SNIPPET_CONTEXT_LINES = 4;
const SNIPPET_MAX_LINES = 60;
const MAX_EDIT_FILE_BYTES = 256 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------------------------

export function normalizeQuotes(s: string): string {
	return s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}

function isOpeningContext(prev: string): boolean {
	return prev === "" || /[\s([{—–-]/.test(prev);
}

/**
 * When old_string only matched after quote normalization (the file uses curly quotes), apply the
 * file's curly-quote style to straight quotes in new_string.
 */
export function preserveQuoteStyle(requestedOld: string, actualOld: string, newString: string): string {
	if (requestedOld === actualOld) return newString;
	const hasDouble = /[“”]/.test(actualOld);
	const hasSingle = /[‘’]/.test(actualOld);
	if (!hasDouble && !hasSingle) return newString;
	let out = "";
	for (let i = 0; i < newString.length; i++) {
		const ch = newString[i];
		const prev = i > 0 ? newString[i - 1] : "";
		const next = i + 1 < newString.length ? newString[i + 1] : "";
		if (ch === '"' && hasDouble) {
			out += isOpeningContext(prev) ? "“" : "”";
		} else if (ch === "'" && hasSingle) {
			if (/[\p{L}\p{N}]/u.test(prev) && /[\p{L}\p{N}]/u.test(next)) out += "’"; // apostrophe
			else out += isOpeningContext(prev) ? "‘" : "’";
		} else {
			out += ch;
		}
	}
	return out;
}

export function countOccurrences(haystack: string, needle: string): number {
	if (needle === "") return 0;
	let count = 0;
	let idx = haystack.indexOf(needle);
	while (idx !== -1) {
		count++;
		idx = haystack.indexOf(needle, idx + needle.length);
	}
	return count;
}

class EditError extends Error {}

/**
 * Apply edits sequentially to `content`. Throws EditError on the first failing edit.
 * `fileExists` controls the empty-old_string semantics.
 */
export function applyEdits(content: string, edits: EditSpec[], fileExists: boolean): { content: string; replacements: number } {
	let current = content;
	let replacements = 0;
	const previousNew: string[] = [];
	const multi = edits.length > 1;
	for (let i = 0; i < edits.length; i++) {
		const prefix = multi ? `Edit ${i + 1} of ${edits.length}: ` : "";
		const { old_string: oldStr, new_string: newStr } = edits[i];
		const replaceAll = edits[i].replace_all === true;
		if (oldStr === newStr) {
			throw new EditError(`${prefix}No changes to make: old_string and new_string are exactly the same.`);
		}
		if (oldStr === "") {
			if (i > 0) throw new EditError(`${prefix}old_string must not be empty (an empty old_string is only allowed as the first edit, to create a file).`);
			if (fileExists && current.trim() !== "") {
				throw new EditError("Cannot create new file - file already exists.");
			}
			current = newStr;
			replacements++;
			previousNew.push(newStr);
			continue;
		}
		if (!fileExists && i === 0) {
			throw new EditError("File does not exist.");
		}
		if (previousNew.some((s) => s.includes(oldStr))) {
			throw new EditError(`${prefix}Cannot edit file: old_string is a substring of a new_string from a previous edit.`);
		}

		let actualOld = oldStr;
		let actualNew = newStr;
		let count = countOccurrences(current, oldStr);
		if (count === 0) {
			// Fallback: the model may have typed straight quotes where the file has curly ones (or vice versa).
			const idx = normalizeQuotes(current).indexOf(normalizeQuotes(oldStr));
			if (idx !== -1) {
				actualOld = current.slice(idx, idx + oldStr.length);
				actualNew = preserveQuoteStyle(oldStr, actualOld, newStr);
				count = countOccurrences(current, actualOld);
			}
		}
		if (count === 0) {
			throw new EditError(`${prefix}String to replace not found in file.\nString: ${oldStr}`);
		}
		if (count > 1 && !replaceAll) {
			throw new EditError(
				`${prefix}Found ${count} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${oldStr}`,
			);
		}
		if (replaceAll) {
			current = current.split(actualOld).join(actualNew);
			replacements += count;
		} else {
			const idx = current.indexOf(actualOld);
			current = current.slice(0, idx) + actualNew + current.slice(idx + actualOld.length);
			replacements++;
		}
		previousNew.push(actualNew);
	}
	return { content: current, replacements };
}

/** Build a cat -n snippet of the changed region of `after` (compared to `before`). */
export function buildSnippet(before: string, after: string): { snippet: string; firstChangedLine?: number } {
	const afterLines = splitLines(after);
	if (afterLines.length === 0) return { snippet: "" };
	let p = 0;
	const minLen = Math.min(before.length, after.length);
	while (p < minLen && before.charCodeAt(p) === after.charCodeAt(p)) p++;
	let s = 0;
	while (s < minLen - p && before.charCodeAt(before.length - 1 - s) === after.charCodeAt(after.length - 1 - s)) s++;
	const lineOf = (pos: number) => {
		let n = 0;
		for (let i = 0; i < pos && i < after.length; i++) if (after.charCodeAt(i) === 10) n++;
		return n;
	};
	const firstIdx = Math.min(lineOf(p), afterLines.length - 1);
	const changedEnd = Math.max(p, after.length - s - 1);
	const lastIdx = Math.min(Math.max(firstIdx, lineOf(changedEnd)), afterLines.length - 1);
	const from = Math.max(0, firstIdx - SNIPPET_CONTEXT_LINES);
	const to = Math.min(afterLines.length - 1, lastIdx + SNIPPET_CONTEXT_LINES);
	const out: string[] = [];
	for (let i = from; i <= to && out.length < SNIPPET_MAX_LINES; i++) out.push(formatNumberedLine(i + 1, afterLines[i]));
	const shownTo = from + out.length - 1;
	if (shownTo < to) out.push(`... (${to - shownTo} more changed lines not shown)`);
	return { snippet: out.join("\n"), firstChangedLine: firstIdx + 1 };
}

function collectEdits(params: {
	old_string?: string;
	new_string?: string;
	replace_all?: boolean;
	edits?: EditSpec[];
}): EditSpec[] {
	const edits: EditSpec[] = [];
	const hasTop = params.old_string !== undefined || params.new_string !== undefined;
	if (hasTop) {
		if (typeof params.old_string !== "string" || typeof params.new_string !== "string") {
			throw new Error("Both old_string and new_string are required (or pass an `edits` array).");
		}
		edits.push({ old_string: params.old_string, new_string: params.new_string, replace_all: params.replace_all });
	}
	if (params.edits !== undefined) {
		if (!Array.isArray(params.edits)) throw new Error("edits must be an array.");
		for (const [i, e] of params.edits.entries()) {
			if (!e || typeof e.old_string !== "string" || typeof e.new_string !== "string") {
				throw new Error(`edits[${i}] must have string old_string and new_string.`);
			}
			edits.push({ old_string: e.old_string, new_string: e.new_string, replace_all: e.replace_all });
		}
	}
	if (edits.length === 0) {
		throw new Error("Missing old_string/new_string: provide old_string and new_string, or a non-empty `edits` array.");
	}
	return edits;
}

// ---------------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------------

export function registerEdit(pi: ExtensionAPI, cc: CCContext): void {
	pi.registerTool({
		name: "Edit",
		label: "Edit",
		description: DESCRIPTION,
		promptSnippet: "Make exact string replacements in files",
		parameters: editSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<EditToolDetails>> {
			if (signal?.aborted) throw new Error("Operation aborted");
			if (typeof params.file_path !== "string" || params.file_path.trim() === "") throw new Error("file_path is required.");
			const edits = collectEdits(params);
			const absPath = resolvePath(ctx?.cwd ?? process.cwd(), params.file_path);

			return withFileMutationQueue(absPath, async () => {
				if (signal?.aborted) throw new Error("Operation aborted");

				let fileExists = false;
				try {
					const st = await stat(absPath);
					if (st.isDirectory()) throw new Error(`${absPath} is a directory.`);
					if (st.size > MAX_EDIT_FILE_BYTES) throw new Error(`File is too large to edit (${(st.size / 1024 / 1024).toFixed(1)}MB).`);
					fileExists = true;
				} catch (err: any) {
					if (err?.code !== "ENOENT") throw err;
				}

				if (!fileExists && edits[0].old_string !== "") {
					throw new Error(
						`File does not exist: ${absPath}. To create a new file, use the Write tool (or Edit with an empty old_string).`,
					);
				}
				if (fileExists) {
					const problem = cc.fileState.checkCanModify(absPath);
					if (problem) throw new Error(problem);
				}

				let bom = "";
				let body = "";
				if (fileExists) {
					const raw = (await readFile(absPath, { signal })).toString("utf8");
					if (raw.startsWith("﻿")) {
						bom = "﻿";
						body = raw.slice(1);
					} else body = raw;
				}

				// Line endings: if the file is consistently CRLF, work in LF space and convert back.
				// If it has no CR at all, normalize CRLF in the model's strings to LF.
				// Mixed files are matched exactly as-is.
				const isCrlf = body.includes("\r\n") && !/(^|[^\r])\n/.test(body);
				const normalizeEol = isCrlf || !body.includes("\r");
				const toLf = (s: string) => (normalizeEol ? s.replace(/\r\n/g, "\n") : s);
				const work = toLf(body);
				const normalizedEdits = edits.map((e) => ({ ...e, old_string: toLf(e.old_string), new_string: toLf(e.new_string) }));

				let result: { content: string; replacements: number };
				try {
					result = applyEdits(work, normalizedEdits, fileExists);
				} catch (err) {
					if (err instanceof EditError) throw new Error(err.message);
					throw err;
				}
				if (fileExists && result.content === work) {
					throw new Error("Original and edited file match exactly. Failed to apply edit.");
				}

				const finalText = bom + (isCrlf ? result.content.replace(/\n/g, "\r\n") : result.content);
				const data = Buffer.from(finalText, "utf8");
				if (signal?.aborted) throw new Error("Operation aborted");
				if (!fileExists) await mkdir(dirname(absPath), { recursive: true });
				await writeFile(absPath, data);
				cc.fileState.recordWrite(absPath, data);

				const { snippet, firstChangedLine } = buildSnippet(work, result.content);
				let text: string;
				if (!fileExists) {
					text = `File created successfully at: ${absPath}`;
				} else {
					text = `The file ${absPath} has been updated.`;
					if (edits.length > 1) text += ` Applied ${edits.length} edits (${result.replacements} replacement${result.replacements === 1 ? "" : "s"}).`;
					else if (edits[0].replace_all) text += ` All ${result.replacements} occurrence${result.replacements === 1 ? "" : "s"} of the string were successfully replaced.`;
					text += snippet
						? ` Here's the result of running \`cat -n\` on a snippet of the edited file:\n${snippet}`
						: " The file is now empty.";
				}
				return {
					content: [{ type: "text", text }],
					details: { filePath: absPath, created: !fileExists, replacements: result.replacements, firstChangedLine },
				};
			});
		},
	});
}

import { basename, dirname, extname, join, relative, sep } from "node:path";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { HostFileSystem } from "../host/types.js";
import type { CCContext } from "../shared/context.js";
import { FILE_CONTENT_CHANGED, FILE_MODIFIED_SINCE_READ, FileStateTracker } from "../shared/file-state.js";
import { resolveToolPath } from "../shared/paths.js";
import { isFixed } from "../shared/quirks.js";
import { FILE_STATE_CURRENT_NOTE, NOT_A_REGULAR_FILE, NotRegularFileError, readExistingText, writeText, notTextMessage } from "./write.js";

// Mirrors Claude Code 2.1.302's Edit tool (description, schema, validation order and messages).

const DESCRIPTION = `Performs exact string replacements in files.

Usage:
- You must use your \`Read\` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.
- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: line number + tab. Everything after that is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if \`old_string\` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use \`replace_all\` to change every instance of \`old_string\`.
- Use \`replace_all\` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.`;

const editSchema = Type.Object(
	{
		file_path: Type.String({ description: "The absolute path to the file to modify" }),
		old_string: Type.String({ description: "The text to replace" }),
		new_string: Type.String({ description: "The text to replace it with (must be different from old_string)" }),
		replace_all: Type.Optional(Type.Boolean({ description: "Replace all occurrences of old_string (default false)", default: false })),
	},
	{ additionalProperties: false },
);

export interface EditToolDetails {
	filePath: string;
	oldString: string;
	newString: string;
	/** File content before the edit (null when the edit created the file). */
	originalFile: string | null;
	replaceAll: boolean;
	created: boolean;
}

const MAX_EDIT_FILE_BYTES = 1024 * 1024 * 1024;
const NOT_A_NOTEBOOK_TOOL = "File is a Jupyter Notebook. Use the NotebookEdit to edit this file.";
const STALE_RECOVERED_NOTE =
	" (note: the file had been modified on disk since you last read it — the edit applied cleanly, but the file contains other changes not in your context. Read it before edits that depend on surrounding content.)";
const ESCAPE_NOTE =
	"\n(note: Edit also tried swapping \\uXXXX escapes and their characters; neither form matched, so the mismatch is likely elsewhere in old_string. Re-read the file and copy the exact surrounding text.)";
const CWD_NOTE = "Note: your current working directory is";

// ---------------------------------------------------------------------------------------------
// String matching (ported from Claude Code)
// ---------------------------------------------------------------------------------------------

const LSQ = "‘";
const RSQ = "’";
const LDQ = "“";
const RDQ = "”";
const ESCAPE_RE = /\\u[0-9a-fA-F]{4}/;
const NON_ASCII_RE = /[\u0080-￿]/;

export function normalizeQuotes(s: string): string {
	return s.replaceAll(LSQ, "'").replaceAll(RSQ, "'").replaceAll(LDQ, '"').replaceAll(RDQ, '"');
}

function decodeEscapes(s: string): string {
	return s.replace(/(\\\\)|\\u([0-9a-fA-F]{4})/g, (m, bs, hex) => (bs !== undefined ? m : String.fromCharCode(parseInt(hex, 16))));
}

function escapeRegexChar(c: string): string {
	return c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Regex source matching `s` with every non-ASCII char written as a \uXXXX escape (any hex case). */
function escapedPattern(s: string): string {
	let out = "";
	for (let i = 0; i < s.length; i++) {
		const code = s.charCodeAt(i);
		if (code >= 128) {
			out += "\\\\u";
			for (const h of code.toString(16).padStart(4, "0")) out += h >= "a" ? `[${h}${h.toUpperCase()}]` : h;
		} else out += escapeRegexChar(s[i]);
	}
	return out;
}

function escapedLength(s: string): number {
	let n = 0;
	for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) >= 128) n++;
	return s.length + 5 * n;
}

function backslashesBefore(s: string, idx: number): number {
	let n = 0;
	while (s[idx - 1 - n] === "\\") n++;
	return n;
}

/** Find `needle` in `haystack` where the haystack spells its non-ASCII chars as \uXXXX escapes. */
function findEscapedForm(needle: string, haystack: string): string | null {
	if (backslashesBefore(needle, needle.length) % 2 === 1) return null;
	const escapeOffsets = needle[0] === "\\" ? [0] : [];
	let pos = 0;
	for (let i = 0; i < needle.length; i++) {
		if (needle.charCodeAt(i) >= 128) {
			escapeOffsets.push(pos);
			pos += 6;
		} else pos += 1;
	}
	try {
		const re = new RegExp(escapedPattern(needle), "g");
		for (let m = re.exec(haystack); m !== null; m = re.exec(haystack)) {
			const at = m.index;
			if (escapeOffsets.every((o) => backslashesBefore(haystack, at + o) % 2 === 0)) return haystack.indexOf(m[0]) === at ? m[0] : null;
			re.lastIndex = at + 1;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * The string in `file` that `oldString` refers to: exact match, else the same text with curly
 * quotes, else with \uXXXX escapes decoded or applied. Null when nothing matches.
 */
export function findActualString(file: string, oldString: string): string | null {
	if (file.includes(oldString)) return oldString;
	const idx = normalizeQuotes(file).indexOf(normalizeQuotes(oldString));
	if (idx !== -1) return file.substring(idx, idx + oldString.length);
	if (ESCAPE_RE.test(oldString)) {
		const decoded = decodeEscapes(oldString);
		if (decoded !== oldString && file.includes(decoded)) return decoded;
	}
	if (NON_ASCII_RE.test(oldString)) {
		if (escapedLength(oldString) > file.length || !file.includes("\\u")) return null;
		return findEscapedForm(oldString, file);
	}
	return null;
}

function isOpeningContext(chars: string[], i: number): boolean {
	if (i === 0) return true;
	const p = chars[i - 1];
	return p === " " || p === "\t" || p === "\n" || p === "\r" || p === "(" || p === "[" || p === "{" || p === "—" || p === "–";
}

function curlDoubleQuotes(s: string): string {
	const chars = [...s];
	return chars.map((c, i) => (c === '"' ? (isOpeningContext(chars, i) ? LDQ : RDQ) : c)).join("");
}

function curlSingleQuotes(s: string): string {
	const chars = [...s];
	return chars
		.map((c, i) => {
			if (c !== "'") return c;
			const prev = i > 0 ? chars[i - 1] : undefined;
			const next = i < chars.length - 1 ? chars[i + 1] : undefined;
			if (prev !== undefined && next !== undefined && /\p{L}/u.test(prev) && /\p{L}/u.test(next)) return RSQ;
			return isOpeningContext(chars, i) ? LSQ : RSQ;
		})
		.join("");
}

/** When old_string matched only via curly-quote normalization, give new_string the file's quote style. */
export function preserveQuoteStyle(oldString: string, actualOld: string, newString: string): string {
	if (oldString === actualOld) return newString;
	const hasDouble = actualOld.includes(LDQ) || actualOld.includes(RDQ);
	const hasSingle = actualOld.includes(LSQ) || actualOld.includes(RSQ);
	if (!hasDouble && !hasSingle) return newString;
	let out = newString;
	if (hasDouble) out = curlDoubleQuotes(out);
	if (hasSingle) out = curlSingleQuotes(out);
	return out;
}

/** When old_string matched via \uXXXX escapes (either direction), spell new_string the same way. */
export function preserveEscapeStyle(oldString: string, actualOld: string, newString: string): string {
	if (oldString === actualOld) return newString;
	if (NON_ASCII_RE.test(oldString) && escapedLength(oldString) === actualOld.length && findEscapedForm(oldString, actualOld) !== null) {
		const spelled = new Map<number, string>();
		let upper = 0;
		let lower = 0;
		for (let i = 0, j = 0; i < oldString.length; i++) {
			const code = oldString.charCodeAt(i);
			if (code >= 128) {
				const hex = actualOld.slice(j + 2, j + 6);
				spelled.set(code, hex);
				for (const h of hex) {
					if (h >= "a" && h <= "f") lower++;
					else if (h >= "A" && h <= "F") upper++;
				}
				j += 6;
			} else j += 1;
		}
		return newString.replace(/[\u0080-￿]/g, (c) => {
			const code = c.charCodeAt(0);
			const known = spelled.get(code);
			if (known !== undefined) return "\\u" + known;
			const hex = code.toString(16).padStart(4, "0");
			return "\\u" + (upper > lower ? hex.toUpperCase() : hex);
		});
	}
	if (ESCAPE_RE.test(oldString) && decodeEscapes(oldString) === actualOld) return decodeEscapes(newString);
	return newString;
}

export type EditOutcome = "applies" | "ambiguous" | "no_match";

export function editOutcome(file: string, oldString: string, replaceAll: boolean): EditOutcome {
	if (oldString === "") return "no_match";
	const actual = findActualString(file, oldString);
	if (!actual) return "no_match";
	if (!replaceAll) {
		const first = file.indexOf(actual);
		if (file.indexOf(actual, first + actual.length) !== -1) return "ambiguous";
	}
	return "applies";
}

class EditApplyError extends Error {}

/** Delete every occurrence of `oldString` in one left-to-right pass, each with the newline right after it (if any). */
function deleteAllWithNewlines(content: string, oldString: string): string {
	let out = "";
	let pos = 0;
	for (let i = content.indexOf(oldString); i !== -1; i = content.indexOf(oldString, pos)) {
		out += content.slice(pos, i);
		pos = i + oldString.length;
		if (content[pos] === "\n") pos++;
	}
	return out + content.slice(pos);
}

export interface ApplyEditOptions {
	/**
	 * #19 `replaceAllTrailingMatch` fixed: a replace_all deletion removes every occurrence (and the
	 * newline after each one that has it). Claude Code only removes "old_string\n" once any such
	 * occurrence exists, so a final match without a trailing newline survives.
	 */
	deleteAllMatches?: boolean;
}

/**
 * Replace `oldString` (already resolved to the file's spelling) with `newString`. Deleting text
 * that ends a line also removes that line's newline.
 */
export function applyEdit(content: string, oldString: string, newString: string, replaceAll = false, opts: ApplyEditOptions = {}): string {
	if (oldString === "") {
		if (newString === content) throw new EditApplyError("String not found in file. Failed to apply edit.");
		return newString;
	}
	const rep = (s: string, find: string) => (replaceAll ? s.replaceAll(find, () => newString) : s.replace(find, () => newString));
	const deletesLines = newString === "" && !oldString.endsWith("\n") && content.includes(oldString + "\n");
	const updated =
		deletesLines && replaceAll && opts.deleteAllMatches
			? deleteAllWithNewlines(content, oldString)
			: deletesLines
				? rep(content, oldString + "\n")
				: rep(content, oldString);
	if (updated === content) throw new EditApplyError("String not found in file. Failed to apply edit.");
	return updated;
}

function addBomLike(original: string | null | undefined, next: string): string {
	return next !== "" && original?.charCodeAt(0) === 0xfeff && next.charCodeAt(0) !== 0xfeff ? `﻿${next}` : next;
}

// ---------------------------------------------------------------------------------------------
// "File does not exist" suggestions
// ---------------------------------------------------------------------------------------------

async function exists(fs: HostFileSystem, p: string): Promise<boolean> {
	try {
		await fs.stat(p);
		return true;
	} catch {
		return false;
	}
}

/** A path outside cwd (but under its parent) that exists when re-rooted under cwd. */
async function suggestUnderCwd(fs: HostFileSystem, absPath: string, cwd: string): Promise<string | undefined> {
	const parent = dirname(cwd);
	let p = absPath;
	try {
		p = join(await fs.realpath(dirname(absPath)), basename(absPath));
	} catch {}
	const prefix = parent === sep ? sep : parent + sep;
	if (!p.startsWith(prefix) || p.startsWith(cwd + sep) || p === cwd) return undefined;
	const candidate = join(cwd, relative(parent, p));
	return (await exists(fs, candidate)) ? candidate : undefined;
}

const EXT_RE = /^(\.[\p{L}\p{N}_+~#-]{1,32})?$/u;

/** A sibling with the same name but another extension. */
async function suggestOtherExtension(fs: HostFileSystem, absPath: string): Promise<string | undefined> {
	try {
		const dir = dirname(absPath);
		const base = basename(absPath, extname(absPath));
		const entries = (await fs.readdir(dir)).map((e) => e.name);
		return entries.find((name) => EXT_RE.test(extname(name).normalize("NFC")) && basename(name, extname(name)) === base && join(dir, name) !== absPath);
	} catch {
		return undefined;
	}
}

async function fileNotFoundMessage(fs: HostFileSystem, absPath: string, cwd: string): Promise<string> {
	let msg = `File does not exist. ${CWD_NOTE} ${cwd}.`;
	const suggestion = (await suggestUnderCwd(fs, absPath, cwd)) ?? (await suggestOtherExtension(fs, absPath));
	if (suggestion) msg += ` Did you mean ${suggestion}?`;
	return msg;
}

function formatSize(bytes: number): string {
	const units = ["bytes", "KB", "MB", "GB", "TB"];
	let n = bytes;
	let u = 0;
	while (n >= 1024 && u < units.length - 1) {
		n /= 1024;
		u++;
	}
	return u === 0 ? `${bytes} bytes` : `${Number.isInteger(n) ? n : n.toFixed(1)}${units[u]}`;
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
			const filePath = params.file_path;
			const oldString = params.old_string;
			const newStringIn = params.new_string;
			const replaceAll = params.replace_all === true;
			if (typeof filePath !== "string" || typeof oldString !== "string" || typeof newStringIn !== "string") {
				throw new Error("file_path, old_string and new_string are required strings.");
			}
			const cwd = ctx?.cwd ?? process.cwd();
			const absPath = resolveToolPath(cc, cwd, filePath);
			const contentCheck = isFixed(cc, "mtimeOnlyChangeDetection");
			const fs = cc.host.fs;

			return withFileMutationQueue(absPath, async () => {
				if (signal?.aborted) throw new Error("Operation aborted");
				// ---- validation (same order as Claude Code) ----
				if (oldString === newStringIn) throw new Error("No changes to make: old_string and new_string are exactly the same.");
				try {
					const st = await fs.stat(absPath);
					if (st.size > MAX_EDIT_FILE_BYTES) {
						throw new Error(`File is too large to edit (${formatSize(st.size)}). Maximum editable file size is ${formatSize(MAX_EDIT_FILE_BYTES)}.`);
					}
					// Claude Code fails reading such a path (after blocking on a FIFO until a writer
					// shows up); refuse it before opening it at all (#7b).
					if (!st.isFile && !st.isDirectory) throw new NotRegularFileError();
				} catch (err: any) {
					if (err?.code !== "ENOENT") throw err;
				}

				let existing: Awaited<ReturnType<typeof readExistingText>>;
				try {
					existing = await readExistingText(fs, absPath);
				} catch (err: any) {
					if (err instanceof NotRegularFileError) throw new Error(NOT_A_REGULAR_FILE);
					throw new Error(`Error calling tool (Edit): ${err?.message ?? String(err)}`);
				}
				const rec = cc.fileState.get(absPath);

				if (existing === null) {
					if (oldString !== "") throw new Error(await fileNotFoundMessage(fs, absPath, cwd));
				} else if (oldString === "") {
					if (stripBom(existing.content).trim() !== "") throw new Error("Cannot create new file - file already exists.");
				} else {
					if (absPath.endsWith(".ipynb")) throw new Error(NOT_A_NOTEBOOK_TOOL);
					const text = stripBom(existing.content);
					if (rec && (await cc.fileState.isStale(absPath, text, { contentCheck })) && editOutcome(text, oldString, replaceAll) !== "applies") {
						throw new Error(FILE_MODIFIED_SINCE_READ);
					}
					if (existing.notText) throw new Error(notTextMessage(existing.notText));
					const actual = findActualString(text, oldString);
					if (!actual) {
						const note = ESCAPE_RE.test(oldString) || NON_ASCII_RE.test(oldString) ? ESCAPE_NOTE : "";
						throw new Error(`String to replace not found in file.\nString: ${oldString}${note}`);
					}
					const matches = text.split(actual).length - 1;
					if (matches > 1 && !replaceAll) {
						throw new Error(
							`Found ${matches} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${oldString}`,
						);
					}
				}

				// ---- apply ----
				const fileExists = existing !== null;
				const content = existing?.content ?? "";
				let staleRecovered = false;
				if (fileExists && rec && (await cc.fileState.isStale(absPath, content, { contentCheck }))) {
					if (editOutcome(content, oldString, replaceAll) !== "applies") throw new Error(FILE_CONTENT_CHANGED);
					staleRecovered = true;
				}
				if (existing?.notText) throw new Error(notTextMessage(existing.notText));
				const actualOld = findActualString(content, oldString) || oldString;
				let newString = preserveEscapeStyle(oldString, actualOld, preserveQuoteStyle(oldString, actualOld, newStringIn));
				if (oldString === "") newString = addBomLike(content, newString);
				let updated: string;
				try {
					updated = applyEdit(content, actualOld, newString, replaceAll, { deleteAllMatches: isFixed(cc, "replaceAllTrailingMatch") });
				} catch (err) {
					if (err instanceof EditApplyError) throw new Error(err.message);
					throw err;
				}
				const contentNotInModelContext =
					fileExists && (!FileStateTracker.inModelContext(rec) || staleRecovered || !FileStateTracker.sameContent(rec!, content));

				if (signal?.aborted) throw new Error("Operation aborted");
				await writeText(fs, absPath, updated, existing?.encoding ?? "utf8", existing?.lineEndings ?? "LF", !fileExists);
				await cc.fileState.recordWrite(absPath, updated, { contentNotInModelContext, truncated: fileExists && rec?.truncated === true });

				const suffix = staleRecovered ? STALE_RECOVERED_NOTE : contentNotInModelContext ? "" : FILE_STATE_CURRENT_NOTE;
				const text = replaceAll
					? `The file ${filePath} has been updated. All occurrences were successfully replaced.${suffix}`
					: `The file ${filePath} has been updated successfully.${suffix}`;
				return {
					content: [{ type: "text", text }],
					details: { filePath: absPath, oldString: actualOld, newString: newStringIn, originalFile: fileExists ? content : null, replaceAll, created: !fileExists },
				};
			});
		},
	});
}

function stripBom(s: string): string {
	return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

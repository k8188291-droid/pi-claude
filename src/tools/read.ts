import { execFile } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { mkdtemp, open, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { isUtf8 } from "node:buffer";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CCContext } from "../shared/context.js";
import { resolvePath } from "../shared/paths.js";

// ---------------------------------------------------------------------------------------------
// Limits (Claude Code 2.1.x defaults)
// ---------------------------------------------------------------------------------------------

/** Advertised in the description only: Claude Code does not actually cap the number of lines. */
export const DEFAULT_READ_LIMIT = 2000;
/** A Read without `limit` refuses files larger than this (bytes). */
export const MAX_READ_SIZE_BYTES = 262144;
/** Token cap of one Read result (CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS overrides it). */
export const DEFAULT_MAX_READ_TOKENS = 25000;
/** A line-range read may select at most maxTokens * this many bytes. */
const SELECTED_BYTES_PER_TOKEN = 128;
/** Files at least this large are streamed. */
const STREAM_THRESHOLD_BYTES = 10 * 1024 * 1024;
const STREAM_CHUNK_BYTES = 524288;
const MAX_IMAGE_FILE_BYTES = 134217728;
const PDF_MAX_PAGES_PER_REQUEST = 20;
const PDF_MAX_PAGES_WITHOUT_RANGE = 10;
const PDF_MAX_WHOLE_BYTES = 20971520;
const PDF_MAX_EXTRACT_BYTES = 104857600;
const NOTEBOOK_MAX_FILE_BYTES = 104857600;
const NOTEBOOK_MAX_OUTPUT_CHARS = 10000;
/** Max base64 payload of an inline image when pi's resizer is unavailable. */
const MAX_INLINE_IMAGE_BASE64 = 5242880;

export function maxReadTokens(): number {
	const env = Number(process.env.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS);
	return Number.isFinite(env) && env > 0 ? env : DEFAULT_MAX_READ_TOKENS;
}

// ---------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------

export const WASTED_CALL_MESSAGE = "Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.";
const EMPTY_FILE_REMINDER = "<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>";
const NO_OUTPUT = "(Read completed with no output)";
const ALLOW_LARGE_HINT =
	" To read it anyway, up to what still fits in your context, call Read again with allow_large: true — only if you genuinely need all of it or the user asked for the whole file.";
const ALLOW_LARGE_NO_ROOM =
	" Even with allow_large, this is more than fits in the context you have left this turn (other large reads in the same turn share that room).";
const ALLOW_LARGE_UNAVAILABLE = " allow_large is not available where this read runs; read it in parts with offset and limit.";
const NOTEBOOK_JQ_HINT = `Use Bash with jq to read specific portions:
  cat <notebook_path> | jq '.cells[:20]' # First 20 cells
  cat <notebook_path> | jq '.cells[100:120]' # Cells 100-120
  cat <notebook_path> | jq '.cells | length' # Count total cells
  cat <notebook_path> | jq '.cells[] | select(.cell_type=="code") | .source' # All code sources`;
const NOT_TEXT_NOTES = {
	not_utf8: "is not valid UTF-8: it uses a legacy encoding such as Windows-1252, Shift-JIS or GBK, or it is binary",
	nul: "has NUL bytes in its first 8 KB: binary data, UTF-16/UTF-32 without a byte-order mark, or text with embedded NULs",
	utf16be: "is UTF-16 big-endian (it starts FE FF), which these tools cannot write",
} as const;
type NotText = keyof typeof NOT_TEXT_NOTES;

function notTextNote(kind: NotText): string {
	const extra = kind === "not_utf8" ? " Its undecodable bytes show above as U+FFFD." : "";
	return `[This file ${NOT_TEXT_NOTES[kind]}.${extra} Edit and Write will refuse it: change it with a shell command that keeps its encoding, or ask the user whether to convert it to UTF-8.]`;
}

/** Claude Code's byte formatter: "512 bytes", "1.5KB", "256KB", "1.2MB". */
export function formatBytes(n: number): string {
	const kb = n / 1024;
	if (kb < 1) return `${n} bytes`;
	const fmt = (x: number) => x.toFixed(1).replace(/\.0$/, "");
	if (kb < 1024) return `${fmt(kb)}KB`;
	const mb = kb / 1024;
	if (mb < 1024) return `${fmt(mb)}MB`;
	return `${fmt(mb / 1024)}GB`;
}

const plural = (n: number, word: string) => (n === 1 ? word : `${word}s`);

// ---------------------------------------------------------------------------------------------
// Description / schema (mirrors Claude Code's Read tool)
// ---------------------------------------------------------------------------------------------

const DESCRIPTION = `Reads a file from the local filesystem. You can access any file directly by using this tool.
Assume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- The file_path parameter must be an absolute path, not a relative path
- By default, it reads up to ${DEFAULT_READ_LIMIT} lines starting from the beginning of the file
- When you already know which part of the file you need, only read that part. This can be important for larger files.
- Results are returned using cat -n format, with line numbers starting at 1
- This tool allows Claude Code to read images (eg PNG, JPG, etc). When reading an image file the contents are presented visually as Claude Code is a multimodal LLM.
- This tool can read PDF files (.pdf). For large PDFs (more than ${PDF_MAX_PAGES_WITHOUT_RANGE} pages), you MUST provide the pages parameter to read specific page ranges (e.g., pages: "1-5"). Reading a large PDF without the pages parameter will fail. Maximum ${PDF_MAX_PAGES_PER_REQUEST} pages per request.
- This tool can read Jupyter notebooks (.ipynb files) and returns all cells with their outputs, combining code, text, and visualizations.
- This tool can only read files, not directories. To list files in a directory, use the registered shell tool.
- You will regularly be asked to read screenshots. If the user provides a path to a screenshot, ALWAYS use this tool to view the file at the path. This tool will work with all temporary file paths.
- If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents.
- Do NOT re-read a file you just edited to verify — Edit/Write would have errored if the change failed, and the harness tracks file state for you.`;

const readSchema = Type.Object(
	{
		file_path: Type.String({ description: "The absolute path to the file to read" }),
		offset: Type.Optional(
			Type.Integer({
				description: "The line number to start reading from. Only provide if the file is too large to read at once",
				minimum: 0,
				maximum: Number.MAX_SAFE_INTEGER,
			}),
		),
		limit: Type.Optional(
			Type.Integer({
				description: "The number of lines to read. Only provide if the file is too large to read at once.",
				exclusiveMinimum: 0,
				maximum: Number.MAX_SAFE_INTEGER,
			}),
		),
		pages: Type.Optional(
			Type.String({
				description: `Page range for PDF files (e.g., "1-5", "3", "10-20"). Only applicable to PDF files. Maximum ${PDF_MAX_PAGES_PER_REQUEST} pages per request.`,
			}),
		),
		allow_large: Type.Optional(
			Type.Boolean({
				description:
					"Set to true to read a text file, or a line range of one, that is over the usual size limits, up to what still fits in your context. Only use this when you genuinely need all of it or the user asked for the whole file; otherwise read it in parts with offset and limit, or search it.",
			}),
		),
	},
	{ additionalProperties: false },
);

interface ReadParams {
	file_path: string;
	offset?: number;
	limit?: number;
	pages?: string;
	allow_large?: boolean;
}

export interface ReadToolDetails {
	filePath: string;
	kind: "text" | "image" | "pdf" | "notebook" | "file_unchanged";
	/** text: first line shown (as numbered) */
	startLine?: number;
	/** text: number of lines shown */
	numLines?: number;
	/** text: total lines in file (a trailing newline counts as one more, empty line) */
	totalLines?: number;
	/** text: the result is a cut-down excerpt (token cap) */
	truncated?: boolean;
	/** pdf */
	totalPages?: number;
	pages?: [number, number];
	/** notebook */
	cells?: number;
}

type Content = TextContent | ImageContent;

/** Claude Code's Read input coercion: unwrap 1-element arrays, drop negative offsets / non-positive limits, `length` → limit. */
export function coerceReadInput(args: unknown): unknown {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
	const n: Record<string, unknown> = { ...(args as Record<string, unknown>) };
	const num = (v: unknown): number | undefined => {
		if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
		if (typeof v === "string" && /^[-+]?\d+$/.test(v.trim())) return Number(v);
		return undefined;
	};
	if (Array.isArray(n.offset) && n.offset.length === 1) n.offset = n.offset[0];
	if (Array.isArray(n.limit) && n.limit.length === 1) n.limit = n.limit[0];
	const off = num(n.offset);
	if (off !== undefined && off < 0) delete n.offset;
	const lim = num(n.limit);
	if (lim !== undefined && lim <= 0) delete n.limit;
	if ("length" in n) {
		const len = num(n.length);
		if (!("limit" in n) && len !== undefined && len > 0) n.limit = len;
		delete n.length;
	}
	delete n.description;
	// Claude Code's schema accepts numeric strings / "true" for these fields.
	for (const k of ["offset", "limit"]) {
		const v = num(n[k]);
		if (typeof n[k] === "string" && v !== undefined) n[k] = v;
	}
	if (n.allow_large === "true") n.allow_large = true;
	else if (n.allow_large === "false") n.allow_large = false;
	return n;
}

// ---------------------------------------------------------------------------------------------
// Line formatting
// ---------------------------------------------------------------------------------------------

/** Format one line like Claude Code: `<n>\t<line>` (no padding, trailing CR dropped). */
export function formatNumberedLine(lineNumber: number, line: string): string {
	return `${lineNumber}\t${line.endsWith("\r") ? line.slice(0, -1) : line}`;
}

/** Number every line of `content` (split on "\n") starting at `startLine`. */
export function addLineNumbers(content: string, startLine: number): string {
	if (!content) return "";
	return content
		.split("\n")
		.map((l, i) => formatNumberedLine(startLine + i, l))
		.join("\n");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("Operation aborted");
}

// ---------------------------------------------------------------------------------------------
// Size / token limit errors
// ---------------------------------------------------------------------------------------------

class FileTooLargeError extends Error {
	constructor(
		readonly sizeInBytes: number,
		readonly maxSizeBytes: number,
	) {
		super(
			`File content (${formatBytes(sizeInBytes)}) exceeds maximum allowed size (${formatBytes(maxSizeBytes)}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`,
		);
	}
}
class SelectedRangeTooLargeError extends Error {
	constructor(
		readonly selectedBytes: number,
		readonly maxSelectedBytes: number,
	) {
		super(
			`The requested line range contains over ${formatBytes(maxSelectedBytes)} of text, more than a read can return. Use a smaller limit — or, if a single line is this large, no limit will fit it: search for specific content instead.`,
		);
	}
}
class TokenLimitError extends Error {
	constructor(
		readonly tokenCount: number,
		readonly maxTokens: number,
	) {
		super(
			`File content (${tokenCount} tokens) exceeds maximum allowed tokens (${maxTokens}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`,
		);
	}
}

/** Context room for this read (Claude Code's contextRoom): allow_large may raise the caps up to it. */
interface Room {
	roomTokens: number | undefined;
	raised: { maxTokens: number; maxSizeBytes: number } | undefined;
}

const BYTES_PER_TOKEN = 4;

function contextRoom(ctx: ExtensionContext | undefined, maxTokens: number): Room {
	let usage: { tokens: number | null; contextWindow: number } | undefined;
	try {
		usage = (ctx as any)?.getContextUsage?.();
	} catch {
		usage = undefined;
	}
	if (!usage || !(usage.contextWindow > 0)) return { roomTokens: undefined, raised: undefined };
	// Claude Code's auto-compact threshold: window minus output reserve (≤20k) minus a 13k buffer.
	const threshold = usage.contextWindow - Math.min(20000, Math.floor(usage.contextWindow / 10)) - 13000;
	const roomTokens = Math.max(0, Math.floor((threshold - (usage.tokens ?? 0)) * 0.7));
	if (roomTokens <= maxTokens) return { roomTokens, raised: undefined };
	return { roomTokens, raised: { maxTokens: roomTokens, maxSizeBytes: Math.max(MAX_READ_SIZE_BYTES, roomTokens * BYTES_PER_TOKEN * 3) } };
}

function allowLargeSuffix(room: Room, optedIn: boolean, need: { bytes?: number; tokens?: number }): string {
	if (room.roomTokens === undefined) return optedIn ? ALLOW_LARGE_UNAVAILABLE : "";
	if (optedIn || room.raised === undefined) return ALLOW_LARGE_NO_ROOM;
	const fits = (need.bytes === undefined || need.bytes <= room.raised.maxSizeBytes) && (need.tokens === undefined || need.tokens <= room.raised.maxTokens);
	return fits ? ALLOW_LARGE_HINT : ALLOW_LARGE_NO_ROOM;
}

function withAllowLargeSuffix(err: unknown, room: () => Room, optedIn: boolean): unknown {
	if (err instanceof FileTooLargeError) return new Error(err.message + allowLargeSuffix(room(), optedIn, { bytes: err.sizeInBytes }));
	if (err instanceof SelectedRangeTooLargeError) return new Error(err.message + allowLargeSuffix(room(), optedIn, { bytes: err.selectedBytes }));
	if (err instanceof TokenLimitError) return new Error(err.message + allowLargeSuffix(room(), optedIn, { tokens: err.tokenCount }));
	return err;
}

/** Claude Code's rough token estimate: chars / 4 (chars / 2 for JSON). */
export function estimateTokens(text: string, ext: string): number {
	const per = ext === "json" || ext === "jsonl" || ext === "jsonc" ? 2 : 4;
	return Math.round(text.length / per);
}

/**
 * Token check of a read result. Claude Code asks the API for an exact count when the estimate is
 * above a quarter of the cap; pi tools have no such endpoint, so the estimate is used throughout.
 */
function checkTokens(text: string, ext: string, maxTokens: number, allowLarge: boolean): number | undefined {
	const est = estimateTokens(text, ext);
	const tokens = allowLarge && est ? Math.max(est, Math.ceil(Buffer.byteLength(text) / 2)) : est;
	if (!tokens || tokens <= maxTokens / 4) return tokens || undefined;
	if (tokens > maxTokens) throw new TokenLimitError(tokens, maxTokens);
	return tokens;
}

// ---------------------------------------------------------------------------------------------
// Text file reading (Claude Code's readFileInRange)
// ---------------------------------------------------------------------------------------------

interface TextRange {
	content: string;
	lineCount: number;
	totalLines: number;
	notText?: NotText;
	/** The raw file (not set for streamed files). */
	raw?: Buffer;
}

function decodeText(buf: Buffer): { text: string; notText?: NotText } {
	if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { text: buf.toString("utf16le") };
	let notText: NotText | undefined;
	if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) notText = "utf16be";
	else if (buf.subarray(0, 8000).includes(0)) notText = "nul";
	else if (!isUtf8(buf)) notText = "not_utf8";
	return { text: buf.toString("utf8"), notText };
}

/** Select lines [offset, offset+limit) of `text` (0-based offset). */
export function selectLines(text: string, offset: number, limit: number | undefined, maxSelectedBytes?: number): { content: string; lineCount: number; totalLines: number } {
	const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	if (offset === 0 && limit === undefined && maxSelectedBytes === undefined) {
		let content = body.includes("\r") ? body.replaceAll("\r\n", "\n") : body;
		if (content.endsWith("\r")) content = content.slice(0, -1);
		let n = 1;
		for (let i = content.indexOf("\n"); i !== -1; i = content.indexOf("\n", i + 1)) n++;
		return { content, lineCount: n, totalLines: n };
	}
	const end = limit !== undefined ? offset + limit : Infinity;
	const selected: string[] = [];
	let selectedBytes = 0;
	let index = 0;
	let pos = 0;
	const take = (line: string) => {
		if (line.endsWith("\r")) line = line.slice(0, -1);
		if (maxSelectedBytes !== undefined) {
			const next = selectedBytes + (selected.length > 0 ? 1 : 0) + Buffer.byteLength(line);
			if (next > maxSelectedBytes) throw new SelectedRangeTooLargeError(next, maxSelectedBytes);
			selectedBytes = next;
		}
		selected.push(line);
	};
	for (let nl = body.indexOf("\n", pos); nl !== -1; nl = body.indexOf("\n", pos)) {
		if (index >= offset && index < end) take(body.slice(pos, nl));
		index++;
		pos = nl + 1;
	}
	if (index >= offset && index < end) take(body.slice(pos));
	index++;
	return { content: selected.join("\n"), lineCount: selected.length, totalLines: index };
}

/** Streaming variant for large files (UTF-8 only, like Claude Code). */
async function streamLines(
	absPath: string,
	offset: number,
	limit: number | undefined,
	maxBytes: number | undefined,
	maxSelectedBytes: number | undefined,
	signal?: AbortSignal,
): Promise<TextRange> {
	const end = limit !== undefined ? offset + limit : Infinity;
	const selected: string[] = [];
	let selectedBytes = 0;
	let index = 0;
	let total = 0;
	let partial = "";
	let first = true;
	const decoder = new TextDecoder("utf-8");
	const take = (line: string) => {
		if (line.endsWith("\r")) line = line.slice(0, -1);
		if (maxSelectedBytes !== undefined) {
			const next = selectedBytes + (selected.length > 0 ? 1 : 0) + Buffer.byteLength(line);
			if (next > maxSelectedBytes) throw new SelectedRangeTooLargeError(next, maxSelectedBytes);
			selectedBytes = next;
		}
		selected.push(line);
	};
	const stream = createReadStream(absPath, { highWaterMark: STREAM_CHUNK_BYTES, signal });
	try {
		for await (const chunk of stream as AsyncIterable<Buffer>) {
			let s = decoder.decode(chunk, { stream: true });
			if (first) {
				first = false;
				if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
			}
			total += Buffer.byteLength(s);
			if (maxBytes !== undefined && total > maxBytes) throw new FileTooLargeError(total, maxBytes);
			s = partial + s;
			let pos = 0;
			for (let nl = s.indexOf("\n", pos); nl !== -1; nl = s.indexOf("\n", pos)) {
				if (index >= offset && index < end) take(s.slice(pos, nl));
				index++;
				pos = nl + 1;
			}
			partial = s.slice(pos);
		}
	} finally {
		stream.destroy();
	}
	partial += decoder.decode();
	if (index >= offset && index < end) take(partial);
	index++;
	return { content: selected.join("\n"), lineCount: selected.length, totalLines: index };
}

async function readTextRange(
	absPath: string,
	size: number,
	offset: number,
	limit: number | undefined,
	maxBytes: number | undefined,
	maxSelectedBytes: number | undefined,
	signal?: AbortSignal,
): Promise<TextRange> {
	if (maxSelectedBytes !== undefined && size <= maxSelectedBytes) maxSelectedBytes = undefined;
	if (size >= STREAM_THRESHOLD_BYTES) return streamLines(absPath, offset, limit, maxBytes, maxSelectedBytes, signal);
	if (maxBytes !== undefined && size > maxBytes) throw new FileTooLargeError(size, maxBytes);
	const buf = await readFile(absPath, { signal });
	if (maxBytes !== undefined && buf.length > maxBytes) throw new FileTooLargeError(buf.length, maxBytes);
	const { text, notText } = decodeText(buf);
	return { ...selectLines(text, offset, limit, maxSelectedBytes), notText, raw: buf };
}

/** Cut a too-large whole-file read down to what fits the token cap (Claude Code's paged view). */
function pageDown(content: string, tokenCount: number, maxTokens: number): { text: string; lines: number; byChars: boolean } {
	const lines = content.split("\n");
	const charsPerToken = Math.max(0.5, content.length / Math.max(1, tokenCount));
	const tokensOf = (s: string) => s.length / charsPerToken;
	let n = Math.max(1, Math.min(lines.length, Math.floor(((lines.length * maxTokens) / Math.max(1, tokenCount)) * 0.85)));
	let text = lines.slice(0, n).join("\n");
	for (let i = 0; i < 6; i++) {
		if (tokensOf(text) <= maxTokens || n <= 1) break;
		n = Math.max(1, Math.floor(n * 0.7));
		text = lines.slice(0, n).join("\n");
	}
	if (tokensOf(text) > maxTokens || text.trim() === "") {
		let chars = Math.max(1, Math.floor(maxTokens * charsPerToken * 0.85));
		for (let i = 0; i < 6; i++) {
			text = content.slice(0, chars);
			if (tokensOf(text) <= maxTokens) break;
			chars = Math.max(1, Math.floor(chars * 0.7));
		}
		const last = text.charCodeAt(text.length - 1);
		if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
		return { text, lines: text.split("\n").length, byChars: true };
	}
	return { text, lines: n, byChars: false };
}

function escapeForReminder(s: string): string {
	return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function readTextFile(
	cc: CCContext,
	ctx: ExtensionContext | undefined,
	absPath: string,
	size: number,
	params: { offset: number; limit: number | undefined; allowLarge: boolean },
	signal?: AbortSignal,
): Promise<AgentToolResult<ReadToolDetails>> {
	const ext = extname(absPath).toLowerCase().slice(1);
	const baseMaxTokens = maxReadTokens();
	const room = () => contextRoom(ctx, baseMaxTokens);
	const optIn = params.allowLarge ? room() : undefined;
	const maxBytes = optIn?.raised?.maxSizeBytes ?? MAX_READ_SIZE_BYTES;
	const maxTokens = optIn?.raised?.maxTokens ?? baseMaxTokens;
	const { offset, limit } = params;
	const startIndex = offset === 0 ? 0 : offset - 1;
	const wholeFile = offset <= 1 && limit === undefined;

	let range: TextRange;
	try {
		range = await readTextRange(
			absPath,
			size,
			startIndex,
			limit,
			limit === undefined ? maxBytes : undefined,
			limit === undefined ? undefined : Math.max(baseMaxTokens * SELECTED_BYTES_PER_TOKEN, optIn?.raised?.maxSizeBytes ?? 0),
			signal,
		);
	} catch (err) {
		throw withAllowLargeSuffix(err, room, params.allowLarge);
	}
	throwIfAborted(signal);

	let content = range.content;
	let numLines = range.lineCount;
	let recordedLimit = limit;
	let banner: string | undefined;
	try {
		const checked = optIn?.raised ? addLineNumbers(content, Math.max(1, offset)) : content;
		const tokens = checkTokens(checked, ext, maxTokens, optIn?.raised !== undefined);
		if (optIn?.raised && tokens !== undefined) {
			const cap = room().raised?.maxTokens ?? baseMaxTokens;
			if (tokens > cap) throw new TokenLimitError(tokens, cap);
		}
	} catch (err) {
		if (!(err instanceof TokenLimitError) || !wholeFile) throw withAllowLargeSuffix(err, room, params.allowLarge);
		const hint = allowLargeSuffix(room(), params.allowLarge, { tokens: err.tokenCount });
		const capNote = optIn?.raised && err.maxTokens > baseMaxTokens ? `allow_large had room for ${err.maxTokens} tokens this turn` : `cap ${baseMaxTokens}`;
		const full = content;
		const paged = pageDown(full, err.tokenCount, baseMaxTokens);
		content = paged.text;
		numLines = paged.lines;
		recordedLimit = numLines;
		banner =
			!paged.byChars && numLines < range.totalLines
				? `[Truncated: PARTIAL view — ${absPath}: showing lines 1-${numLines} of ${range.totalLines} total (${err.tokenCount} tokens, ${capNote}). Call Read with offset=${numLines + 1} limit=${numLines} for the next page, or Grep to find a specific section.${hint} Do NOT answer from this page alone if the answer may be further in the file.]`
				: `[Truncated: PARTIAL view — ${absPath}: showing the first ${content.length} of ${full.length} characters (${err.tokenCount} tokens, ${capNote}); this file has very long lines and cannot be paginated by line. Use Grep to find a specific section, or Read with offset/limit to page through it.${hint} Do NOT answer from this excerpt alone if the answer may be elsewhere in the file.]`;
	}

	const startLine = banner !== undefined ? Math.max(1, offset) : offset;
	const partial = banner !== undefined || startIndex > 0 || numLines < range.totalLines;
	try {
		cc.fileState.recordRead(absPath, range.raw ?? (await readFile(absPath)), { partial, truncated: banner !== undefined, offset, limit: recordedLimit });
	} catch {
		// the file vanished between reading and recording: nothing to track
	}

	let text: string;
	if (content) text = addLineNumbers(content, startLine);
	else if (numLines >= 1 && range.totalLines > 1) text = formatNumberedLine(startLine, "");
	else if (numLines >= 1 || range.totalLines === 0) text = EMPTY_FILE_REMINDER;
	else
		text = `<system-reminder>Warning: the file exists but is shorter than the provided offset (${startLine}). The file has ${range.totalLines} lines.</system-reminder>`;
	if (range.notText) text += `\n\n${notTextNote(range.notText)}`;
	// Claude Code sends the truncation banner as a separate system reminder after the tool result.
	if (banner !== undefined) text += `\n\n<system-reminder>\n${escapeForReminder(banner)}\n</system-reminder>`;
	return {
		content: [{ type: "text", text }],
		details: { filePath: absPath, kind: "text", startLine, numLines, totalLines: range.totalLines, truncated: banner !== undefined },
	};
}

// ---------------------------------------------------------------------------------------------
// Image support
// ---------------------------------------------------------------------------------------------

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

export function sniffImageMimeType(buf: Buffer): string | undefined {
	if (buf.length < 4) return undefined;
	if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
	if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
	if (buf.length >= 6 && buf.toString("latin1", 0, 4) === "GIF8" && (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61) return "image/gif";
	if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "image/webp";
	return undefined;
}

/** What a file that should be an image actually looks like (for the error message). */
function describeBytes(buf: Buffer): string {
	const head = buf.subarray(0, 32);
	const ascii = head.toString("latin1").replace(/[^\x20-\x7e]/g, ".");
	const lower = ascii.toLowerCase();
	if (lower.includes("<!doctype") || lower.includes("<html")) return `HTML document (starts with "${ascii.slice(0, 24)}")`;
	if (lower.startsWith("<?xml") || lower.startsWith("<svg")) return `XML/SVG document (starts with "${ascii.slice(0, 24)}")`;
	if (lower.startsWith("{") || lower.startsWith("[")) return `JSON/text (starts with "${ascii.slice(0, 24)}")`;
	if (head.subarray(0, 4).toString("latin1").toLowerCase() === "%pdf") return "PDF document";
	if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 3 && head[3] === 4) return "ZIP archive (Office documents such as .pptx/.docx/.xlsx are ZIPs)";
	return `unrecognized bytes (hex: ${head.subarray(0, 8).toString("hex").replace(/(..)/g, "$1 ").trim()})`;
}

interface ResizedImage {
	data: string;
	mimeType: string;
	originalWidth: number;
	originalHeight: number;
	width: number;
	height: number;
	wasResized: boolean;
}
interface PiImageResizeModule {
	resizeImage?: (img: ImageContent) => Promise<ResizedImage | null>;
}

let resizeModulePromise: Promise<PiImageResizeModule> | undefined;

/**
 * pi's image resizer (Photon/WASM, same one pi's built-in read tool uses) is internal (not in the
 * package "exports"), so load it by file URL relative to the resolved package. Falls back to
 * "no resizing" if that fails.
 */
function loadPiImageResize(): Promise<PiImageResizeModule> {
	resizeModulePromise ??= (async () => {
		const candidates: string[] = [];
		try {
			const indexUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
			candidates.push(new URL("./utils/image-resize.js", indexUrl).href);
		} catch {
			// ignore
		}
		const starts = [process.cwd()];
		try {
			starts.push(dirname(fileURLToPath(import.meta.url)));
		} catch {
			// ignore
		}
		for (const start of starts) {
			let dir = start;
			for (let i = 0; i < 10; i++) {
				const p = join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "utils", "image-resize.js");
				if (existsSync(p)) candidates.push(pathToFileURL(p).href);
				const parent = dirname(dir);
				if (parent === dir) break;
				dir = parent;
			}
		}
		for (const href of candidates) {
			try {
				const mod = await import(href);
				if (typeof mod.resizeImage === "function") return mod as PiImageResizeModule;
			} catch {
				// try next
			}
		}
		return {};
	})();
	return resizeModulePromise;
}

/** Prepare an image for inline use: resize via pi if possible, else pass through if small enough. */
export async function prepareImage(buffer: Buffer, mimeType: string): Promise<{ image?: ImageContent; note?: string }> {
	const base64 = buffer.toString("base64");
	const { resizeImage } = await loadPiImageResize();
	if (resizeImage) {
		try {
			const r = await resizeImage({ type: "image", data: base64, mimeType });
			if (r) {
				const resized = r.originalWidth !== r.width || r.originalHeight !== r.height;
				return {
					image: { type: "image", data: r.data, mimeType: r.mimeType },
					note:
						resized && r.width > 0 && r.height > 0
							? `[Image: original ${r.originalWidth}x${r.originalHeight}, displayed at ${r.width}x${r.height}. Multiply coordinates by ${(r.originalWidth / r.width).toFixed(2)} to map to original image.]`
							: undefined,
				};
			}
		} catch {
			// fall through to raw handling
		}
	}
	if (base64.length <= MAX_INLINE_IMAGE_BASE64) return { image: { type: "image", data: base64, mimeType } };
	return { note: "[Image omitted: could not be resized below the inline image size limit.]" };
}

async function readImage(absPath: string, size: number): Promise<AgentToolResult<ReadToolDetails>> {
	if (size > MAX_IMAGE_FILE_BYTES) {
		throw new Error(
			`File is too large to read as an image (the limit is ${formatBytes(MAX_IMAGE_FILE_BYTES)}): ${absPath}. If it is an image, resize it or export a smaller copy, then read that.`,
		);
	}
	const buffer = await readFile(absPath);
	if (buffer.length === 0) throw new Error(`Image file is empty: ${absPath}`);
	const mime = sniffImageMimeType(buffer);
	if (!mime) {
		throw new Error(
			`File has an image extension but its content is not a valid PNG/JPEG/GIF/WebP. Detected: ${describeBytes(buffer)}. This usually means a download saved an error/login page instead of the image. Use \`file "${absPath}"\` to confirm, or read it as text with Bash (e.g. \`head -c 500\`).`,
		);
	}
	const { image, note } = await prepareImage(buffer, mime);
	// Claude Code's tool result is the image alone; the resize note follows as a separate message.
	const content: Content[] = [];
	if (image) content.push(image);
	if (note) content.push({ type: "text", text: note });
	return { content, details: { filePath: absPath, kind: "image" } };
}

// ---------------------------------------------------------------------------------------------
// PDF support (poppler-utils: pdfinfo / pdftoppm / pdftotext)
// ---------------------------------------------------------------------------------------------

function run(cmd: string, args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, { signal, maxBuffer: 64 * 1024 * 1024, encoding: "utf8", timeout: 120000 }, (err, stdout, stderr) => {
			if (err) {
				(err as any).stderr = stderr;
				reject(err);
			} else resolve({ stdout, stderr });
		});
	});
}

/** Parse "3" or "1-5" ("4-" is open-ended: lastPage = Infinity). Returns null when invalid. */
export function parsePageRange(pages: string): { firstPage: number; lastPage: number } | null {
	const m = /^(\d{1,9})(?:\s*(-)\s*(\d{1,9})?)?$/.exec(pages.trim());
	if (!m) return null;
	const first = Number(m[1]);
	const last = m[3] ? Number(m[3]) : m[2] ? Infinity : first;
	if (first < 1 || last < first) return null;
	return { firstPage: first, lastPage: last };
}

/** Validate the pages parameter like Claude Code (also for non-PDF files). Returns an error message. */
export function validatePages(pages: string): string | undefined {
	const r = parsePageRange(pages);
	if (!r) {
		return `Invalid pages parameter: "${pages}". Give one page ("3") or one range ("1-5"), not a list. To read several pages or ranges, read each one separately. Pages are 1-indexed.`;
	}
	const count = r.lastPage === Infinity ? PDF_MAX_PAGES_PER_REQUEST + 1 : r.lastPage - r.firstPage + 1;
	if (count > PDF_MAX_PAGES_PER_REQUEST) return `Page range "${pages}" exceeds maximum of ${PDF_MAX_PAGES_PER_REQUEST} pages per request. Please use a smaller range.`;
	return undefined;
}

async function pdfPageCount(absPath: string, signal?: AbortSignal): Promise<number | undefined> {
	try {
		const { stdout } = await run("pdfinfo", [absPath], signal);
		const m = /^Pages:\s+(\d+)/m.exec(stdout);
		return m ? Number(m[1]) : undefined;
	} catch (err: any) {
		if (err?.name === "AbortError") throw new Error("Operation aborted");
		return undefined;
	}
}

const PDFTOPPM_MISSING =
	"pdftoppm is not installed. Install poppler-utils (e.g. `brew install poppler` or `apt-get install poppler-utils`) to enable PDF page rendering.";

/** Render pages as JPEGs (pdftoppm -jpeg -r 100) and return them in page order. */
async function renderPdfPages(absPath: string, size: number, range: { firstPage: number; lastPage: number } | undefined, signal?: AbortSignal): Promise<Buffer[]> {
	if (size === 0) throw new Error(`PDF file is empty: ${absPath}`);
	if (size > PDF_MAX_EXTRACT_BYTES) throw new Error(`PDF file exceeds maximum allowed size for text extraction (${formatBytes(PDF_MAX_EXTRACT_BYTES)}).`);
	const tmp = await mkdtemp(join(tmpdir(), "pi-cc-pdf-"));
	try {
		const args = ["-jpeg", "-r", "100"];
		if (range?.firstPage) args.push("-f", String(range.firstPage));
		if (range?.lastPage && range.lastPage !== Infinity) args.push("-l", String(range.lastPage));
		args.push(absPath, join(tmp, "page"));
		try {
			await run("pdftoppm", args, signal);
		} catch (err: any) {
			if (err?.code === "ENOENT") throw new Error(PDFTOPPM_MISSING);
			if (err?.name === "AbortError" || signal?.aborted) throw new Error("Operation aborted");
			const stderr = String(err?.stderr ?? "");
			if (/password/i.test(stderr)) throw new Error("PDF is password-protected. Please provide an unprotected version.");
			const wrong = /Wrong page range given.*last page \((\d+)\)/i.exec(stderr);
			if (wrong && range) {
				const total = Number(wrong[1]);
				if (total === 0) throw new Error("PDF reports 0 pages (empty page tree). The PDF may be invalid.");
				const what =
					range.lastPage === Infinity
						? `pages ${range.firstPage}-`
						: range.firstPage === range.lastPage
							? `page ${range.firstPage}`
							: `pages ${range.firstPage}-${range.lastPage}`;
				throw new Error(
					`Requested ${what} is outside the document (PDF has ${total} ${plural(total, "page")}). Use a range within 1-${total}, maximum ${PDF_MAX_PAGES_PER_REQUEST} pages per request (e.g. pages: "1-${Math.min(total, PDF_MAX_PAGES_PER_REQUEST)}").`,
				);
			}
			if (/damaged|corrupt|invalid|Couldn't (find trailer dictionary|read xref table)/i.test(stderr)) {
				throw new Error("PDF file is corrupted or invalid.");
			}
			throw new Error(`pdftoppm failed: ${stderr.trim() || err?.message || String(err)}`);
		}
		const files = (await readdir(tmp)).filter((f) => f.endsWith(".jpg")).sort();
		if (files.length === 0) throw new Error("pdftoppm produced no output pages. The PDF may be invalid.");
		return await Promise.all(files.map((f) => readFile(join(tmp, f))));
	} finally {
		await rm(tmp, { recursive: true, force: true }).catch(() => {});
	}
}

async function pageImages(jpegs: Buffer[], firstPage: number): Promise<Content[]> {
	const out: Content[] = [];
	for (let i = 0; i < jpegs.length; i++) {
		const { image, note } = await prepareImage(jpegs[i], "image/jpeg");
		if (image) out.push(image);
		else out.push({ type: "text", text: `[Page ${firstPage + i} could not be processed as an image${note ? `: ${note}` : ""}]` });
	}
	return out;
}

async function readPdf(absPath: string, size: number, pages: string | undefined, signal?: AbortSignal): Promise<AgentToolResult<ReadToolDetails>> {
	if (pages !== undefined) {
		const error = validatePages(pages);
		if (error) throw new Error(error);
		const range = parsePageRange(pages)!;
		const jpegs = await renderPdfPages(absPath, size, range, signal);
		const content: Content[] = [{ type: "text", text: `PDF pages extracted: ${jpegs.length} page(s) from ${absPath} (${formatBytes(size)})` }];
		content.push(...(await pageImages(jpegs, range.firstPage)));
		return { content, details: { filePath: absPath, kind: "pdf", pages: [range.firstPage, range.firstPage + jpegs.length - 1] } };
	}

	const totalPages = await pdfPageCount(absPath, signal);
	if (totalPages !== undefined && totalPages > PDF_MAX_PAGES_WITHOUT_RANGE) {
		throw new Error(
			`This PDF has ${totalPages} pages, which is too many to read at once. Use the pages parameter to read specific page ranges (e.g., pages: "1-5"). Maximum ${PDF_MAX_PAGES_PER_REQUEST} pages per request.`,
		);
	}
	if (size === 0) throw new Error(`PDF file is empty: ${absPath}`);
	if (size > PDF_MAX_WHOLE_BYTES) throw new Error(`PDF file exceeds maximum allowed size of ${formatBytes(PDF_MAX_WHOLE_BYTES)}.`);
	const fh = await open(absPath, "r");
	try {
		const head = Buffer.alloc(5);
		await fh.read(head, 0, 5, 0);
		if (!head.toString("ascii").startsWith("%PDF-")) throw new Error(`File is not a valid PDF (missing %PDF- header): ${absPath}`);
	} finally {
		await fh.close();
	}
	// Claude Code attaches the PDF itself as a document block; pi tool results carry text and images
	// only, so the pages are attached as rendered images (falling back to extracted text).
	const content: Content[] = [{ type: "text", text: `PDF file read: ${absPath} (${formatBytes(size)})` }];
	try {
		content.push(...(await pageImages(await renderPdfPages(absPath, size, undefined, signal), 1)));
	} catch (err: any) {
		if (signal?.aborted) throw new Error("Operation aborted");
		try {
			const { stdout } = await run("pdftotext", ["-layout", "-enc", "UTF-8", absPath, "-"], signal);
			const pageTexts = stdout.split("\f");
			if (pageTexts.length > 1 && pageTexts[pageTexts.length - 1].trim() === "") pageTexts.pop();
			content.push({ type: "text", text: pageTexts.map((t, i) => `<page number="${i + 1}">\n${t.replace(/\s+$/, "")}\n</page>`).join("\n") });
		} catch {
			throw err instanceof Error ? err : new Error(String(err));
		}
	}
	return { content, details: { filePath: absPath, kind: "pdf", totalPages } };
}

// ---------------------------------------------------------------------------------------------
// Jupyter notebooks
// ---------------------------------------------------------------------------------------------

interface NotebookOutput {
	output_type: string;
	text: string;
	image?: { image_data: string; media_type: string };
}
interface NotebookCell {
	cellType: string;
	source: string;
	execution_count?: unknown;
	cell_id: string;
	language?: string;
	outputs?: NotebookOutput[];
}

const joinSource = (src: unknown): string => (Array.isArray(src) ? src.join("") : typeof src === "string" ? src : "");

function isValidNotebook(nb: any): boolean {
	const cells = nb?.cells;
	return (
		Array.isArray(cells) &&
		!cells.some((c: any) => c === null || typeof c !== "object" || (typeof c.source !== "string" && !(Array.isArray(c.source) && c.source.every((s: unknown) => typeof s === "string"))))
	);
}

function notebookImage(data: Record<string, unknown>): NotebookOutput["image"] {
	for (const mime of ["image/png", "image/jpeg"]) {
		const raw = data[mime];
		if (typeof raw !== "string") continue;
		const b64 = raw.replace(/\s/g, "");
		if (!sniffImageMimeType(Buffer.from(b64, "base64"))) return undefined;
		return { image_data: b64, media_type: mime };
	}
	return undefined;
}

function processOutput(out: any): NotebookOutput | undefined {
	switch (out?.output_type) {
		case "stream":
			return { output_type: out.output_type, text: joinSource(out.text) };
		case "execute_result":
		case "display_data": {
			const data = out.data && typeof out.data === "object" ? out.data : undefined;
			return { output_type: out.output_type, text: joinSource(data?.["text/plain"]), image: data ? notebookImage(data) : undefined };
		}
		case "error":
			return {
				output_type: out.output_type,
				text: `${out.ename}: ${out.evalue}\n${Array.isArray(out.traceback) ? out.traceback.join("\n") : ""}`,
			};
		default:
			return undefined;
	}
}

function processCell(cell: any, index: number, language: string): NotebookCell {
	const id = cell.id ?? `cell-${index}`;
	const out: NotebookCell = {
		cellType: cell.cell_type,
		source: joinSource(cell.source),
		execution_count: cell.cell_type === "code" ? cell.execution_count || undefined : undefined,
		cell_id: id,
	};
	if (cell.cell_type === "code") out.language = language;
	if (cell.cell_type === "code" && Array.isArray(cell.outputs) && cell.outputs.length > 0) {
		const outputs = cell.outputs.map(processOutput).filter((o: NotebookOutput | undefined): o is NotebookOutput => o !== undefined);
		let total = 0;
		const tooLarge = outputs.some((o: NotebookOutput) => {
			total += o.text.length + (o.image?.image_data.length ?? 0);
			return total > NOTEBOOK_MAX_OUTPUT_CHARS;
		});
		out.outputs = tooLarge
			? [{ output_type: "stream", text: `Outputs are too large to include. Use Bash with: cat <notebook_path> | jq '.cells[${index}].outputs'` }]
			: outputs;
	}
	return out;
}

/** Bun/JavaScriptCore-style JSON.parse messages (what Claude Code reports), from V8's. */
function jscJsonError(err: unknown): string {
	const msg = err instanceof Error ? err.message : String(err);
	if (/Unexpected end of JSON input/.test(msg)) return "JSON Parse error: Unexpected EOF";
	if (/Expected property name or '}'/.test(msg)) return "JSON Parse error: Expected '}'";
	const tok = /Unexpected token '?(.)'?/.exec(msg);
	if (tok) return `JSON Parse error: Unrecognized token '${tok[1]}'`;
	return msg;
}

async function readNotebook(absPath: string, size: number): Promise<{ result: AgentToolResult<ReadToolDetails>; raw: Buffer }> {
	if (size > NOTEBOOK_MAX_FILE_BYTES) {
		throw new Error(`Notebook file exceeds the maximum size this tool can read (${formatBytes(NOTEBOOK_MAX_FILE_BYTES)}). ${NOTEBOOK_JQ_HINT}`);
	}
	const raw = await readFile(absPath);
	let nb: any;
	try {
		nb = JSON.parse(raw.toString("utf8"));
	} catch (err) {
		throw new Error(`Notebook file is not valid JSON (it may be truncated, corrupted, or still being written): ${jscJsonError(err)}`);
	}
	if (!isValidNotebook(nb)) {
		throw new Error('Notebook file is not a valid Jupyter notebook (top-level "cells" must be an array of cell objects, each with a string or string-array "source").');
	}
	const language: string = nb.metadata?.language_info?.name ?? "python";
	const cells: NotebookCell[] = nb.cells.map((c: any, i: number) => processCell(c, i, language));

	const json = JSON.stringify(cells);
	const bytes = Buffer.byteLength(json);
	if (bytes > MAX_READ_SIZE_BYTES) {
		throw new Error(`Notebook content (${formatBytes(bytes)}) exceeds maximum allowed size (${formatBytes(MAX_READ_SIZE_BYTES)}). ${NOTEBOOK_JQ_HINT}`);
	}
	checkTokens(json, "ipynb", maxReadTokens(), false);

	const blocks: Content[] = [];
	const push = (b: Content) => {
		const last = blocks.at(-1);
		if (last && last.type === "text" && b.type === "text") last.text += `\n${b.text}`;
		else blocks.push(b);
	};
	for (const cell of cells) {
		let meta = "";
		if (cell.cellType !== "code") meta += `<cell_type>${cell.cellType}</cell_type>`;
		if (cell.language !== "python" && cell.cellType === "code") meta += `<language>${cell.language}</language>`;
		push({ type: "text", text: `<cell id="${cell.cell_id}">${meta}${cell.source}</cell id="${cell.cell_id}">` });
		for (const o of cell.outputs ?? []) {
			if (o.text) push({ type: "text", text: `\n${o.text}` });
			if (o.image) push({ type: "image", data: o.image.image_data, mimeType: o.image.media_type });
		}
	}
	if (blocks.length === 0) blocks.push({ type: "text", text: NO_OUTPUT });
	return { result: { content: blocks, details: { filePath: absPath, kind: "notebook", cells: cells.length } }, raw };
}

// ---------------------------------------------------------------------------------------------
// Validation and missing files
// ---------------------------------------------------------------------------------------------

const BINARY_EXTENSIONS = new Set(
	".png .jpg .jpeg .gif .bmp .ico .webp .tiff .tif .heic .heif .avif .mp4 .mov .avi .mkv .webm .wmv .flv .m4v .mpeg .mpg .mp3 .wav .ogg .flac .aac .m4a .wma .aiff .opus .zip .tar .gz .bz2 .7z .rar .xz .z .tgz .iso .zst .lz4 .whl .exe .dll .so .dylib .bin .o .a .obj .lib .app .msi .deb .rpm .dmg .apk .pdf .doc .docx .docm .dotx .dotm .xls .xlsx .xlsm .xlsb .xltx .xltm .ppt .pptx .pptm .ppsx .ppsm .potx .potm .odt .ods .odp .numbers .epub .ttf .otf .woff .woff2 .eot .pyc .pyo .class .jar .war .ear .node .wasm .rlib .sqlite .sqlite3 .db .mdb .idx .parquet .feather .npy .npz .pickle .psd .ai .eps .sketch .fig .xd .blend .3ds .max .swf .fla .lockb .dat .data".split(
		" ",
	),
);

function hasBinaryExtension(absPath: string): boolean {
	const ext = absPath.slice(absPath.lastIndexOf(".")).toLowerCase();
	if (!BINARY_EXTENSIONS.has(ext)) return false;
	const plain = extname(absPath).toLowerCase().slice(1);
	return !(IMAGE_EXTENSIONS.has(plain) || plain === "pdf");
}

const BLOCKING_DEVICES = new Set([
	"/dev/zero",
	"/dev/random",
	"/dev/urandom",
	"/dev/full",
	"/dev/stdin",
	"/dev/tty",
	"/dev/console",
	"/dev/stdout",
	"/dev/stderr",
	"/dev/fd/0",
	"/dev/fd/1",
	"/dev/fd/2",
]);

function isBlockingDevice(p: string): boolean {
	if (BLOCKING_DEVICES.has(p)) return true;
	if (p.startsWith("/proc/") && (p.endsWith("/fd/0") || p.endsWith("/fd/1") || p.endsWith("/fd/2"))) return true;
	return /^\/proc\/[^/]+\/(environ|cmdline|auxv|maps|mem|stat)$/.test(p);
}

/** A sibling with the same name but another (or no) extension. */
async function findSimilarFile(absPath: string): Promise<string | undefined> {
	const dir = dirname(absPath);
	const stem = basename(absPath, extname(absPath));
	try {
		const entries = await readdir(dir);
		return entries.find((name) => /^(\.[\p{L}\p{N}_+~#-]{1,32})?$/u.test(extname(name).normalize("NFC")) && basename(name, extname(name)) === stem && join(dir, name) !== absPath);
	} catch {
		return undefined;
	}
}

/** A path under cwd's parent but outside cwd whose cwd-relative twin exists. */
async function findUnderCwd(absPath: string, cwd: string): Promise<string | undefined> {
	const parent = dirname(cwd);
	let p = absPath;
	try {
		p = join(await realpath(dirname(absPath)), basename(absPath));
	} catch {
		// keep as is
	}
	const prefix = parent === sep ? sep : parent + sep;
	if (!p.startsWith(prefix) || p.startsWith(cwd + sep) || p === cwd) return undefined;
	const candidate = join(cwd, relative(parent, p));
	try {
		await stat(candidate);
		return candidate;
	} catch {
		return undefined;
	}
}

async function missingFileError(absPath: string, cwd: string): Promise<Error> {
	let msg = `File does not exist. Note: your current working directory is ${cwd}.`;
	const inCwd = await findUnderCwd(absPath, cwd);
	const similar = inCwd ? undefined : await findSimilarFile(absPath);
	if (inCwd) msg += ` Did you mean ${inCwd}?`;
	else if (similar) msg += ` Did you mean ${similar}?`;
	return new Error(msg);
}

/** macOS screenshot names use U+202F (narrow no-break space) before AM/PM; models usually type a plain space. */
function alternateScreenshotPath(absPath: string): string | undefined {
	const base = basename(absPath);
	const alt = base.replace(/ (AM|PM)(\.[A-Za-z0-9]+)$/, " $1$2");
	if (alt === base) return undefined;
	return join(dirname(absPath), alt);
}

// ---------------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------------

export function registerRead(pi: ExtensionAPI, cc: CCContext): void {
	pi.registerTool({
		name: "Read",
		label: "Read",
		description: DESCRIPTION,
		promptSnippet: "Read files (text, images, PDFs, Jupyter notebooks)",
		parameters: readSchema,
		prepareArguments: (args: unknown) => coerceReadInput(args) as ReadParams,
		async execute(_toolCallId, rawParams, signal, _onUpdate, ctx): Promise<AgentToolResult<ReadToolDetails>> {
			throwIfAborted(signal);
			const params = rawParams as ReadParams;
			if (typeof params.file_path !== "string") throw new Error("file_path is required.");
			const cwd = ctx?.cwd ?? process.cwd();

			// validateInput (same order as Claude Code)
			if (params.pages !== undefined) {
				const error = validatePages(params.pages);
				if (error) throw new Error(error);
			}
			let absPath = resolvePath(cwd, params.file_path);
			if (hasBinaryExtension(absPath)) {
				throw new Error(
					`This tool cannot read binary files. The file appears to be a binary ${extname(absPath).toLowerCase()} file. Use a skill for this file type if one is available, or a shell command or script that can read the format.`,
				);
			}
			if (isBlockingDevice(absPath)) throw new Error(`Cannot read '${params.file_path}': this device file would block or produce infinite output.`);

			const ext = extname(absPath).toLowerCase().slice(1);
			const isNotebook = ext === "ipynb";
			let offset = params.offset ?? 1;
			let limit = params.limit;
			if (isNotebook) {
				offset = 1;
				limit = undefined;
			}

			// Unchanged since the last Read of the same range: point back to that result.
			const rec = cc.fileState.get(absPath);
			if (rec && rec.source === "read" && !rec.truncated && !rec.contentNotInModelContext && rec.offset !== undefined && rec.offset === offset && rec.limit === limit) {
				try {
					const st = await stat(absPath);
					if (Math.floor(st.mtimeMs) === rec.timestamp) {
						return { content: [{ type: "text", text: WASTED_CALL_MESSAGE }], details: { filePath: absPath, kind: "file_unchanged" } };
					}
				} catch {
					// fall through to a normal read
				}
			}

			let st;
			try {
				st = await stat(absPath);
			} catch (err: any) {
				if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") throw err;
				const alt = alternateScreenshotPath(absPath);
				if (alt && existsSync(alt)) {
					absPath = alt;
					st = await stat(absPath);
				} else {
					throw await missingFileError(absPath, cwd);
				}
			}
			if (st.isDirectory()) throw new Error(`EISDIR: illegal operation on a directory, read '${absPath}'`);
			throwIfAborted(signal);

			if (isNotebook) {
				if (!st.isFile()) throw new Error("Notebook path is not a regular file (device, FIFO, or socket).");
				const { result, raw } = await readNotebook(absPath, st.size);
				try {
					cc.fileState.recordRead(absPath, raw, { offset, limit });
				} catch {
					// vanished meanwhile
				}
				return result;
			}

			let looksLikeImage = IMAGE_EXTENSIONS.has(ext);
			if (!looksLikeImage && ext === "" && st.isFile()) {
				const fh = await open(absPath, "r");
				try {
					const head = Buffer.alloc(16);
					const { bytesRead } = await fh.read(head, 0, 16, 0);
					looksLikeImage = sniffImageMimeType(head.subarray(0, bytesRead)) !== undefined;
				} finally {
					await fh.close();
				}
			}
			if (looksLikeImage) return readImage(absPath, st.size);
			if (ext === "pdf") return readPdf(absPath, st.size, params.pages, signal);
			if (!st.isFile()) throw new Error(`${absPath} is not a regular file.`);
			return readTextFile(cc, ctx, absPath, st.size, { offset, limit, allowLarge: params.allow_large === true }, signal);
		},
	});
}

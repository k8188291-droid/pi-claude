import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type { AgentToolResult, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import type { CCContext } from "../shared/context.js";
import { resolvePath } from "../shared/paths.js";
import { wrapReminder } from "../shared/reminders.js";

// ---------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------

export const DEFAULT_READ_LIMIT = 2000;
export const MAX_LINE_LENGTH = 2000;
/** Hard cap on characters of text returned by a single Read (~25k tokens). Read is exempt from output spilling. */
export const MAX_READ_OUTPUT_CHARS = 100_000;
/** Text files larger than this are refused (use Bash with head/tail/grep instead). */
const MAX_TEXT_FILE_BYTES = 100 * 1024 * 1024;
/** Images are refused above this raw size. */
const MAX_IMAGE_FILE_BYTES = 50 * 1024 * 1024;
/** Max base64 payload of an inline image (headroom below Anthropic's 5MB limit). */
const MAX_INLINE_IMAGE_BASE64 = 4.5 * 1024 * 1024;
const PDF_MAX_PAGES_PER_REQUEST = 20;
const PDF_MAX_PAGES_WITHOUT_RANGE = 10;
const NOTEBOOK_MAX_OUTPUT_CHARS_PER_OUTPUT = 10_000;

// ---------------------------------------------------------------------------------------------
// Description / schema (mirrors Claude Code's Read tool)
// ---------------------------------------------------------------------------------------------

const DESCRIPTION = `Reads a file from the local filesystem. You can access any file directly by using this tool.
Assume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- The file_path parameter must be an absolute path, not a relative path
- By default, it reads up to ${DEFAULT_READ_LIMIT} lines starting from the beginning of the file
- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters
- Any lines longer than ${MAX_LINE_LENGTH} characters will be truncated
- Results are returned using cat -n format, with line numbers starting at 1
- This tool allows you to read images (eg PNG, JPG, GIF, WEBP). When reading an image file the contents are presented visually as you are a multimodal LLM.
- This tool can read PDF files (.pdf). For large PDFs (more than ${PDF_MAX_PAGES_WITHOUT_RANGE} pages), you MUST provide the pages parameter to read specific page ranges (e.g., pages: "1-5"). Reading a large PDF without the pages parameter will fail. Maximum ${PDF_MAX_PAGES_PER_REQUEST} pages per request.
- This tool can read Jupyter notebooks (.ipynb files) and returns all cells with their outputs, combining code, text, and visualizations.
- This tool can only read files, not directories. To read a directory, use an ls command via the Bash tool.
- You can call multiple tools in a single response. It is always better to speculatively read multiple potentially useful files in parallel.
- You will regularly be asked to read screenshots. If the user provides a path to a screenshot, ALWAYS use this tool to view the file at the path. This tool will work with all temporary file paths.
- If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents.`;

const readSchema = Type.Object(
	{
		file_path: Type.String({ description: "The absolute path to the file to read" }),
		offset: Type.Optional(
			Type.Integer({
				description: "The line number to start reading from. Only provide if the file is too large to read at once",
				minimum: 0,
			}),
		),
		limit: Type.Optional(
			Type.Integer({
				description: "The number of lines to read. Only provide if the file is too large to read at once.",
				exclusiveMinimum: 0,
			}),
		),
		pages: Type.Optional(
			Type.String({
				description: `Page range for PDF files (e.g., "1-5", "3", "10-20"). Only applicable to PDF files. Maximum ${PDF_MAX_PAGES_PER_REQUEST} pages per request.`,
			}),
		),
	},
	{ additionalProperties: false },
);

export interface ReadToolDetails {
	filePath: string;
	kind: "text" | "image" | "pdf" | "notebook";
	/** text: first line shown (1-based) */
	startLine?: number;
	/** text: number of lines shown */
	numLines?: number;
	/** text: total lines in file */
	totalLines?: number;
	/** true when not everything was returned */
	truncated?: boolean;
	/** pdf */
	totalPages?: number;
	pages?: [number, number];
	/** notebook */
	cells?: number;
}

type Content = TextContent | ImageContent;

// ---------------------------------------------------------------------------------------------
// Helpers (also used by Edit)
// ---------------------------------------------------------------------------------------------

/** Format one line in `cat -n` style: number right-aligned to width 6, a tab, then the line. */
export function formatNumberedLine(lineNumber: number, line: string): string {
	return `${String(lineNumber).padStart(6, " ")}\t${line}`;
}

/** Split file text into lines (handles CRLF); a trailing newline does not produce an extra empty line. */
export function splitLines(text: string): string[] {
	if (text === "") return [];
	const lines = text.split(/\r?\n/);
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("Operation aborted");
}

function truncateLine(line: string): string {
	if (line.length <= MAX_LINE_LENGTH) return line;
	return `${line.slice(0, MAX_LINE_LENGTH)}... [line truncated, ${line.length} chars total]`;
}

function stripAnsi(s: string): string {
	// eslint-disable-next-line no-control-regex
	return s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function capText(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max)}\n... [output truncated, ${s.length - max} more characters]`;
}

// ---------------------------------------------------------------------------------------------
// Image support
// ---------------------------------------------------------------------------------------------

export function sniffImageMimeType(buf: Buffer): string | undefined {
	if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
	if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
	if (buf.length >= 6 && buf.toString("latin1", 0, 4) === "GIF8") return "image/gif";
	if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "image/webp";
	return undefined;
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
	formatDimensionNote?: (r: ResizedImage) => string | undefined;
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
			const indexUrl = import.meta.resolve("@mariozechner/pi-coding-agent");
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
				const p = join(dir, "node_modules", "@mariozechner", "pi-coding-agent", "dist", "utils", "image-resize.js");
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
	const { resizeImage, formatDimensionNote } = await loadPiImageResize();
	if (resizeImage) {
		try {
			const resized = await resizeImage({ type: "image", data: base64, mimeType });
			if (resized) {
				return {
					image: { type: "image", data: resized.data, mimeType: resized.mimeType },
					note: formatDimensionNote?.(resized),
				};
			}
		} catch {
			// fall through to raw handling
		}
	}
	if (base64.length <= MAX_INLINE_IMAGE_BASE64) {
		return { image: { type: "image", data: base64, mimeType } };
	}
	return { note: "[Image omitted: could not be resized below the inline image size limit.]" };
}

async function readImage(absPath: string, buffer: Buffer, mimeType: string): Promise<AgentToolResult<ReadToolDetails>> {
	const { image, note } = await prepareImage(buffer, mimeType);
	let text = `Read image file ${absPath} [${image?.mimeType ?? mimeType}]`;
	if (note) text += `\n${note}`;
	const content: Content[] = [{ type: "text", text }];
	if (image) content.push(image);
	return { content, details: { filePath: absPath, kind: "image" } };
}

// ---------------------------------------------------------------------------------------------
// PDF support (poppler-utils: pdfinfo / pdftotext / pdftoppm)
// ---------------------------------------------------------------------------------------------

function run(cmd: string, args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, { signal, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
			if (err) {
				(err as any).stderr = stderr;
				reject(err);
			} else resolve({ stdout, stderr });
		});
	});
}

function popplerError(err: any, tool: string): Error {
	if (err?.code === "ENOENT") {
		return new Error(
			`Reading PDF files requires the \`${tool}\` command from poppler-utils, which was not found on this system. ` +
				"Install poppler-utils (e.g. `apt-get install poppler-utils` or `brew install poppler`), or extract the text another way via the Bash tool.",
		);
	}
	if (err?.name === "AbortError") return new Error("Operation aborted");
	const stderr = String(err?.stderr ?? "").trim();
	return new Error(`Failed to read PDF with ${tool}: ${stderr || err?.message || String(err)}`);
}

async function pdfPageCount(absPath: string, signal?: AbortSignal): Promise<number | undefined> {
	try {
		const { stdout } = await run("pdfinfo", [absPath], signal);
		const m = /^Pages:\s+(\d+)/m.exec(stdout);
		return m ? Number(m[1]) : undefined;
	} catch (err: any) {
		if (err?.code === "ENOENT") return undefined; // fall back to pdftotext page splitting
		throw popplerError(err, "pdfinfo");
	}
}

/** Parse "3", "1-5", "10-" (open-ended). */
export function parsePageRange(pages: string): { first: number; last: number | undefined } {
	const m = /^\s*(\d+)\s*(?:-\s*(\d*)\s*)?$/.exec(pages);
	if (!m) {
		throw new Error(`Invalid pages parameter: "${pages}". Use a page number or range like "3" or "1-5".`);
	}
	const first = Number(m[1]);
	const last = m[2] === undefined ? first : m[2] === "" ? undefined : Number(m[2]);
	if (first < 1) throw new Error(`Invalid pages parameter: "${pages}". Page numbers start at 1.`);
	if (last !== undefined && last < first) {
		throw new Error(`Invalid pages parameter: "${pages}". The end page must not be before the start page.`);
	}
	return { first, last };
}

function tooManyPagesError(n: number): Error {
	return new Error(
		`This PDF has ${n} pages, which is too many to read at once. Use the pages parameter to read specific page ranges (e.g., pages: "1-5"). Maximum ${PDF_MAX_PAGES_PER_REQUEST} pages per request.`,
	);
}

async function readPdf(absPath: string, pages: string | undefined, signal?: AbortSignal): Promise<AgentToolResult<ReadToolDetails>> {
	const totalPages = await pdfPageCount(absPath, signal);
	const hasRange = pages !== undefined && pages.trim() !== "";
	let first = 1;
	let last: number | undefined = totalPages;
	if (hasRange) {
		const r = parsePageRange(pages!);
		first = r.first;
		last = r.last ?? (totalPages !== undefined ? totalPages : first + PDF_MAX_PAGES_PER_REQUEST - 1);
		if (totalPages !== undefined) {
			if (first > totalPages) {
				throw new Error(`Invalid pages parameter: "${pages}". The PDF only has ${totalPages} page${totalPages === 1 ? "" : "s"}.`);
			}
			last = Math.min(last, totalPages);
		}
		if (last - first + 1 > PDF_MAX_PAGES_PER_REQUEST) {
			throw new Error(
				`Page range "${pages}" spans ${last - first + 1} pages; at most ${PDF_MAX_PAGES_PER_REQUEST} pages can be read per request. Use a smaller range.`,
			);
		}
	} else if (totalPages !== undefined && totalPages > PDF_MAX_PAGES_WITHOUT_RANGE) {
		throw tooManyPagesError(totalPages);
	}

	const args = ["-layout", "-enc", "UTF-8", "-f", String(first)];
	if (last !== undefined) args.push("-l", String(last));
	args.push(absPath, "-");
	let stdout: string;
	try {
		({ stdout } = await run("pdftotext", args, signal));
	} catch (err) {
		throw popplerError(err, "pdftotext");
	}
	throwIfAborted(signal);

	// pdftotext terminates every page with a form feed.
	const pageTexts = stdout.split("\f");
	if (pageTexts.length > 1 && pageTexts[pageTexts.length - 1].trim() === "") pageTexts.pop();
	if (totalPages === undefined && !hasRange && pageTexts.length > PDF_MAX_PAGES_WITHOUT_RANGE) {
		throw tooManyPagesError(pageTexts.length);
	}
	const lastShown = first + pageTexts.length - 1;

	// Pages with (almost) no extractable text are likely scanned: render them as images if pdftoppm exists.
	const imagePages = new Map<number, ImageContent>();
	const scanned = pageTexts.map((t, i) => ({ page: first + i, empty: t.replace(/\s/g, "").length < 20 })).filter((p) => p.empty);
	if (scanned.length > 0) {
		let tmp: string | undefined;
		try {
			tmp = await mkdtemp(join(tmpdir(), "pi-cc-pdf-"));
			for (const { page } of scanned) {
				throwIfAborted(signal);
				const prefix = join(tmp, `p${page}`);
				await run("pdftoppm", ["-png", "-r", "100", "-f", String(page), "-l", String(page), "-singlefile", absPath, prefix], signal);
				const png = await readFile(`${prefix}.png`);
				const { image } = await prepareImage(png, "image/png");
				if (image) imagePages.set(page, image);
			}
		} catch (err: any) {
			if (err?.name === "AbortError" || signal?.aborted) throw new Error("Operation aborted");
			// pdftoppm missing or failed: text-only result
		} finally {
			if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
		}
	}

	const content: Content[] = [];
	let text = `PDF file: ${absPath}`;
	if (totalPages !== undefined) text += ` (${totalPages} page${totalPages === 1 ? "" : "s"} total)`;
	text += `. Showing page${first === lastShown ? ` ${first}` : `s ${first}-${lastShown}`}.`;
	let budget = MAX_READ_OUTPUT_CHARS;
	let truncated = false;
	for (let i = 0; i < pageTexts.length; i++) {
		const page = first + i;
		let body = pageTexts[i].replace(/\s+$/, "");
		if (body.length > budget) {
			body = `${body.slice(0, Math.max(0, budget))}\n... [page text truncated: output limit reached]`;
			truncated = true;
		}
		budget -= body.length;
		const img = imagePages.get(page);
		const pageBody = body.trim() === "" ? (img ? "(no extractable text; page rendered as image below)" : "(no extractable text)") : body;
		text += `\n\n<page number="${page}">\n${pageBody}\n</page>`;
		if (img) {
			content.push({ type: "text", text: text.replace(/^\n+/, "") });
			content.push(img);
			text = "";
		}
		if (truncated) {
			if (page < lastShown) {
				text += `\n\n[Output truncated at page ${page}. Read the remaining pages with the pages parameter (e.g., pages: "${page + 1}-${lastShown}").]`;
			}
			break;
		}
	}
	if (text.trim() !== "") content.push({ type: "text", text: text.replace(/^\n+/, "") });
	return {
		content,
		details: { filePath: absPath, kind: "pdf", totalPages, pages: [first, lastShown], truncated },
	};
}

// ---------------------------------------------------------------------------------------------
// Jupyter notebooks
// ---------------------------------------------------------------------------------------------

function joinSource(src: unknown): string {
	if (Array.isArray(src)) return src.join("");
	return typeof src === "string" ? src : "";
}

const NOTEBOOK_IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

async function readNotebook(absPath: string, raw: Buffer): Promise<AgentToolResult<ReadToolDetails>> {
	let nb: any;
	try {
		nb = JSON.parse(raw.toString("utf8").replace(/^﻿/, ""));
	} catch (err: any) {
		throw new Error(`Failed to parse Jupyter notebook ${absPath}: ${err?.message ?? err}`);
	}
	const cells: any[] = Array.isArray(nb?.cells) ? nb.cells : [];
	if (cells.length === 0) {
		return {
			content: [{ type: "text", text: wrapReminder("Warning: the notebook exists but contains no cells.") }],
			details: { filePath: absPath, kind: "notebook", cells: 0 },
		};
	}
	const language: string = nb?.metadata?.language_info?.name ?? nb?.metadata?.kernelspec?.language ?? "python";
	const content: Content[] = [];
	let text = "";
	const flush = () => {
		if (text !== "") content.push({ type: "text", text });
		text = "";
	};

	for (let index = 0; index < cells.length; index++) {
		const cell = cells[index] ?? {};
		const id = typeof cell.id === "string" && cell.id ? cell.id : `cell-${index}`;
		const cellType = typeof cell.cell_type === "string" ? cell.cell_type : "code";
		let meta = "";
		if (cellType !== "code") meta += `<cell_type>${cellType}</cell_type>`;
		else if (language && language !== "python") meta += `<language>${language}</language>`;
		if (text !== "") text += "\n";
		text += `<cell id="${id}">${meta}${joinSource(cell.source)}</cell id="${id}">`;

		const outputs: any[] = cellType === "code" && Array.isArray(cell.outputs) ? cell.outputs : [];
		const outTexts: string[] = [];
		const images: ImageContent[] = [];
		for (const out of outputs) {
			switch (out?.output_type) {
				case "stream":
					outTexts.push(capText(stripAnsi(joinSource(out.text)), NOTEBOOK_MAX_OUTPUT_CHARS_PER_OUTPUT));
					break;
				case "execute_result":
				case "display_data": {
					const data = out.data ?? {};
					const imgMime = NOTEBOOK_IMAGE_MIMES.find((m) => joinSource(data[m]) !== "");
					if (imgMime) {
						const b64 = joinSource(data[imgMime]).replace(/\s/g, "");
						const prepared = await prepareImage(Buffer.from(b64, "base64"), imgMime);
						if (prepared.image) images.push(prepared.image);
						else outTexts.push(`[${imgMime} output omitted: too large]`);
					}
					if (data["text/plain"] !== undefined) {
						outTexts.push(capText(stripAnsi(joinSource(data["text/plain"])), NOTEBOOK_MAX_OUTPUT_CHARS_PER_OUTPUT));
					} else if (!imgMime && data["text/markdown"] !== undefined) {
						outTexts.push(capText(joinSource(data["text/markdown"]), NOTEBOOK_MAX_OUTPUT_CHARS_PER_OUTPUT));
					} else if (!imgMime && data["text/html"] !== undefined) {
						outTexts.push(capText(joinSource(data["text/html"]), NOTEBOOK_MAX_OUTPUT_CHARS_PER_OUTPUT));
					}
					break;
				}
				case "error": {
					const tb = Array.isArray(out.traceback) ? out.traceback.map((l: unknown) => stripAnsi(String(l))).join("\n") : "";
					outTexts.push(capText(`${out.ename ?? "Error"}: ${out.evalue ?? ""}${tb ? `\n${tb}` : ""}`, NOTEBOOK_MAX_OUTPUT_CHARS_PER_OUTPUT));
					break;
				}
				default:
					break;
			}
		}
		if (outTexts.length > 0 || images.length > 0) {
			text += `\n<outputs cell_id="${id}">`;
			if (outTexts.length > 0) text += `\n${outTexts.map((t) => t.replace(/\n$/, "")).join("\n")}`;
			if (images.length > 0) text += `\n[${images.length} image output${images.length === 1 ? "" : "s"} attached below]`;
			text += `\n</outputs>`;
			if (images.length > 0) {
				flush();
				content.push(...images);
			}
		}
	}
	flush();
	const totalChars = content.reduce((n, c) => n + (c.type === "text" ? c.text.length : 0), 0);
	if (totalChars > MAX_READ_OUTPUT_CHARS) {
		throw new Error(
			`Notebook content (${totalChars} characters) exceeds the maximum allowed size (${MAX_READ_OUTPUT_CHARS} characters). Use Bash with jq to read specific portions, e.g.:\n` +
				`  cat "${absPath}" | jq '.cells[:20]'\n  cat "${absPath}" | jq '.cells[] | select(.cell_type=="code") | .source'`,
		);
	}
	return { content, details: { filePath: absPath, kind: "notebook", cells: cells.length } };
}

// ---------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------

function isProbablyBinary(buf: Buffer): boolean {
	const n = Math.min(buf.length, 8192);
	for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
	return false;
}

function readText(
	absPath: string,
	buffer: Buffer,
	offset: number | undefined,
	limit: number | undefined,
	cc: CCContext,
): AgentToolResult<ReadToolDetails> {
	const text = buffer.toString("utf8").replace(/^﻿/, "");
	const lines = splitLines(text);
	const totalLines = lines.length;
	const startLine = offset && offset > 1 ? Math.floor(offset) : 1;
	const max = limit && limit > 0 ? Math.floor(limit) : DEFAULT_READ_LIMIT;

	if (totalLines === 0) {
		cc.fileState.recordRead(absPath, buffer, { partial: false });
		return {
			content: [{ type: "text", text: wrapReminder("Warning: the file exists but the contents are empty.") }],
			details: { filePath: absPath, kind: "text", startLine: 1, numLines: 0, totalLines: 0 },
		};
	}
	if (startLine > totalLines) {
		cc.fileState.recordRead(absPath, buffer, { partial: true });
		return {
			content: [
				{
					type: "text",
					text: wrapReminder(
						`Warning: the file exists but is shorter than the provided offset (${startLine}). The file has ${totalLines} line${totalLines === 1 ? "" : "s"}.`,
					),
				},
			],
			details: { filePath: absPath, kind: "text", startLine, numLines: 0, totalLines },
		};
	}

	const endExclusive = Math.min(totalLines, startLine - 1 + max);
	const out: string[] = [];
	let chars = 0;
	let lastShown = startLine - 1;
	let cappedByChars = false;
	for (let i = startLine - 1; i < endExclusive; i++) {
		const formatted = formatNumberedLine(i + 1, truncateLine(lines[i]));
		if (out.length > 0 && chars + formatted.length + 1 > MAX_READ_OUTPUT_CHARS) {
			cappedByChars = true;
			break;
		}
		out.push(formatted);
		chars += formatted.length + 1;
		lastShown = i + 1;
	}
	let result = out.join("\n");
	if (cappedByChars) {
		result += `\n\n[Output truncated at line ${lastShown} of ${totalLines} because it exceeded ${MAX_READ_OUTPUT_CHARS} characters. Use offset=${lastShown + 1} (with a smaller limit) to continue reading.]`;
	} else if (lastShown < totalLines) {
		result += `\n\n[Showing lines ${startLine}-${lastShown} of ${totalLines}. Use offset=${lastShown + 1} to read more.]`;
	}
	const partial = startLine > 1 || lastShown < totalLines;
	cc.fileState.recordRead(absPath, buffer, { partial });
	return {
		content: [{ type: "text", text: result }],
		details: { filePath: absPath, kind: "text", startLine, numLines: lastShown - startLine + 1, totalLines, truncated: partial },
	};
}

// ---------------------------------------------------------------------------------------------
// Missing files
// ---------------------------------------------------------------------------------------------

function levenshtein(a: string, b: string): number {
	if (Math.abs(a.length - b.length) > 3) return 99;
	const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		let prev = dp[0];
		dp[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const tmp = dp[j];
			dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
			prev = tmp;
		}
	}
	return dp[b.length];
}

async function suggestSimilar(absPath: string): Promise<string[]> {
	const dir = dirname(absPath);
	const lower = basename(absPath).toLowerCase();
	const stem = lower.replace(/\.[^.]*$/, "");
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return [];
	}
	if (entries.length > 5000) return [];
	const scored: Array<{ name: string; score: number }> = [];
	for (const name of entries) {
		const l = name.toLowerCase();
		let score: number | undefined;
		if (l === lower) score = 0;
		else if (stem !== "" && l.replace(/\.[^.]*$/, "") === stem) score = 1;
		else {
			const d = levenshtein(l, lower);
			if (d <= Math.max(1, Math.min(3, Math.floor(lower.length / 4)))) score = 1 + d;
		}
		if (score !== undefined) scored.push({ name, score });
	}
	return scored
		.sort((a, b) => a.score - b.score)
		.slice(0, 3)
		.map((s) => join(dir, s.name));
}

/** macOS screenshot names use U+202F (narrow no-break space) before AM/PM; models usually type a plain space. */
function alternateScreenshotPath(absPath: string): string | undefined {
	const base = basename(absPath);
	const alt = base.replace(/ (AM|PM)(\.[A-Za-z0-9]+)$/, " $1$2");
	if (alt === base) return undefined;
	return join(dirname(absPath), alt);
}

async function missingFileError(absPath: string, cwd: string): Promise<Error> {
	let msg = `File does not exist: ${absPath}. Current working directory: ${cwd}`;
	const similar = await suggestSimilar(absPath);
	if (similar.length === 1) msg += `\nDid you mean ${similar[0]}?`;
	else if (similar.length > 1) msg += `\nDid you mean one of:\n${similar.map((s) => `- ${s}`).join("\n")}`;
	return new Error(msg);
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
		async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<ReadToolDetails>> {
			throwIfAborted(signal);
			if (typeof params.file_path !== "string" || params.file_path.trim() === "") {
				throw new Error("file_path is required.");
			}
			const cwd = ctx?.cwd ?? process.cwd();
			let absPath = resolvePath(cwd, params.file_path);
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
			if (st.isDirectory()) {
				throw new Error(
					`EISDIR: ${absPath} is a directory, not a file. This tool can only read files. To list a directory's contents, use an ls command via the Bash tool.`,
				);
			}
			if (!st.isFile()) throw new Error(`${absPath} is not a regular file.`);

			const ext = extname(absPath).toLowerCase();
			if (ext === ".pdf") return readPdf(absPath, params.pages, signal);
			if (st.size > MAX_TEXT_FILE_BYTES) {
				throw new Error(
					`File content (${(st.size / 1024 / 1024).toFixed(1)}MB) exceeds the maximum allowed size (${MAX_TEXT_FILE_BYTES / 1024 / 1024}MB). Use the Bash tool with head/tail/sed or the Grep tool to read specific portions of the file.`,
				);
			}
			const buffer = await readFile(absPath, { signal });
			throwIfAborted(signal);

			if (ext === ".ipynb") {
				const result = await readNotebook(absPath, buffer);
				cc.fileState.recordRead(absPath, buffer, { partial: false });
				return result;
			}

			const mime = sniffImageMimeType(buffer);
			if (mime) {
				if (buffer.length > MAX_IMAGE_FILE_BYTES) {
					throw new Error(`Image file is too large (${(buffer.length / 1024 / 1024).toFixed(1)}MB).`);
				}
				const result = await readImage(absPath, buffer, mime);
				cc.fileState.recordRead(absPath, buffer, { partial: false });
				return result;
			}
			if (buffer.subarray(0, 5).toString("latin1") === "%PDF-") return readPdf(absPath, params.pages, signal);
			if (isProbablyBinary(buffer)) {
				throw new Error(
					`This tool cannot read binary files. The file appears to be a binary ${ext || "(no extension)"} file. Please use appropriate tools (e.g. via the Bash tool) for binary file analysis.`,
				);
			}
			return readText(absPath, buffer, params.offset, params.limit, cc);
		},
	});
}

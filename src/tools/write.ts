import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CCContext } from "../shared/context.js";
import { FILE_MODIFIED_SINCE_READ, FILE_NOT_READ } from "../shared/file-state.js";
import { resolvePath } from "../shared/paths.js";

// Mirrors Claude Code 2.1.302's Write tool (description, schema, validation order and messages).

const DESCRIPTION = `Writes a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.
- Prefer the Edit tool for modifying existing files — it only sends the diff. Only use this tool to create new files or for complete rewrites.
- NEVER create documentation files (*.md) or README files unless explicitly requested by the User.
- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.`;

const writeSchema = Type.Object(
	{
		file_path: Type.String({ description: "The absolute path to the file to write (must be absolute, not relative)" }),
		content: Type.String({ description: "The content to write to the file" }),
	},
	{ additionalProperties: false },
);

export interface WriteToolDetails {
	filePath: string;
	type: "create" | "update";
	/** Previous content (null for new files). */
	originalFile: string | null;
	bytes: number;
}

/** Appended to Write/Edit results when the model's view of the file is the file's current content. */
export const FILE_STATE_CURRENT_NOTE = " (file state is current in your context — no need to Read it back)";

// ---------------------------------------------------------------------------------------------
// Text file I/O shared with Edit (Claude Code keeps the encoding; Edit also keeps CRLF)
// ---------------------------------------------------------------------------------------------

export type NotTextKind = "not_utf8" | "nul" | "utf16be";
export type TextEncodingName = "utf8" | "utf16le";

export interface ExistingText {
	/** Decoded content with CRLF folded to LF (a BOM is kept as U+FEFF). */
	content: string;
	encoding: TextEncodingName;
	lineEndings: "LF" | "CRLF";
	notText?: NotTextKind;
}

const NOT_TEXT_REASONS: Record<NotTextKind, string> = {
	not_utf8: "is not valid UTF-8: it uses a legacy encoding such as Windows-1252, Shift-JIS or GBK, or it is binary",
	nul: "has NUL bytes in its first 8 KB: binary data, UTF-16/UTF-32 without a byte-order mark, or text with embedded NULs",
	utf16be: "is UTF-16 big-endian (it starts FE FF), which these tools cannot write",
};

export function notTextMessage(kind: NotTextKind): string {
	return `File ${NOT_TEXT_REASONS[kind]}. These tools write UTF-8 (or UTF-16LE behind its byte-order mark) and never convert a file's encoding on their own, so nothing was written. If the file is text, make the change with a shell command that reads and writes it in its own encoding (iconv, or PowerShell Get-Content/Set-Content -Encoding), or ask the user whether to convert it to UTF-8 first. To replace the whole file with new UTF-8 text anyway, delete it first, then Write it.`;
}

const utf8Strict = new TextDecoder("utf-8", { fatal: true });

function classify(buf: Buffer): { encoding: TextEncodingName; notText?: NotTextKind } {
	if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { encoding: "utf16le" };
	if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return { encoding: "utf8", notText: "utf16be" };
	if (buf.subarray(0, 8000).includes(0)) return { encoding: "utf8", notText: "nul" };
	try {
		utf8Strict.decode(buf);
	} catch {
		return { encoding: "utf8", notText: "not_utf8" };
	}
	return { encoding: "utf8" };
}

/** CRLF when more lines of the sample end in CRLF than in a bare LF. */
export function detectLineEndings(sample: string): "LF" | "CRLF" {
	let crlf = 0;
	let lf = 0;
	for (let i = 0; i < sample.length; i++) {
		if (sample[i] === "\n") {
			if (i > 0 && sample[i - 1] === "\r") crlf++;
			else lf++;
		}
	}
	return crlf > lf ? "CRLF" : "LF";
}

/** Read an existing file as text; null when it does not exist. Other errors (EISDIR, ...) are thrown. */
export async function readExistingText(absPath: string): Promise<ExistingText | null> {
	let buf: Buffer;
	try {
		buf = await readFile(absPath);
	} catch (err: any) {
		if (err?.code === "ENOENT") return null;
		throw err;
	}
	const { encoding, notText } = classify(buf);
	const raw = buf.toString(encoding);
	return { content: raw.replaceAll("\r\n", "\n"), encoding, lineEndings: detectLineEndings(raw.slice(0, 4096)), ...(notText && { notText }) };
}

/** Write text in the given encoding, converting LF to CRLF when the file used CRLF. */
export async function writeText(absPath: string, content: string, encoding: TextEncodingName, lineEndings: "LF" | "CRLF", createParents = true): Promise<void> {
	const text = lineEndings === "CRLF" ? content.replaceAll("\r\n", "\n").split("\n").join("\r\n") : content;
	if (createParents) await mkdir(dirname(absPath), { recursive: true });
	await writeFile(absPath, Buffer.from(text, encoding));
}

// ---------------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------------

export function registerWrite(pi: ExtensionAPI, cc: CCContext): void {
	pi.registerTool({
		name: "Write",
		label: "Write",
		description: DESCRIPTION,
		promptSnippet: "Create or overwrite files",
		parameters: writeSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<WriteToolDetails>> {
			if (signal?.aborted) throw new Error("Operation aborted");
			const filePath = params.file_path;
			if (typeof filePath !== "string" || typeof params.content !== "string") throw new Error("file_path and content are required strings.");
			const absPath = resolvePath(ctx?.cwd ?? process.cwd(), filePath);

			return withFileMutationQueue(absPath, async () => {
				if (signal?.aborted) throw new Error("Operation aborted");
				// ---- validation (same order as Claude Code) ----
				if (cc.options.isSubagent && /^(REPORT|SUMMARY|FINDINGS|ANALYSIS).*\.md$/i.test(basename(absPath))) {
					throw new Error("Subagents should return findings as text, not write report files. Include this content in your final response instead.");
				}
				let existedBefore = true;
				try {
					const st = await stat(absPath);
					if (st.isDirectory()) throw new Error(`${filePath} is a directory, not a file. To create a file inside it, include the file name in file_path.`);
					if (!st.isFile()) throw new Error(`${filePath} exists but is not a regular file (a device, FIFO or socket). Write only creates or overwrites regular files.`);
				} catch (err: any) {
					if (err?.code !== "ENOENT") throw err;
					existedBefore = false;
				}
				if (existedBefore) {
					const rec = cc.fileState.get(absPath);
					if (!rec || rec.truncated) {
						if (rec || absPath.toLowerCase().endsWith(".ipynb")) throw new Error(FILE_NOT_READ);
					} else if (cc.fileState.isStale(absPath)) {
						throw new Error(FILE_MODIFIED_SINCE_READ);
					}
				}

				// ---- write ----
				const existing = await readExistingText(absPath);
				if (existing?.notText) throw new Error(notTextMessage(existing.notText));
				const original = existing?.content ?? null;
				let content = params.content;
				if (content !== "" && original?.charCodeAt(0) === 0xfeff && content.charCodeAt(0) !== 0xfeff) content = `﻿${content}`;
				if (signal?.aborted) throw new Error("Operation aborted");
				await writeText(absPath, content, existing?.encoding ?? "utf8", "LF");
				cc.fileState.recordWrite(absPath, content);

				const text =
					existing !== null
						? `The file ${filePath} has been updated successfully.${FILE_STATE_CURRENT_NOTE}`
						: `File created successfully at: ${filePath}${FILE_STATE_CURRENT_NOTE}`;
				return {
					content: [{ type: "text", text }],
					details: { filePath: absPath, type: existing !== null ? "update" : "create", originalFile: original, bytes: Buffer.byteLength(content, existing?.encoding ?? "utf8") },
				};
			});
		},
	});
}


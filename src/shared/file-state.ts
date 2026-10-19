import { createHash, type Hash } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

/**
 * What the model has seen of a file, mirroring Claude Code's `readFileState` entries.
 *
 * - `timestamp` is `Math.floor(mtimeMs)` when the file was read or written by a tool.
 * - `hash` is the hash of the whole file's text as Claude Code compares it (UTF-8 BOM stripped,
 *   CRLF folded to LF), so a rewrite that leaves the text unchanged is not "a change". It always
 *   covers the whole file, also for partial reads (streamed reads hash incrementally, #6a).
 * - `partial` means the read did not cover the whole file (offset/limit); content comparisons and
 *   the "file state is current" note then do not apply. It does not block writes.
 * - `truncated` is Claude Code's `isPartialView`: the Read result was a cut-down excerpt. Write
 *   refuses such a file as "not read yet"; Edit keeps the flag on the record it writes.
 * - `contentNotInModelContext` marks an Edit that changed a file the model had not fully seen.
 */
export interface FileRecord {
	timestamp: number;
	hash: string;
	partial: boolean;
	truncated: boolean;
	offset?: number;
	limit?: number;
	contentNotInModelContext: boolean;
	source: "read" | "write";
}

export interface RecordReadOptions {
	/** The read covered only part of the file (offset > 1 or a limit that cut the file short). */
	partial?: boolean;
	/** The Read result was a truncated excerpt (Claude Code's isPartialView). */
	truncated?: boolean;
	offset?: number;
	limit?: number;
}

/** A precomputed whole-file text hash (see `TextHasher`), in place of the file's content. */
export interface PrecomputedHash {
	hash: string;
}

export interface ChangeCheckOptions {
	/**
	 * Decide by content, not by mtime (quirk #5 `mtimeOnlyChangeDetection` fixed): the file is
	 * changed exactly when its text hash differs from the record's, so an external rewrite that
	 * restored the mtime is caught, and an mtime bump that left the text alone is not a change even
	 * for partial views. Claude Code (the default) only compares content once the mtime moved.
	 */
	contentCheck?: boolean;
}

export interface RecordWriteOptions {
	/** The model has not seen the whole resulting file (Edit of a file it never fully read). */
	contentNotInModelContext?: boolean;
	/** Keep the truncated (isPartialView) flag of the previous record. */
	truncated?: boolean;
}

export const FILE_MODIFIED_SINCE_READ =
	"File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.";
export const FILE_NOT_READ = "File has not been read yet. Read it first before writing to it.";
export const FILE_CONTENT_CHANGED =
	"File content has changed since it was last read. This commonly happens when a linter or formatter run via Bash rewrites the file. Call Read on this file to refresh, then retry the edit.";

export function hashContent(content: string | Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

function decodeForCompare(buf: Buffer): string {
	if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString("utf16le");
	return buf.toString("utf8");
}

/** Text as Claude Code compares file contents: BOM stripped, CRLF folded to LF. */
export function normalizeText(content: string | Buffer): string {
	let text = typeof content === "string" ? content : decodeForCompare(content);
	if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
	return text.replaceAll("\r\n", "\n");
}

export function textHash(content: string | Buffer): string {
	return hashContent(normalizeText(content));
}

/**
 * Incremental `textHash`: feed the decoded text in pieces (a leading BOM is dropped and CRLF is
 * folded across piece boundaries), so a large file can be hashed without holding it in memory.
 */
export class TextHasher {
	private readonly hash: Hash = createHash("sha256");
	private first = true;
	private pendingCR = false;

	update(piece: string): void {
		if (piece === "") return;
		if (this.first) {
			this.first = false;
			if (piece.charCodeAt(0) === 0xfeff) piece = piece.slice(1);
		}
		if (this.pendingCR) {
			piece = `\r${piece}`;
			this.pendingCR = false;
		}
		if (piece.endsWith("\r")) {
			this.pendingCR = true;
			piece = piece.slice(0, -1);
		}
		this.hash.update(piece.replaceAll("\r\n", "\n"));
	}

	digest(): string {
		if (this.pendingCR) this.hash.update("\r");
		this.pendingCR = false;
		return this.hash.digest("hex");
	}
}

/** Decoder for a file's bytes as `normalizeText` decodes them, chosen from its first bytes. */
export function decoderFor(head: Buffer): StringDecoder {
	return new StringDecoder(head.length >= 2 && head[0] === 0xff && head[1] === 0xfe ? "utf16le" : "utf8");
}

/** Never equal to a real hash: what a path that is not a regular file hashes to. */
const NOT_A_REGULAR_FILE = "not-a-regular-file";
const HASH_CHUNK_BYTES = 524288;

/**
 * `textHash` of a file's current content, read in chunks (bounded memory). The file is opened
 * non-blocking and must be a regular file: a FIFO or device never blocks this and never matches.
 */
export function hashFileText(absPath: string): string {
	const fd = openSync(absPath, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
	try {
		if (!fstatSync(fd).isFile()) return NOT_A_REGULAR_FILE;
		const buf = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
		const hasher = new TextHasher();
		let decoder: StringDecoder | undefined;
		for (;;) {
			const n = readSync(fd, buf, 0, HASH_CHUNK_BYTES, null);
			if (n === 0) break;
			const chunk = buf.subarray(0, n);
			decoder ??= decoderFor(chunk);
			hasher.update(decoder.write(chunk));
		}
		if (decoder) hasher.update(decoder.end());
		return hasher.digest();
	} finally {
		closeSync(fd);
	}
}

function mtimeOf(absPath: string): number {
	return Math.floor(statSync(absPath).mtimeMs);
}

/**
 * Tracks which files the model has read (or a tool has written) and their state at that time, so
 * Write/Edit can detect files that changed on disk since. Keys are absolute paths.
 */
export class FileStateTracker {
	private records = new Map<string, FileRecord>();

	/**
	 * Record a read. Pass the whole file content (Buffer or text) so it can be hashed, or its
	 * precomputed `textHash` when the file was streamed.
	 */
	recordRead(absPath: string, content: string | Buffer | PrecomputedHash, opts: RecordReadOptions = {}): void {
		this.records.set(absPath, {
			timestamp: mtimeOf(absPath),
			hash: typeof content === "string" || Buffer.isBuffer(content) ? textHash(content) : content.hash,
			partial: !!opts.partial,
			truncated: !!opts.truncated,
			offset: opts.offset,
			limit: opts.limit,
			contentNotInModelContext: false,
			source: "read",
		});
	}

	/** Record that a tool just wrote `content` to absPath. */
	recordWrite(absPath: string, content: string | Buffer, opts: RecordWriteOptions = {}): void {
		this.records.set(absPath, {
			timestamp: mtimeOf(absPath),
			hash: textHash(content),
			partial: false,
			truncated: !!opts.truncated,
			contentNotInModelContext: !!opts.contentNotInModelContext,
			source: "write",
		});
	}

	get(absPath: string): FileRecord | undefined {
		return this.records.get(absPath);
	}

	has(absPath: string): boolean {
		return this.records.has(absPath);
	}

	forget(absPath: string): void {
		this.records.delete(absPath);
	}

	/** Whether the record covers the whole file (Claude Code's "full view"). */
	static isFullView(rec: FileRecord | undefined): rec is FileRecord {
		return rec !== undefined && !rec.partial && !rec.truncated;
	}

	/** Whether the model has the file's whole recorded text in context. */
	static inModelContext(rec: FileRecord | undefined): boolean {
		return FileStateTracker.isFullView(rec) && !rec.contentNotInModelContext;
	}

	/** Whether `text` equals the recorded content (after BOM/CRLF normalization). */
	static sameContent(rec: FileRecord, text: string | Buffer): boolean {
		return rec.hash === textHash(text);
	}

	/**
	 * Whether the file changed on disk since it was recorded: its mtime moved past the record and,
	 * for full views, its text differs. `currentText` avoids re-reading the file. With
	 * `contentCheck` (#5 fixed) only the text decides.
	 */
	isStale(absPath: string, currentText?: string | Buffer, opts: ChangeCheckOptions = {}): boolean {
		const rec = this.records.get(absPath);
		if (!rec) return false;
		let mtime: number;
		try {
			mtime = mtimeOf(absPath);
		} catch {
			return false;
		}
		if (opts.contentCheck) return rec.hash !== (currentText !== undefined ? textHash(currentText) : hashFileText(absPath));
		if (mtime <= rec.timestamp) return false;
		if (!FileStateTracker.isFullView(rec)) return true;
		return currentText !== undefined ? !FileStateTracker.sameContent(rec, currentText) : rec.hash !== hashFileText(absPath);
	}

	/**
	 * Whether an existing file may be overwritten as a whole (Write's rules): never-read files are
	 * fine, truncated views and files changed since they were read are not.
	 * Returns undefined when OK, or an error message for the model.
	 */
	checkCanModify(absPath: string, opts: ChangeCheckOptions = {}): string | undefined {
		try {
			statSync(absPath);
		} catch {
			return undefined; // new file
		}
		const rec = this.records.get(absPath);
		if (rec?.truncated) return FILE_NOT_READ;
		if (rec && this.isStale(absPath, undefined, opts)) return FILE_MODIFIED_SINCE_READ;
		return undefined;
	}

	/** Paths recorded so far whose on-disk content changed since (for change reminders). */
	changedSinceRead(opts: ChangeCheckOptions = {}): string[] {
		const out: string[] = [];
		for (const p of this.records.keys()) {
			try {
				if (this.isStale(p, undefined, opts)) out.push(p);
			} catch {
				out.push(p);
			}
		}
		return out;
	}
}

/** Async `hashFileText` (bounded memory, does not block the event loop on a large file). */
export async function hashFileTextAsync(absPath: string): Promise<string> {
	const fh = await open(absPath, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
	try {
		if (!(await fh.stat()).isFile()) return NOT_A_REGULAR_FILE;
		const buf = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
		const hasher = new TextHasher();
		let decoder: StringDecoder | undefined;
		for (;;) {
			const { bytesRead } = await fh.read(buf, 0, HASH_CHUNK_BYTES, null);
			if (bytesRead === 0) break;
			const chunk = buf.subarray(0, bytesRead);
			decoder ??= decoderFor(chunk);
			hasher.update(decoder.write(chunk));
		}
		if (decoder) hasher.update(decoder.end());
		return hasher.digest();
	} finally {
		await fh.close();
	}
}

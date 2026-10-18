import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

/**
 * What the model has seen of a file, mirroring Claude Code's `readFileState` entries.
 *
 * - `timestamp` is `Math.floor(mtimeMs)` when the file was read or written by a tool.
 * - `hash` is the hash of the whole file's text as Claude Code compares it (UTF-8 BOM stripped,
 *   CRLF folded to LF), so a rewrite that leaves the text unchanged is not "a change".
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

function mtimeOf(absPath: string): number {
	return Math.floor(statSync(absPath).mtimeMs);
}

/**
 * Tracks which files the model has read (or a tool has written) and their state at that time, so
 * Write/Edit can detect files that changed on disk since. Keys are absolute paths.
 */
export class FileStateTracker {
	private records = new Map<string, FileRecord>();

	/** Record a read. Pass the whole file content (Buffer or text) so it can be hashed. */
	recordRead(absPath: string, content: string | Buffer, opts: RecordReadOptions = {}): void {
		this.records.set(absPath, {
			timestamp: mtimeOf(absPath),
			hash: textHash(content),
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
	 * for full views, its text differs. `currentText` avoids re-reading the file.
	 */
	isStale(absPath: string, currentText?: string | Buffer): boolean {
		const rec = this.records.get(absPath);
		if (!rec) return false;
		let mtime: number;
		try {
			mtime = mtimeOf(absPath);
		} catch {
			return false;
		}
		if (mtime <= rec.timestamp) return false;
		if (!FileStateTracker.isFullView(rec)) return true;
		return !FileStateTracker.sameContent(rec, currentText ?? readFileSync(absPath));
	}

	/**
	 * Whether an existing file may be overwritten as a whole (Write's rules): never-read files are
	 * fine, truncated views and files changed since they were read are not.
	 * Returns undefined when OK, or an error message for the model.
	 */
	checkCanModify(absPath: string): string | undefined {
		try {
			statSync(absPath);
		} catch {
			return undefined; // new file
		}
		const rec = this.records.get(absPath);
		if (rec?.truncated) return FILE_NOT_READ;
		if (rec && this.isStale(absPath)) return FILE_MODIFIED_SINCE_READ;
		return undefined;
	}

	/** Paths recorded so far whose on-disk content changed since (for change reminders). */
	changedSinceRead(): string[] {
		const out: string[] = [];
		for (const p of this.records.keys()) {
			try {
				if (this.isStale(p)) out.push(p);
			} catch {
				out.push(p);
			}
		}
		return out;
	}
}

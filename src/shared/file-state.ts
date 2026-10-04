import { createHash } from "node:crypto";
import { statSync, readFileSync } from "node:fs";

interface FileRecord {
	mtimeMs: number;
	hash: string;
	/** true when only a slice (offset/limit) was read */
	partial: boolean;
}

export function hashContent(content: string | Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

/**
 * Tracks which files the model has read (or itself written) and their state at that time,
 * so Write/Edit can refuse to modify files that were never read or changed externally since.
 * Keys are absolute paths.
 */
export class FileStateTracker {
	private records = new Map<string, FileRecord>();

	/** Record a read. Pass the full file content when available so we can hash it. */
	recordRead(absPath: string, content: string | Buffer, opts: { partial?: boolean } = {}): void {
		const st = statSync(absPath);
		this.records.set(absPath, { mtimeMs: st.mtimeMs, hash: hashContent(content), partial: !!opts.partial });
	}

	/** Record that we just wrote `content` to absPath (counts as a full read). */
	recordWrite(absPath: string, content: string | Buffer): void {
		const st = statSync(absPath);
		this.records.set(absPath, { mtimeMs: st.mtimeMs, hash: hashContent(content), partial: false });
	}

	has(absPath: string): boolean {
		return this.records.has(absPath);
	}

	forget(absPath: string): void {
		this.records.delete(absPath);
	}

	/**
	 * Check whether an existing file may be modified.
	 * Returns undefined when OK, or an error message for the model.
	 * Files that do not exist are always OK (new file creation).
	 */
	checkCanModify(absPath: string): string | undefined {
		let st;
		try {
			st = statSync(absPath);
		} catch {
			return undefined; // new file
		}
		if (st.isDirectory()) return `${absPath} is a directory.`;
		const rec = this.records.get(absPath);
		if (!rec) {
			return "File has not been read yet. Read it first before writing to it.";
		}
		if (st.mtimeMs !== rec.mtimeMs) {
			// mtime changed: compare content hash to avoid false positives (touch, same content)
			const current = hashContent(readFileSync(absPath));
			if (current !== rec.hash) {
				return "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.";
			}
			rec.mtimeMs = st.mtimeMs;
		}
		return undefined;
	}

	/** Paths read so far whose on-disk content changed since (for change reminders). */
	changedSinceRead(): string[] {
		const out: string[] = [];
		for (const [p, rec] of this.records) {
			try {
				const st = statSync(p);
				if (st.mtimeMs !== rec.mtimeMs && hashContent(readFileSync(p)) !== rec.hash) out.push(p);
			} catch {
				out.push(p);
			}
		}
		return out;
	}
}

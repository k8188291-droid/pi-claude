import { posix } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { InMemoryFs } from "just-bash";
import { DEFAULT_MEMORY_CWD, isWithin, normalizeVirtualPath } from "./paths.js";

/**
 * Snapshots: the whole virtual filesystem plus the pi session tree as one JSON-serializable object,
 * the format memory-pi-agent writes (version 1), so its snapshots load here unchanged. Reading and
 * writing the object (S3, a database, a file) is the caller's business; nothing here does I/O.
 * Credentials never belong in a snapshot: an `oauth` field from memory-pi-agent is ignored.
 */

export const MEMORY_SNAPSHOT_VERSION = 1;

/** Recreated by just-bash on every start (command stubs, /dev, /proc): never saved. */
export const REBUILT_RUNTIME_ROOTS = ["/bin", "/usr", "/proc", "/dev"];

export interface MemorySnapshotFile {
	encoding: "utf8" | "base64";
	data: string;
	mode?: number;
	mtimeMs?: number;
}

export interface MemorySnapshotDirectory {
	path: string;
	mode?: number;
	mtimeMs?: number;
}

type SessionHeader = NonNullable<ReturnType<SessionManager["getHeader"]>>;
type SessionEntry = ReturnType<SessionManager["getEntries"]>[number];

export interface SessionSnapshot {
	header: SessionHeader;
	entries: SessionEntry[];
	/** `null`: before the first entry; omitted: the last entry. */
	leafId?: string | null;
}

export interface MemorySnapshot {
	version: typeof MEMORY_SNAPSHOT_VERSION;
	cwd: string;
	/** A plain string is a UTF-8 file. */
	files: Record<string, string | MemorySnapshotFile>;
	directories?: Array<string | MemorySnapshotDirectory>;
	symlinks?: Record<string, string | { target: string; mode?: number }>;
	session?: SessionSnapshot;
}

export interface LoadedSnapshot {
	cwd: string;
	session?: SessionSnapshot;
}

/** Parse (when given as JSON text) and check a snapshot without touching any filesystem. */
export function parseSnapshot(input: MemorySnapshot | string): MemorySnapshot {
	const snapshot = (typeof input === "string" ? JSON.parse(input) : input) as MemorySnapshot;
	if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("Snapshot must be an object");
	if (snapshot.version !== MEMORY_SNAPSHOT_VERSION) throw new Error(`Unsupported snapshot version: ${String(snapshot.version)}`);
	return snapshot;
}

/** Restore a snapshot into `vfs` (existing entries at the same paths are overwritten). */
export async function loadSnapshot(vfs: InMemoryFs, input: MemorySnapshot | string): Promise<LoadedSnapshot> {
	const snapshot = parseSnapshot(input);
	const session = snapshot.session === undefined ? undefined : normalizeSessionSnapshot(snapshot.session);
	const times: Array<[string, number]> = [];
	for (const entry of snapshot.directories ?? []) {
		const dir = typeof entry === "string" ? { path: entry } : entry;
		const path = normalizeVirtualPath(dir.path, "/");
		await vfs.mkdir(path, { recursive: true });
		if (dir.mode !== undefined) await vfs.chmod(path, dir.mode);
		if (dir.mtimeMs !== undefined) times.push([path, dir.mtimeMs]);
	}
	for (const [rawPath, entry] of Object.entries(snapshot.files ?? {})) {
		const path = normalizeVirtualPath(rawPath, "/");
		await vfs.mkdir(posix.dirname(path), { recursive: true });
		if (typeof entry === "string") {
			await vfs.writeFile(path, new TextEncoder().encode(entry));
			continue;
		}
		const data = entry.encoding === "base64" ? new Uint8Array(Buffer.from(entry.data, "base64")) : new TextEncoder().encode(entry.data);
		await vfs.writeFile(path, data);
		if (entry.mode !== undefined) await vfs.chmod(path, entry.mode);
		if (entry.mtimeMs !== undefined) times.push([path, entry.mtimeMs]);
	}
	for (const [rawPath, entry] of Object.entries(snapshot.symlinks ?? {})) {
		const path = normalizeVirtualPath(rawPath, "/");
		await vfs.mkdir(posix.dirname(path), { recursive: true });
		await vfs.symlink(typeof entry === "string" ? entry : entry.target, path);
	}
	// last, so creating children does not move a directory's time
	for (const [path, mtimeMs] of times) await vfs.utimes(path, new Date(mtimeMs), new Date(mtimeMs));
	return { cwd: normalizeVirtualPath(snapshot.cwd ?? DEFAULT_MEMORY_CWD, "/"), session };
}

function isUtf8RoundTrip(bytes: Uint8Array): boolean {
	if (bytes.includes(0)) return false;
	const text = Buffer.from(bytes).toString("utf8");
	return Buffer.from(text, "utf8").equals(Buffer.from(bytes));
}

export interface SerializeSnapshotOptions {
	cwd?: string;
	/** Session to save with the files (its whole tree: branches, compactions, model changes). */
	sessionManager?: SessionManager;
	/** Extra virtual roots to leave out (in addition to /bin, /usr, /proc, /dev). */
	exclude?: string[];
}

/** The filesystem (and optionally the session) as a snapshot object; `JSON.stringify` it to store. */
export async function serializeSnapshot(vfs: InMemoryFs, options: SerializeSnapshotOptions = {}): Promise<MemorySnapshot> {
	const excluded = [...REBUILT_RUNTIME_ROOTS, ...(options.exclude ?? [])];
	const snapshot: MemorySnapshot = {
		version: MEMORY_SNAPSHOT_VERSION,
		cwd: normalizeVirtualPath(options.cwd ?? DEFAULT_MEMORY_CWD, "/"),
		directories: [],
		files: {},
		symlinks: {},
	};
	const session = serializeSessionSnapshot(options.sessionManager);
	if (session) snapshot.session = session;
	for (const path of vfs.getAllPaths().sort()) {
		if (path === "/" || excluded.some((root) => isWithin(path, root))) continue;
		const st = await vfs.lstat(path);
		const mtimeMs = st.mtime.getTime();
		if (st.isSymbolicLink) {
			snapshot.symlinks![path] = { target: await vfs.readlink(path), mode: st.mode };
		} else if (st.isDirectory) {
			snapshot.directories!.push({ path, mode: st.mode, mtimeMs });
		} else if (st.isFile) {
			const bytes = await vfs.readFileBuffer(path);
			snapshot.files[path] = isUtf8RoundTrip(bytes)
				? { encoding: "utf8", data: Buffer.from(bytes).toString("utf8"), mode: st.mode, mtimeMs }
				: { encoding: "base64", data: Buffer.from(bytes).toString("base64"), mode: st.mode, mtimeMs };
		}
	}
	return snapshot;
}

/** Check a stored session and return a deep copy. */
export function normalizeSessionSnapshot(value: unknown): SessionSnapshot {
	const v = value as Partial<SessionSnapshot> | null;
	if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("snapshot.session must be an object");
	if (!v.header || typeof v.header !== "object" || v.header.type !== "session") throw new Error("snapshot.session.header must be a session header");
	if (typeof v.header.id !== "string" || v.header.id.length === 0) throw new Error("snapshot.session.header.id must be a non-empty string");
	if (!Array.isArray(v.entries)) throw new Error("snapshot.session.entries must be an array");
	for (const entry of v.entries as unknown[]) {
		if (!entry || typeof entry !== "object" || (entry as { type?: unknown }).type === "session") {
			throw new Error("snapshot.session.entries contains an invalid session entry");
		}
	}
	if (v.leafId !== undefined && v.leafId !== null && typeof v.leafId !== "string") throw new Error("snapshot.session.leafId must be a string or null");
	return structuredClone({ header: v.header, entries: v.entries, ...(v.leafId !== undefined ? { leafId: v.leafId } : {}) });
}

export function serializeSessionSnapshot(sessionManager: SessionManager | undefined): SessionSnapshot | undefined {
	if (!sessionManager) return undefined;
	const header = sessionManager.getHeader();
	if (!header) throw new Error("Session has no header");
	return normalizeSessionSnapshot({ header, entries: sessionManager.getEntries(), leafId: sessionManager.getLeafId() });
}

/**
 * An in-memory `SessionManager`, restored from a snapshot's session when given (entry ids, branches,
 * compactions and the leaf kept exactly), or new.
 */
export function createSnapshotSessionManager(cwd: string, sessionSnapshot?: SessionSnapshot): SessionManager {
	if (!sessionSnapshot) return SessionManager.inMemory(cwd);
	const stored = normalizeSessionSnapshot(sessionSnapshot);
	// SessionManager migrates older entry versions itself while loading
	const fileEntries = [{ ...stored.header, cwd }, ...stored.entries];
	const sessionManager = SessionManager.inMemory(cwd, undefined, fileEntries);
	if (stored.leafId === null) sessionManager.resetLeaf();
	else if (stored.leafId !== undefined) sessionManager.branch(stored.leafId);
	return sessionManager;
}

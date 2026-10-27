import { posix } from "node:path";
import type { InMemoryFs } from "just-bash";
import type { HostDirent, HostFileSystem, HostStat } from "../host/types.js";
import { fsError, throwIfAborted, withCode } from "./errors.js";

/** Permission bits removed from requested modes, like a process umask of 022. */
const UMASK = 0o022;

type VfsStat = Awaited<ReturnType<InMemoryFs["stat"]>>;

function toHostStat(st: VfsStat, size = st.size): HostStat {
	return {
		isFile: st.isFile,
		isDirectory: st.isDirectory,
		isSymbolicLink: st.isSymbolicLink,
		// InMemoryFs has no FIFOs, sockets or devices (/dev/null is a plain file)
		isSpecial: false,
		size,
		mtimeMs: st.mtime instanceof Date ? st.mtime.getTime() : Number(st.mtime ?? 0),
		mode: st.mode & 0o7777,
	};
}

const toBytes = (data: Uint8Array | string): Uint8Array =>
	// always a private copy: InMemoryFs keeps the array it is given as the file body
	typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);

/**
 * `HostFileSystem` over a just-bash `InMemoryFs`.
 *
 * InMemoryFs is more permissive than POSIX (writing over a directory replaces it, writing below a
 * file or into a missing directory creates the parents, `chmod` changes a symlink instead of its
 * target) and its errors carry no `code`. Every method here checks the POSIX preconditions first and
 * rejects with the error `fs.promises` would give.
 */
export class MemoryFileSystem implements HostFileSystem {
	constructor(private readonly vfs: InMemoryFs) {}

	async stat(path: string): Promise<HostStat> {
		return toHostStat(await this.statOrThrow(path, "stat"));
	}

	async lstat(path: string): Promise<HostStat> {
		const real = await this.resolveParent(path, "lstat");
		let st: VfsStat;
		try {
			st = await this.vfs.lstat(real);
		} catch (err) {
			throw await this.refine(err, "lstat", path);
		}
		// Node reports a symlink's size as the length of its target
		const size = st.isSymbolicLink ? Buffer.byteLength(await this.vfs.readlink(real)) : st.size;
		return toHostStat(st, size);
	}

	async realpath(path: string): Promise<string> {
		try {
			return await this.vfs.realpath(path);
		} catch (err) {
			throw await this.refine(err, "realpath", path);
		}
	}

	async readFile(path: string, options?: { signal?: AbortSignal }): Promise<Uint8Array> {
		throwIfAborted(options?.signal);
		const body = await this.body(path);
		throwIfAborted(options?.signal);
		return Buffer.from(body);
	}

	async readRange(path: string, start: number, length: number, options?: { signal?: AbortSignal }): Promise<Uint8Array> {
		throwIfAborted(options?.signal);
		if (!Number.isInteger(start) || start < 0 || !Number.isInteger(length) || length < 0) {
			throw fsError("EINVAL", "read", path, `invalid range start=${start} length=${length}`);
		}
		const body = await this.body(path);
		throwIfAborted(options?.signal);
		// copies only the requested bytes (the body itself is InMemoryFs's own buffer)
		return Buffer.from(body.subarray(Math.min(start, body.length), Math.min(start + length, body.length)));
	}

	async writeFile(path: string, data: Uint8Array | string, options?: { mode?: number }): Promise<void> {
		const { target, existed } = await this.prepareWrite(path, "open");
		try {
			// InMemoryFs resets the mode of a file it overwrites; truncating keeps it
			const keepMode = existed ? (await this.vfs.stat(target)).mode : undefined;
			await this.vfs.writeFile(target, toBytes(data));
			if (keepMode !== undefined) await this.vfs.chmod(target, keepMode);
			else if (options?.mode !== undefined) await this.vfs.chmod(target, options.mode & 0o7777 & ~UMASK);
		} catch (err) {
			throw withCode(err, "open", path);
		}
	}

	async appendFile(path: string, data: Uint8Array | string, options?: { mode?: number }): Promise<void> {
		const { target, existed } = await this.prepareWrite(path, "open");
		try {
			if (existed) await this.vfs.appendFile(target, toBytes(data));
			else {
				await this.vfs.writeFile(target, toBytes(data));
				if (options?.mode !== undefined) await this.vfs.chmod(target, options.mode & 0o7777 & ~UMASK);
			}
		} catch (err) {
			throw withCode(err, "open", path);
		}
	}

	async mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void> {
		const mode = options?.mode === undefined ? undefined : options.mode & 0o7777 & ~UMASK;
		const create = async (dir: string) => {
			try {
				await this.vfs.mkdir(dir);
				if (mode !== undefined) await this.vfs.chmod(dir, mode);
			} catch (err) {
				throw withCode(err, "mkdir", path);
			}
		};
		const abs = posix.resolve("/", path);
		if (!options?.recursive) {
			const target = await this.resolveParent(abs, "mkdir");
			if (await this.lexists(target)) throw fsError("EEXIST", "mkdir", path);
			await create(target);
			return;
		}
		const parts = abs.split("/").filter(Boolean);
		let current = "/";
		for (let i = 0; i < parts.length; i++) {
			current = posix.join(current, parts[i]);
			const st = await this.tryStat(current);
			if (st === "loop") throw fsError("ELOOP", "mkdir", path);
			if (st) {
				if (!st.isDirectory) throw fsError(i === parts.length - 1 ? "EEXIST" : "ENOTDIR", "mkdir", path);
				continue;
			}
			// a dangling symlink occupies the name
			if (await this.lexists(current)) throw fsError("EEXIST", "mkdir", path);
			await create(current);
		}
	}

	async readdir(path: string): Promise<HostDirent[]> {
		const st = await this.statOrThrow(path, "scandir");
		if (!st.isDirectory) throw fsError("ENOTDIR", "scandir", path);
		try {
			const entries = await this.vfs.readdirWithFileTypes(await this.vfs.realpath(path));
			return entries.map((e) => ({ name: e.name, isFile: e.isFile, isDirectory: e.isDirectory, isSymbolicLink: e.isSymbolicLink }));
		} catch (err) {
			throw withCode(err, "scandir", path);
		}
	}

	async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		let target: string;
		try {
			target = await this.resolveParent(path, "rm");
		} catch (err) {
			if (options?.force && (err as { code?: string }).code === "ENOENT") return;
			throw err;
		}
		let st: VfsStat;
		try {
			st = await this.vfs.lstat(target);
		} catch (err) {
			const e = await this.refine(err, "rm", path);
			if (options?.force && e.code === "ENOENT") return;
			throw e;
		}
		// fs.rm refuses a directory without `recursive` (Node: ERR_FS_EISDIR, errno EISDIR)
		if (st.isDirectory && !options?.recursive) throw fsError("EISDIR", "rm", path, "is a directory");
		try {
			await this.vfs.rm(target, { recursive: true, force: options?.force });
		} catch (err) {
			throw withCode(err, "rm", path);
		}
	}

	async chmod(path: string, mode: number): Promise<void> {
		// chmod follows symlinks; InMemoryFs.chmod would change the link entry itself
		const real = await this.realpath(path).catch((err: { code?: string }) => {
			throw err.code === "ENOENT" ? fsError("ENOENT", "chmod", path) : err;
		});
		try {
			await this.vfs.chmod(real, mode & 0o7777);
		} catch (err) {
			throw withCode(err, "chmod", path);
		}
	}

	// ---------------------------------------------------------------------------------------------

	/** The file body (InMemoryFs's own array: never hand it out without copying). */
	private async body(path: string): Promise<Uint8Array> {
		const st = await this.statOrThrow(path, "open");
		if (st.isDirectory) throw fsError("EISDIR", "read", path);
		try {
			return await this.vfs.readFileBuffer(path);
		} catch (err) {
			throw await this.refine(err, "open", path);
		}
	}

	private async statOrThrow(path: string, syscall: string): Promise<VfsStat> {
		try {
			return await this.vfs.stat(path);
		} catch (err) {
			throw await this.refine(err, syscall, path);
		}
	}

	/** stat, or undefined when missing, or "loop" for a symlink cycle. */
	private async tryStat(path: string): Promise<VfsStat | undefined | "loop"> {
		try {
			return await this.vfs.stat(path);
		} catch (err) {
			const code = withCode(err, "stat", path).code;
			if (code === "ELOOP") return "loop";
			return undefined;
		}
	}

	private async lexists(path: string): Promise<boolean> {
		try {
			await this.vfs.lstat(path);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * `path` with its parent directory's symlinks resolved, so InMemoryFs (which keys entries by
	 * literal path) acts on the entry the kernel would. Rejects with ENOENT/ENOTDIR when the parent
	 * is missing or not a directory.
	 */
	private async resolveParent(path: string, syscall: string): Promise<string> {
		const abs = posix.resolve("/", path);
		if (abs === "/") return abs;
		const parent = posix.dirname(abs);
		const st = await this.tryStat(parent);
		if (st === "loop") throw fsError("ELOOP", syscall, path);
		if (!st) throw await this.refine(fsError("ENOENT", syscall, path), syscall, path);
		if (!st.isDirectory) throw fsError("ENOTDIR", syscall, path);
		return posix.join(await this.vfs.realpath(parent), posix.basename(abs));
	}

	/** Where a write to `path` lands (following a final symlink), and whether that file exists. */
	private async prepareWrite(path: string, syscall: string): Promise<{ target: string; existed: boolean }> {
		let target = await this.resolveParent(path, syscall);
		for (let hops = 0; ; hops++) {
			if (hops > 40) throw fsError("ELOOP", syscall, path);
			let lst: VfsStat;
			try {
				lst = await this.vfs.lstat(target);
			} catch {
				return { target, existed: false };
			}
			if (lst.isDirectory) throw fsError("EISDIR", syscall, path);
			if (!lst.isSymbolicLink) return { target, existed: true };
			// follow the link (a dangling one creates its target, as open(O_CREAT) does)
			const link = await this.vfs.readlink(target);
			target = await this.resolveParent(posix.resolve(posix.dirname(target), link), syscall);
		}
	}

	/** Give an error its code; an ENOENT below an existing non-directory becomes ENOTDIR (as in Node). */
	private async refine(err: unknown, syscall: string, path: string) {
		const e = withCode(err, syscall, path);
		if (e.code !== "ENOENT") return e;
		const parts = posix.resolve("/", path).split("/").filter(Boolean);
		let current = "/";
		for (let i = 0; i < parts.length - 1; i++) {
			current = posix.join(current, parts[i]);
			const st = await this.tryStat(current);
			if (st === "loop") return fsError("ELOOP", syscall, path);
			if (!st) break;
			if (!st.isDirectory) return fsError("ENOTDIR", syscall, path);
		}
		return e;
	}
}

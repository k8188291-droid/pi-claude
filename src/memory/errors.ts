/**
 * Node-style filesystem errors for the memory host. just-bash's `InMemoryFs` throws plain `Error`s
 * whose message starts with the code ("ENOENT: no such file or directory, stat '/x'") but carries no
 * `code` property; the tools branch on `code`, so every error leaving the memory host gets one.
 */

const DESCRIPTIONS: Record<string, string> = {
	EACCES: "permission denied",
	EEXIST: "file already exists",
	EINVAL: "invalid argument",
	EISDIR: "illegal operation on a directory",
	ELOOP: "too many levels of symbolic links",
	ENOENT: "no such file or directory",
	ENOSPC: "no space left on device",
	ENOTDIR: "not a directory",
	ENOTEMPTY: "directory not empty",
	EPERM: "operation not permitted",
};

export interface FsError extends Error {
	code: string;
	syscall?: string;
	path?: string;
}

export function fsError(code: string, syscall: string, path: string, detail?: string): FsError {
	const err = new Error(`${code}: ${detail ?? DESCRIPTIONS[code] ?? "error"}, ${syscall} '${path}'`) as FsError;
	err.code = code;
	err.syscall = syscall;
	err.path = path;
	return err;
}

/** Give an `InMemoryFs` error its Node-style `code` (parsed from the message prefix). */
export function withCode(error: unknown, syscall: string, path: string): FsError {
	if (error instanceof Error) {
		const e = error as FsError;
		if (typeof e.code === "string") return e;
		const m = /^(E[A-Z0-9]+):/.exec(e.message);
		if (m) {
			e.code = m[1];
			e.syscall ??= syscall;
			e.path ??= path;
			return e;
		}
		const wrapped = fsError("EIO", syscall, path, e.message);
		wrapped.cause = e;
		return wrapped;
	}
	return fsError("EIO", syscall, path, String(error));
}

export function abortError(): Error {
	const err = new Error("The operation was aborted");
	err.name = "AbortError";
	(err as FsError).code = "ABORT_ERR";
	return err;
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw abortError();
}

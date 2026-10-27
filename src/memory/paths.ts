import { posix } from "node:path";

/** Default working directory inside the virtual filesystem. */
export const DEFAULT_MEMORY_CWD = "/workspace";

/** Absolute, normalized virtual path (`relative` is resolved against `cwd`). */
export function normalizeVirtualPath(path: string, cwd = DEFAULT_MEMORY_CWD): string {
	if (typeof path !== "string" || path.length === 0) throw new Error("Path must be a non-empty string");
	const resolved = path.startsWith("/") ? posix.normalize(path) : posix.resolve(cwd, path);
	const absolute = resolved.startsWith("/") ? resolved : `/${resolved}`;
	return absolute.length > 1 && absolute.endsWith("/") ? absolute.slice(0, -1) : absolute;
}

/** True when `path` is `root` or lies below it. */
export function isWithin(path: string, root: string): boolean {
	const p = normalizeVirtualPath(path, "/");
	const r = normalizeVirtualPath(root, "/");
	return p === r || p.startsWith(r === "/" ? "/" : `${r}/`);
}

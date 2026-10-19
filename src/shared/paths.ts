import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { CCContext } from "./context.js";
import { isFixed } from "./quirks.js";

export interface ResolvePathOptions {
	/**
	 * Trim surrounding whitespace first. Claude Code does, so "name " targets "name" (quirk #8,
	 * `pathTrim`). Default true.
	 */
	trim?: boolean;
}

/** Resolve a user/model supplied path against cwd, expanding a leading "~". */
export function resolvePath(cwd: string, p: string, opts: ResolvePathOptions = {}): string {
	let path = opts.trim === false ? p : p.trim();
	if (path === "~") path = homedir();
	else if (path.startsWith("~/")) path = homedir() + path.slice(1);
	return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

/**
 * Resolve a file tool's path argument. By default this is `resolvePath` (trimmed, like Claude
 * Code). With the `pathTrim` quirk fixed the path is used verbatim, and an empty or
 * whitespace-only path is rejected instead of silently resolving to the working directory.
 */
export function resolveToolPath(cc: Pick<CCContext, "options">, cwd: string, p: string, paramName = "file_path"): string {
	if (!isFixed(cc, "pathTrim")) return resolvePath(cwd, p);
	if (p.trim() === "") throw new Error(`${paramName} must not be empty.`);
	return resolvePath(cwd, p, { trim: false });
}

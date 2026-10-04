import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

/** Resolve a user/model supplied path against cwd, expanding a leading "~". */
export function resolvePath(cwd: string, p: string): string {
	let path = p.trim();
	if (path === "~") path = homedir();
	else if (path.startsWith("~/")) path = homedir() + path.slice(1);
	return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

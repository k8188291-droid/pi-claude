import { posix } from "node:path";
import type { InMemoryFs } from "just-bash";
import { minimatch } from "minimatch";
import type { HostGlobMatch, HostGlobOptions } from "../host/types.js";
import { abortError, fsError, withCode } from "./errors.js";

/**
 * A matcher with the semantics of `rg --files --glob <pattern>` (what Glob runs on the local host),
 * checked against ripgrep 14: a pattern without `/` matches the file name at any depth, a pattern
 * with `/` matches the path relative to the search root (a leading `/` only anchors), `!pattern`
 * excludes, brace sets and character classes work, `*` matches a leading dot, and a pattern naming a
 * directory matches no files (only `dir/**` does).
 */
export function globMatcher(pattern: string): (relativePath: string) => boolean {
	const negated = pattern.startsWith("!");
	let body = negated ? pattern.slice(1) : pattern;
	if (body.startsWith("/")) body = body.slice(1);
	const matchBase = !body.includes("/");
	const test = (rel: string) => minimatch(rel, body, { dot: true, matchBase, nonegate: true, nocomment: true });
	return negated ? (rel) => !test(rel) : test;
}

/**
 * Files (not directories, not symlinks: ripgrep does not follow them) under `cwd` matching
 * `pattern`, hidden files and node_modules included, oldest first (`--sort=modified`).
 */
export async function memoryGlob(vfs: InMemoryFs, pattern: string, options: HostGlobOptions): Promise<HostGlobMatch[]> {
	const { signal } = options;
	if (signal?.aborted) throw abortError();
	const root = posix.resolve("/", options.cwd);
	let st;
	try {
		st = await vfs.stat(root);
	} catch (err) {
		throw withCode(err, "scandir", root);
	}
	if (!st.isDirectory) throw fsError("ENOTDIR", "scandir", root);
	const realRoot = await vfs.realpath(root);
	const prefix = realRoot === "/" ? "/" : `${realRoot}/`;
	const matches = globMatcher(pattern);
	const out: HostGlobMatch[] = [];
	let n = 0;
	for (const path of vfs.getAllPaths()) {
		if (!path.startsWith(prefix) || path === realRoot) continue;
		if (++n % 1000 === 0) {
			if (signal?.aborted) throw abortError();
			await new Promise((r) => setImmediate(r));
		}
		const rel = path.slice(prefix.length);
		if (!matches(rel)) continue;
		let lst;
		try {
			lst = await vfs.lstat(path);
		} catch {
			continue;
		}
		if (!lst.isFile) continue;
		out.push({ path: posix.join(root, rel), mtimeMs: lst.mtime.getTime() });
	}
	if (signal?.aborted) throw abortError();
	return out.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

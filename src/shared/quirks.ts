import type { CCContext } from "./context.js";

/**
 * Behaviors where Claude Code itself is arguably buggy. pi-claude reproduces them by default
 * ("claude-code") so it stays byte-compatible with Claude Code; "fixed" switches to the corrected
 * behavior. See docs/review-2026-10-18.md (section C) for each item.
 */
export const QUIRKS = {
	/** #1: the Bash wrapper runs the command in an `&&` condition, so `set -e` is ignored. */
	bashErrexit: "Bash ignores `set -e` (command runs inside an && condition)",
	/** #11: processes started with `&` survive the shell and the session. */
	orphanProcesses: "background children of a Bash command outlive it",
	/** #2c: agent definitions with `disallowedTools: "*"` are ignored. */
	agentDisallowAll: 'agent disallowedTools "*" is ignored',
	/** #3: isolation "remote" silently falls back to a local worktree or the parent cwd. */
	remoteIsolationFallback: 'isolation "remote" silently runs locally',
	/** #5: change detection relies on mtime only (restored mtime hides external edits). */
	mtimeOnlyChangeDetection: "file change detection uses mtime only",
	/** #6b: NotebookEdit checks staleness (reading the whole file) before the size limit. */
	notebookStaleBeforeSize: "NotebookEdit reads the whole file before its size check",
	/** #7a/#7c: FIFOs/devices named like images block Read; reads are not abortable. */
	specialFileReads: "special files (FIFOs) can block Read and cannot be aborted",
	/** #8: paths are trim()med, so "name " targets "name". */
	pathTrim: "file paths are trimmed",
	/** #16: permission/IO errors in Grep/Glob are reported as "no matches". */
	searchPermissionErrors: "search permission errors look like no matches",
	/** #18: Read's token limit ignores the line-number prefixes. */
	readTokenCountLineNumbers: "Read token limit ignores line numbers",
	/** #19: replace_all deletion misses a final match without a trailing newline. */
	replaceAllTrailingMatch: "replace_all deletion misses a final match without newline",
	/** #27: notebook cell type conversion keeps/drops fields like Claude Code. */
	notebookCellTypeConversion: "notebook cell type conversion fields",
} as const;

export type Quirk = keyof typeof QUIRKS;
export type QuirkMode = "claude-code" | "fixed";

/** True when `quirk` should use the corrected behavior instead of Claude Code's. */
export function isFixed(cc: Pick<CCContext, "options">, quirk: Quirk): boolean {
	const mode = cc.options.quirks?.[quirk] ?? cc.options.compat ?? "claude-code";
	return mode === "fixed";
}

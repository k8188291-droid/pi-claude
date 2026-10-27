import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { ClaudeCodeHost, HostFileSystem } from "../host/types.js";
import type { CCContext } from "../shared/context.js";
import { resolvePath } from "../shared/paths.js";
import { textResult } from "../shared/text.js";
import { isFixed } from "../shared/quirks.js";
import { displayPath, missingPathMessage, runRipgrep, splitNullOutput, surfacePathErrors, type SearchOptions } from "./grep.js";

export const GLOB_TOOL_NAME = "Glob";
export const GLOB_MAX_RESULTS = 100;

// Mirrors Claude Code's Glob tool description verbatim.
const DESCRIPTION = `- Fast file pattern matching tool that works with any codebase size
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths sorted by modification time
- Use this tool when you need to find files by name patterns
- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead (if available)`;

const globSchema = Type.Object({
	pattern: Type.String({ description: "The glob pattern to match files against" }),
	path: Type.Optional(
		Type.String({
			description:
				'The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.',
		}),
	),
});

export type GlobParams = Static<typeof globSchema>;

/** Same shape as Claude Code's Glob output. */
export interface GlobDetails {
	durationMs: number;
	/** Number of file paths returned (after truncation). */
	numFiles: number;
	filenames: string[];
	truncated: boolean;
	/** Total number of matching files before truncation. */
	totalMatches: number;
	countIsComplete: boolean;
}

/** Claude Code's truncation line. */
export function globTruncationNote(shown: number, total: number): string {
	return `(Showing ${shown} of ${total} matching files; ${total - shown} more are not listed. Narrow the pattern or path to see the rest.)`;
}

function envFlag(name: string, dflt: boolean): boolean {
	const v = process.env[name];
	if (v === undefined || v === "") return dflt;
	return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

/**
 * An absolute pattern is split into its literal base directory and the rest
 * ("/repo/src/**\/*.ts" → "/repo/src" + "**\/*.ts"); the base directory replaces `path`.
 */
export function splitAbsolutePattern(pattern: string): { baseDir: string; relativePattern: string } | null {
	if (!isAbsolute(pattern)) return null;
	const m = /[*?[{]/.exec(pattern);
	if (!m) return { baseDir: dirname(pattern), relativePattern: basename(pattern) };
	const literal = pattern.slice(0, m.index);
	const cut = Math.max(literal.lastIndexOf("/"), literal.lastIndexOf(sep));
	if (cut === -1) return null;
	let baseDir = literal.slice(0, cut);
	if (baseDir === "" && cut === 0) baseDir = "/";
	if (!baseDir) return null;
	return { baseDir, relativePattern: pattern.slice(cut + 1) };
}

/**
 * When the pattern repeats the tail of the search directory ("src/**\/*.ts" searched in ".../src"),
 * return the pattern anchored without that prefix ("/**\/*.ts"); otherwise the pattern unchanged.
 */
export function stripRepeatedDirPrefix(pattern: string, searchDir: string): string {
	const segs = pattern.split("/");
	let literal = 0;
	while (literal < segs.length - 1 && segs[literal] !== "" && !/[*?[\]{}!]/.test(segs[literal])) literal++;
	const dirSegs = searchDir.split(/[\\/]+/).filter(Boolean);
	for (let n = literal; n > 0; n--) {
		const head = segs.slice(0, n);
		const tail = dirSegs.slice(-n);
		if (tail.length === n && head.every((s, i) => s === tail[i])) return "/" + segs.slice(n).join("/");
	}
	return pattern;
}

/** True when every segment exists under `dir` as a real (non-symlink) directory. */
async function prefixIsRealDir(fs: HostFileSystem, dir: string, segs: string[]): Promise<boolean> {
	let p = dir;
	for (const s of segs) {
		p = join(p, s);
		try {
			const st = await fs.lstat(p);
			if (!st.isDirectory || st.isSymbolicLink) return false;
		} catch {
			return false;
		}
	}
	return segs.length > 0;
}

export async function executeGlob(
	host: ClaudeCodeHost,
	params: GlobParams,
	cwd: string,
	signal?: AbortSignal,
	options: SearchOptions = {},
): Promise<{ text: string; details: GlobDetails }> {
	const start = Date.now();
	if (typeof params.pattern !== "string") throw new Error("pattern must be a string");
	if (signal?.aborted) throw new Error("Operation aborted");

	const abs = splitAbsolutePattern(params.pattern);
	const pathOpts = { homeDir: host.homeDir, trim: !options.exactPaths };
	const searchDir = abs ? resolve(abs.baseDir) : params.path ? resolvePath(cwd, params.path, pathOpts) : resolve(cwd);

	// The path parameter is validated only when it is the directory searched.
	if (params.path && searchDir === resolvePath(cwd, params.path, pathOpts)) {
		let st;
		try {
			st = await host.fs.stat(searchDir);
		} catch {
			throw new Error(await missingPathMessage(host.fs, "Directory", params.path, searchDir, cwd));
		}
		if (!st.isDirectory) throw new Error(`Path is not a directory: ${params.path}`);
	}

	let pattern = abs ? abs.relativePattern : params.pattern;
	if (!abs) {
		const stripped = stripRepeatedDirPrefix(pattern, searchDir);
		if (stripped !== pattern) {
			const restSegs = stripped.replace(/^\//, "").split("/").length;
			const segs = pattern.split("/");
			if (!(await prefixIsRealDir(host.fs, searchDir, segs.slice(0, Math.max(1, segs.length - restSegs))))) pattern = stripped;
		}
	}

	const details: GlobDetails = { durationMs: 0, numFiles: 0, filenames: [], truncated: false, totalMatches: 0, countIsComplete: true };
	let isDir = false;
	try {
		isDir = (await host.fs.stat(searchDir)).isDirectory;
	} catch {
		details.durationMs = Date.now() - start;
		return { text: "No files found", details };
	}

	const args = ["--files", "--null", "--glob", pattern, "--sort=modified"];
	if (envFlag("CLAUDE_CODE_GLOB_NO_IGNORE", true)) args.push("--no-ignore");
	if (envFlag("CLAUDE_CODE_GLOB_HIDDEN", true)) args.push("--hidden");
	args.push(isDir ? "." : searchDir);
	const run = await runRipgrep(host, args, isDir ? searchDir : dirname(searchDir), signal);
	if (signal?.aborted) throw new Error("Operation aborted");

	const toAbs = (p: string) => (isDir ? join(searchDir, p.startsWith("./") ? p.slice(2) : p) : p);
	const files = splitNullOutput(run.lines, "files_with_matches").map(toAbs);
	const shown = files.slice(0, GLOB_MAX_RESULTS).map((f) => displayPath(cwd, f));
	details.filenames = shown;
	details.numFiles = shown.length;
	details.truncated = files.length > GLOB_MAX_RESULTS;
	details.totalMatches = files.length;
	details.durationMs = Date.now() - start;
	let text =
		shown.length === 0
			? "No files found"
			: [...shown, ...(details.truncated ? [globTruncationNote(shown.length, files.length)] : [])].join("\n");
	if (options.surfacePathErrors) text = surfacePathErrors(text, shown.length === 0, run.stderr, (p) => displayPath(cwd, toAbs(p)));
	return { text, details };
}

export function registerGlob(pi: ExtensionAPI, cc: CCContext): void {
	pi.registerTool({
		name: GLOB_TOOL_NAME,
		label: "Glob",
		description: DESCRIPTION,
		promptSnippet: 'Find files by glob pattern (e.g. "**/*.ts"), oldest first',
		parameters: globSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { text, details } = await executeGlob(cc.host, params, ctx.cwd, signal, {
				surfacePathErrors: isFixed(cc, "searchPermissionErrors"),
				exactPaths: isFixed(cc, "pathTrim"),
			});
			return textResult<GlobDetails>(text, details);
		},
	});
}

import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { glob } from "glob";
import { Type, type Static } from "typebox";
import type { CCContext } from "../shared/context.js";
import { resolvePath } from "../shared/paths.js";
import { textResult } from "../shared/text.js";

export const GLOB_TOOL_NAME = "Glob";
export const GLOB_MAX_RESULTS = 100;
export const GLOB_TRUNCATION_NOTE = "(Results are truncated. Consider using a more specific path or pattern.)";

const DESCRIPTION =
	'Fast file pattern matching. Supports glob patterns like "**/*.js" or "src/**/*.ts". Returns matching file paths sorted by modification time (most recently modified first).';

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

export interface GlobDetails {
	/** Total number of matching files (before truncation). */
	numFiles: number;
	truncated: boolean;
	durationMs: number;
}

/**
 * Directories skipped by default because they are almost never what the model wants and can be huge.
 * Each is only skipped when the pattern does not itself mention that directory name as a path segment
 * (e.g. "node_modules/foo/**" or "**\/.git/config" still work).
 * .gitignore files are NOT consulted (plain glob semantics, like Claude Code's Glob), so build output
 * and other ignored files are still matched; dotfiles are included.
 */
export const GLOB_DEFAULT_IGNORED_DIRS = ["node_modules", ".git", ".svn", ".hg", ".jj", ".sl", ".bzr"];

function patternMentionsDir(pattern: string, dir: string): boolean {
	return pattern.split(/[\\/]/).some((seg) => seg === dir);
}

export function defaultIgnores(pattern: string): string[] {
	return GLOB_DEFAULT_IGNORED_DIRS.filter((d) => !patternMentionsDir(pattern, d)).map((d) => `**/${d}/**`);
}

export async function executeGlob(
	params: GlobParams,
	cwd: string,
	signal?: AbortSignal,
): Promise<{ text: string; details: GlobDetails }> {
	const start = Date.now();
	if (typeof params.pattern !== "string" || params.pattern.trim() === "") {
		throw new Error("pattern must be a non-empty string");
	}
	if (signal?.aborted) throw new Error("Operation aborted");

	// Some models pass the literal strings "undefined"/"null" despite instructions; treat as omitted.
	const rawPath = params.path && params.path !== "undefined" && params.path !== "null" ? params.path : undefined;
	const searchDir = rawPath ? resolvePath(cwd, rawPath) : resolve(cwd);
	let st;
	try {
		st = statSync(searchDir);
	} catch {
		throw new Error(`Directory does not exist: ${rawPath ?? searchDir}. Current working directory: ${cwd}.`);
	}
	if (!st.isDirectory()) throw new Error(`Path is not a directory: ${rawPath ?? searchDir}`);

	let matches;
	try {
		matches = await glob(params.pattern, {
			cwd: searchDir,
			withFileTypes: true,
			stat: true,
			nodir: true,
			dot: true,
			follow: false,
			ignore: defaultIgnores(params.pattern),
			signal,
		});
	} catch (err) {
		if (signal?.aborted) throw new Error("Operation aborted");
		throw err;
	}
	if (signal?.aborted) throw new Error("Operation aborted");

	const files = matches.map((p) => ({ path: p.fullpath(), mtime: p.mtimeMs ?? 0 }));
	files.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));

	const truncated = files.length > GLOB_MAX_RESULTS;
	const shown = files.slice(0, GLOB_MAX_RESULTS).map((f) => f.path);
	const details: GlobDetails = { numFiles: files.length, truncated, durationMs: Date.now() - start };
	if (shown.length === 0) return { text: "No files found", details };
	let text = shown.join("\n");
	if (truncated) text += `\n${GLOB_TRUNCATION_NOTE}`;
	return { text, details };
}

export function registerGlob(pi: ExtensionAPI, _cc: CCContext): void {
	pi.registerTool({
		name: GLOB_TOOL_NAME,
		label: "Glob",
		description: DESCRIPTION,
		promptSnippet: 'Find files by glob pattern (e.g. "**/*.ts"), newest first',
		parameters: globSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { text, details } = await executeGlob(params, ctx.cwd, signal);
			return textResult<GlobDetails>(text, details);
		},
	});
}

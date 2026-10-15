import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { CCContext } from "../shared/context.js";
import { resolvePath } from "../shared/paths.js";
import { textResult } from "../shared/text.js";

export const GREP_TOOL_NAME = "Grep";

const DEFAULT_HEAD_LIMIT = 250;
/** Hard cap on raw rg stdout we buffer, to protect memory when head_limit is 0 on a huge tree. */
const MAX_RG_OUTPUT_BYTES = 20 * 1024 * 1024;
/** Lines longer than this are replaced by rg with an "[Omitted long line ...]" marker (minified files etc.). */
const MAX_COLUMNS = 500;
/** Version-control directories never searched (--hidden would otherwise include them). */
const VCS_DIRS = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"];

const DESCRIPTION = `Content search built on ripgrep. Prefer this over \`grep\`/\`rg\` via Bash.

- Full regex syntax (e.g. "log.*Error", "function\\s+\\w+"). Ripgrep, not grep — escape literal braces (\`interface\\{\\}\`).
- Filter with \`glob\` (e.g. "**/*.tsx") or \`type\` (e.g. "js", "py", "rust").
- \`output_mode\`: "content" (matching lines), "files_with_matches" (paths only, default), or "count".
- \`multiline: true\` for patterns that span lines.`;

const grepSchema = Type.Object({
	pattern: Type.String({ description: "The regular expression pattern to search for in file contents" }),
	path: Type.Optional(
		Type.String({ description: "File or directory to search in (rg PATH). Defaults to current working directory." }),
	),
	glob: Type.Optional(
		Type.String({ description: 'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob' }),
	),
	output_mode: Type.Optional(
		StringEnum(["content", "files_with_matches", "count"] as const, {
			description:
				'Output mode: "content" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), "files_with_matches" shows file paths (supports head_limit), "count" shows match counts (supports head_limit). Defaults to "files_with_matches".',
		}),
	),
	"-B": Type.Optional(
		Type.Number({
			description: 'Number of lines to show before each match (rg -B). Requires output_mode: "content", ignored otherwise.',
		}),
	),
	"-A": Type.Optional(
		Type.Number({
			description: 'Number of lines to show after each match (rg -A). Requires output_mode: "content", ignored otherwise.',
		}),
	),
	"-C": Type.Optional(Type.Number({ description: "Alias for context." })),
	context: Type.Optional(
		Type.Number({
			description:
				'Number of lines to show before and after each match (rg -C). Requires output_mode: "content", ignored otherwise.',
		}),
	),
	"-n": Type.Optional(
		Type.Boolean({
			description:
				'Show line numbers in output (rg -n). Requires output_mode: "content", ignored otherwise. Defaults to true.',
		}),
	),
	"-i": Type.Optional(Type.Boolean({ description: "Case insensitive search (rg -i)" })),
	"-o": Type.Optional(
		Type.Boolean({
			description:
				'Print only the matched (non-empty) parts of each matching line, one match per output line (rg -o / --only-matching). Requires output_mode: "content", ignored otherwise. Defaults to false.',
		}),
	),
	type: Type.Optional(
		Type.String({
			description:
				"File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than include for standard file types.",
		}),
	),
	head_limit: Type.Optional(
		Type.Number({
			description:
				'Limit output to first N lines/entries, equivalent to "| head -N". Works across all output modes: content (limits output lines), files_with_matches (limits file paths), count (limits count entries). Defaults to 250 when unspecified. Pass 0 for unlimited (use sparingly — large result sets waste context).',
		}),
	),
	offset: Type.Optional(
		Type.Number({
			description:
				'Skip first N lines/entries before applying head_limit, equivalent to "| tail -n +N | head -N". Works across all output modes. Defaults to 0.',
		}),
	),
	multiline: Type.Optional(
		Type.Boolean({
			description:
				"Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false.",
		}),
	),
});

export type GrepParams = Static<typeof grepSchema>;
export type GrepOutputMode = "content" | "files_with_matches" | "count";

export interface GrepDetails {
	mode: GrepOutputMode;
	/** files_with_matches / count: number of matching files (before paging). */
	numFiles?: number;
	/** content: number of output lines (before paging). */
	numLines?: number;
	/** count: total number of matches. */
	numMatches?: number;
	/** Set when head_limit cut the result. */
	appliedLimit?: number;
	appliedOffset?: number;
	/** Set when rg output exceeded the internal byte cap and was cut short. */
	outputCapped?: boolean;
}

// ---------------------------------------------------------------------------
// ripgrep resolution
// ---------------------------------------------------------------------------

let cachedRgPath: string | undefined;

function commandWorks(cmd: string): boolean {
	try {
		const r = spawnSync(cmd, ["--version"], { stdio: "ignore" });
		return !r.error && r.status === 0;
	} catch {
		return false;
	}
}

/**
 * Locate ripgrep the same way pi does: pi's managed bin dir (<agentDir>/bin/rg) first,
 * then `rg` on PATH, then (best effort) pi's own `ensureTool` downloader. That module is not
 * part of pi's public exports, so it is loaded by file path; failures fall through to a clear error.
 */
export async function resolveRgPath(): Promise<string> {
	if (cachedRgPath) return cachedRgPath;
	const exe = process.platform === "win32" ? "rg.exe" : "rg";
	try {
		const local = join(getAgentDir(), "bin", exe);
		if (existsSync(local)) return (cachedRgPath = local);
	} catch {
		// ignore
	}
	if (commandWorks("rg")) return (cachedRgPath = "rg");
	try {
		const require = createRequire(import.meta.url);
		const entry = require.resolve("@earendil-works/pi-coding-agent");
		const managerPath = join(dirname(entry), "utils", "tools-manager.js");
		if (existsSync(managerPath)) {
			const mod: any = await import(pathToFileURL(managerPath).href);
			const p = await mod.ensureTool?.("rg", true);
			if (typeof p === "string" && p) return (cachedRgPath = p);
		}
	} catch {
		// ignore
	}
	throw new Error(
		"ripgrep (rg) is not installed or not on PATH. Install ripgrep (https://github.com/BurntSushi/ripgrep) to use Grep.",
	);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Split a glob parameter into individual rg --glob values. Whitespace separates patterns;
 * commas separate patterns too, except inside brace expressions like "*.{ts,tsx}".
 */
export function splitGlobs(glob: string): string[] {
	const out: string[] = [];
	for (const part of glob.split(/\s+/)) {
		if (!part) continue;
		if (part.includes("{")) out.push(part);
		else out.push(...part.split(",").filter(Boolean));
	}
	return out;
}

function nonNegInt(v: number | undefined): number | undefined {
	if (v === undefined || v === null || !Number.isFinite(v)) return undefined;
	return Math.max(0, Math.floor(v));
}

function applyPaging<T>(items: T[], limit: number, offset: number): { items: T[]; truncated: boolean } {
	const afterOffset = offset > 0 ? items.slice(offset) : items;
	if (limit === 0) return { items: afterOffset, truncated: false };
	return { items: afterOffset.slice(0, limit), truncated: afterOffset.length > limit };
}

function pagingNote(limit: number, offset: number): string {
	return `limit: ${limit}, offset: ${offset}. Use offset: ${offset + limit} to see more`;
}

/** Strip a leading "./" that rg prints when invoked with "." as the search path. */
function stripDotSlash(line: string): string {
	return line.startsWith("./") ? line.slice(2) : line;
}

interface RgRun {
	stdout: string;
	stderr: string;
	code: number | null;
	capped: boolean;
}

function runRg(rgPath: string, args: string[], cwd: string, signal: AbortSignal | undefined): Promise<RgRun> {
	return new Promise((resolvePromise, reject) => {
		if (signal?.aborted) {
			reject(new Error("Operation aborted"));
			return;
		}
		const child = spawn(rgPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		let bytes = 0;
		let capped = false;
		let stderr = "";
		let settled = false;
		const onAbort = () => {
			child.kill("SIGKILL");
			if (!settled) {
				settled = true;
				reject(new Error("Operation aborted"));
			}
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (d: Buffer) => {
			if (capped) return;
			if (bytes + d.length > MAX_RG_OUTPUT_BYTES) {
				chunks.push(d.subarray(0, MAX_RG_OUTPUT_BYTES - bytes));
				bytes = MAX_RG_OUTPUT_BYTES;
				capped = true;
				child.kill("SIGKILL");
				return;
			}
			chunks.push(d);
			bytes += d.length;
		});
		child.stderr.on("data", (d: Buffer) => {
			if (stderr.length < 64 * 1024) stderr += d.toString("utf8");
		});
		child.on("error", (err) => {
			signal?.removeEventListener("abort", onAbort);
			if (!settled) {
				settled = true;
				reject(new Error(`Failed to run ripgrep: ${err.message}`));
			}
		});
		child.on("close", (code) => {
			signal?.removeEventListener("abort", onAbort);
			if (settled) return;
			settled = true;
			let stdout = Buffer.concat(chunks).toString("utf8");
			if (capped) {
				// drop the partial last line
				const nl = stdout.lastIndexOf("\n");
				stdout = nl >= 0 ? stdout.slice(0, nl + 1) : "";
			}
			resolvePromise({ stdout, stderr, code, capped });
		});
	});
}

/** Build the rg argument list for the given params. Exported for tests. */
export function buildRgArgs(params: GrepParams, searchArg: string): string[] {
	const mode: GrepOutputMode = params.output_mode ?? "files_with_matches";
	const args: string[] = ["--hidden", "--color=never", "--no-heading", "--max-columns", String(MAX_COLUMNS)];
	for (const d of VCS_DIRS) args.push("--glob", `!${d}`);
	if (params["-i"]) args.push("--ignore-case");
	if (params.multiline) args.push("--multiline", "--multiline-dotall");

	if (mode === "files_with_matches") {
		args.push("--files-with-matches");
	} else if (mode === "count") {
		args.push("--count", "--with-filename");
	} else {
		args.push("--with-filename");
		args.push(params["-n"] === false ? "--no-line-number" : "--line-number");
		if (params["-o"]) args.push("--only-matching");
		const c = nonNegInt(params.context ?? params["-C"]);
		const a = nonNegInt(params["-A"]);
		const b = nonNegInt(params["-B"]);
		if (c !== undefined) args.push("--context", String(c));
		if (a !== undefined) args.push("--after-context", String(a));
		if (b !== undefined) args.push("--before-context", String(b));
	}

	if (params.type) args.push("--type", params.type);
	if (params.glob) for (const g of splitGlobs(params.glob)) args.push("--glob", g);

	// -e keeps patterns beginning with "-" from being parsed as flags; "--" ends options before the path.
	args.push("--regexp", params.pattern, "--", searchArg);
	return args;
}

// ---------------------------------------------------------------------------
// tool
// ---------------------------------------------------------------------------

export async function executeGrep(
	params: GrepParams,
	cwd: string,
	signal?: AbortSignal,
): Promise<{ text: string; details: GrepDetails }> {
	const mode: GrepOutputMode = params.output_mode ?? "files_with_matches";
	if (typeof params.pattern !== "string" || params.pattern.length === 0) {
		throw new Error("pattern must be a non-empty string");
	}

	const searchAbs = params.path ? resolvePath(cwd, params.path) : resolve(cwd);
	if (!existsSync(searchAbs)) throw new Error(`Path does not exist: ${params.path ?? searchAbs}`);

	// Pass rg a path relative to cwd when possible so output paths come back relative.
	const rel = relative(cwd, searchAbs);
	const searchArg = rel === "" ? "." : !rel.startsWith("..") && !isAbsolute(rel) ? rel : searchAbs;

	const rgPath = await resolveRgPath();
	const run = await runRg(rgPath, buildRgArgs(params, searchArg), cwd, signal);

	// Exit 1 = no matches. Exit 2 = error, but rg also returns 2 for partial errors
	// (e.g. unreadable files) while still producing results: only fail when nothing came back.
	if (run.code === 2 && run.stdout.trim() === "") {
		throw new Error(`ripgrep error: ${run.stderr.trim() || "unknown error"}`);
	}
	if (run.code !== 0 && run.code !== 1 && run.code !== 2 && !run.capped) {
		throw new Error(`ripgrep exited with code ${run.code}: ${run.stderr.trim()}`);
	}

	const lines = run.stdout
		.split("\n")
		.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l))
		.filter((l) => l !== "")
		.map(stripDotSlash);

	const limit = nonNegInt(params.head_limit) ?? DEFAULT_HEAD_LIMIT;
	const offset = nonNegInt(params.offset) ?? 0;
	const cappedNote = run.capped
		? "\n\n[ripgrep output exceeded the internal size cap and was cut short; narrow the search with path, glob, or type]"
		: "";

	if (mode === "files_with_matches") {
		const withTimes = lines.map((p) => {
			let mtime = 0;
			try {
				mtime = statSync(isAbsolute(p) ? p : join(cwd, p)).mtimeMs;
			} catch {
				// file vanished between rg and stat
			}
			return { p, mtime };
		});
		withTimes.sort((x, y) => y.mtime - x.mtime || x.p.localeCompare(y.p));
		const sorted = withTimes.map((x) => x.p);
		const paged = applyPaging(sorted, limit, offset);
		const details: GrepDetails = { mode, numFiles: sorted.length };
		if (run.capped) details.outputCapped = true;
		if (sorted.length === 0) return { text: "No files found", details };
		if (paged.items.length === 0) {
			return { text: `No files found at offset ${offset} (${sorted.length} matching files in total)`, details };
		}
		let text = `Found ${paged.items.length} file${paged.items.length === 1 ? "" : "s"}`;
		if (paged.truncated) {
			details.appliedLimit = limit;
			details.appliedOffset = offset;
			text += ` (${sorted.length} total) [Showing results with pagination = ${pagingNote(limit, offset)}]`;
		}
		text += `\n${paged.items.join("\n")}${cappedNote}`;
		return { text, details };
	}

	if (mode === "count") {
		let totalMatches = 0;
		for (const l of lines) {
			const idx = l.lastIndexOf(":");
			const n = idx >= 0 ? Number.parseInt(l.slice(idx + 1), 10) : Number.NaN;
			if (Number.isFinite(n)) totalMatches += n;
		}
		const details: GrepDetails = { mode, numFiles: lines.length, numMatches: totalMatches };
		if (run.capped) details.outputCapped = true;
		if (lines.length === 0) return { text: "No matches found", details };
		const paged = applyPaging(lines, limit, offset);
		const body = paged.items.join("\n");
		let summary = `Found ${totalMatches} total ${totalMatches === 1 ? "occurrence" : "occurrences"} across ${lines.length} ${lines.length === 1 ? "file" : "files"}.`;
		if (paged.truncated) {
			details.appliedLimit = limit;
			details.appliedOffset = offset;
			summary += ` [Showing results with pagination = ${pagingNote(limit, offset)}]`;
		}
		return { text: `${body}${body ? "\n\n" : ""}${summary}${cappedNote}`, details };
	}

	// content
	const details: GrepDetails = { mode, numLines: lines.length };
	if (run.capped) details.outputCapped = true;
	if (lines.length === 0) return { text: "No matches found", details };
	const paged = applyPaging(lines, limit, offset);
	if (paged.items.length === 0) {
		return { text: `No matches found at offset ${offset} (${lines.length} output lines in total)`, details };
	}
	let text = paged.items.join("\n");
	if (paged.truncated) {
		details.appliedLimit = limit;
		details.appliedOffset = offset;
		text += `\n\n[Showing results with pagination = ${pagingNote(limit, offset)}]`;
	}
	return { text: text + cappedNote, details };
}

export function registerGrep(pi: ExtensionAPI, _cc: CCContext): void {
	pi.registerTool({
		name: GREP_TOOL_NAME,
		label: "Grep",
		description: DESCRIPTION,
		promptSnippet: "Search file contents with ripgrep (regex; glob/type filters; content, files_with_matches, count modes)",
		parameters: grepSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { text, details } = await executeGrep(params, ctx.cwd, signal);
			return textResult<GrepDetails>(text, details);
		},
	});
}

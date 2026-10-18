import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { CCContext } from "../shared/context.js";
import { resolvePath } from "../shared/paths.js";
import { textResult } from "../shared/text.js";

export const GREP_TOOL_NAME = "Grep";

/** Default head_limit (Claude Code: 250). */
export const GREP_DEFAULT_HEAD_LIMIT = 250;
/** Claude Code caps buffered rg stdout at 20 MB; complete lines before the cap are kept. */
const MAX_RG_OUTPUT_BYTES = 20_000_000;
/** Lines longer than this are replaced by an "[Omitted long ... line]" marker (minified files etc.). */
const MAX_LINE_CHARS = 500;
/** Version-control directories never searched (--hidden would otherwise include them). */
const VCS_DIRS = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"];
/** Claude Code kills rg after 20 s (CLAUDE_CODE_GLOB_TIMEOUT_SECONDS overrides). */
const DEFAULT_RG_TIMEOUT_MS = 20_000;

export const CWD_NOTE = "Note: your current working directory is";

// Mirrors Claude Code's Grep tool description verbatim.
const DESCRIPTION = `A powerful search tool built on ripgrep

  Usage:
  - ALWAYS use Grep for search tasks. NEVER invoke \`grep\` or \`rg\` as a Bash command. The Grep tool has been optimized for correct permissions and access.
  - Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
  - Filter files with glob parameter (e.g., "*.js", "**/*.tsx") or type parameter (e.g., "js", "py", "rust")
  - Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts
  - Use Agent tool (if available) for open-ended searches requiring multiple rounds
  - Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use \`interface\\{\\}\` to find \`interface{}\` in Go code)
  - Multiline matching: By default patterns match within single lines only. For cross-line patterns like \`struct \\{[\\s\\S]*?field\`, use \`multiline: true\`
`;

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

/** Same shape as Claude Code's Grep output. */
export interface GrepDetails {
	mode: GrepOutputMode;
	numFiles: number;
	filenames: string[];
	content?: string;
	numLines?: number;
	numMatches?: number;
	totalFiles?: number;
	totalLines?: number;
	appliedLimit?: number;
	appliedOffset?: number;
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
// shared helpers (also used by Glob)
// ---------------------------------------------------------------------------

/** Claude Code's display path: relative to cwd unless that climbs out of it. */
export function displayPath(cwd: string, abs: string): string {
	const r = relative(cwd, abs);
	return r.startsWith("..") ? abs : r;
}

/**
 * Claude Code's "Did you mean" hint for a missing path: when the path lies in cwd's parent
 * (but not in cwd) and the same relative path exists inside cwd, suggest that.
 */
export function suggestUnderCwd(cwd: string, abs: string): string | undefined {
	const parent = dirname(cwd);
	let p = abs;
	try {
		p = join(realpathSync(dirname(abs)), basename(abs));
	} catch {
		// keep lexical path
	}
	const parentPrefix = parent === sep ? sep : parent + sep;
	if (!p.startsWith(parentPrefix) || p.startsWith(cwd + sep) || p === cwd) return undefined;
	const candidate = join(cwd, relative(parent, p));
	return existsSync(candidate) ? candidate : undefined;
}

/** Message for a path that does not exist, as Claude Code words it. */
export function missingPathMessage(kind: "Path" | "Directory", raw: string, abs: string, cwd: string): string {
	const hint = suggestUnderCwd(cwd, abs);
	return `${kind} does not exist: ${raw}. ${CWD_NOTE} ${cwd}.${hint ? ` Did you mean ${hint}?` : ""}`;
}

/** Truncate to `max` UTF-16 units without splitting a surrogate pair. */
function safeSlice(s: string, max: number): string {
	if (s.length <= max) return s;
	const cut = s.slice(0, max);
	const c = cut.charCodeAt(max - 1);
	return c >= 0xd800 && c <= 0xdbff ? cut.slice(0, -1) : cut;
}

const RG_USAGE_ERROR = /^rg: (?:regex parse error|error parsing glob|unrecognized file type|error parsing flag|compiled regex exceeds size limit)/m;

export interface RgRun {
	/** Output lines (trailing newline removed; a partial last line is dropped when the run was cut short). */
	lines: string[];
	stderr: string;
	code: number | null;
}

function rgTimeoutMs(): number {
	const s = Number(process.env.CLAUDE_CODE_GLOB_TIMEOUT_SECONDS);
	return Number.isFinite(s) && s > 0 ? s * 1000 : DEFAULT_RG_TIMEOUT_MS;
}

/**
 * Run rg and collect its output the way Claude Code does: exit 1 = no matches; exit 2 with output =
 * partial errors (results kept); 20 MB stdout cap and 20 s timeout keep the complete lines read so far.
 */
export async function runRipgrep(args: string[], cwd: string, signal: AbortSignal | undefined): Promise<RgRun> {
	const rgPath = await resolveRgPath();
	const run = await new Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean; capped: boolean }>(
		(resolvePromise, reject) => {
			if (signal?.aborted) {
				reject(new Error("Operation aborted"));
				return;
			}
			const child = spawn(rgPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
			const chunks: Buffer[] = [];
			let bytes = 0;
			let capped = false;
			let timedOut = false;
			let stderr = "";
			let settled = false;
			const timer = setTimeout(() => {
				timedOut = true;
				child.kill("SIGTERM");
				setTimeout(() => child.kill("SIGKILL"), 5000).unref();
			}, rgTimeoutMs());
			const onAbort = () => {
				child.kill("SIGKILL");
				if (!settled) {
					settled = true;
					clearTimeout(timer);
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
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				if (!settled) {
					settled = true;
					reject(new Error(`Failed to run ripgrep: ${err.message}`));
				}
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				if (settled) return;
				settled = true;
				resolvePromise({ stdout: Buffer.concat(chunks).toString("utf8"), stderr, code, timedOut, capped });
			});
		},
	);

	const abnormal = run.code !== 0 && run.code !== 1 && run.code !== 2;
	const cut = run.capped || run.timedOut || abnormal;
	let stdout = run.stdout;
	if (cut && !stdout.endsWith("\n")) {
		// drop the partial last line
		const nl = stdout.lastIndexOf("\n");
		stdout = nl >= 0 ? stdout.slice(0, nl + 1) : "";
	}
	const lines = stdout === "" ? [] : stdout.replace(/\n$/, "").split("\n");
	if (run.code === 1 && !cut) return { lines: [], stderr: run.stderr, code: 1 };
	if (lines.length === 0) {
		if (run.code === 2 && RG_USAGE_ERROR.test(run.stderr)) {
			throw new Error(`Search failed — ripgrep rejected the pattern, glob, or file type without searching:\n${safeSlice(run.stderr.trim(), 2000)}`);
		}
		if (run.timedOut) {
			throw new Error(
				`Ripgrep search timed out after ${rgTimeoutMs() / 1000} seconds. The search may have matched files but did not complete in time. Try searching a more specific path or pattern.`,
			);
		}
		if (run.capped) {
			throw new Error(
				`Ripgrep output passed the ${MAX_RG_OUTPUT_BYTES / 1e6}MB limit before a single complete line was read, so there are no usable results: at least one matching line is extremely long. Try a more specific pattern or path, or exclude very large files.`,
			);
		}
		if (abnormal) {
			throw new Error(
				'The search failed, so this is not a "no matches" result: matches may exist. What happened to the search program (ripgrep) is not known, and no results were read. Run the search once more. If it fails again, tell the user that searches are failing. Do not run a recursive search in the shell instead (for example grep -r, find or rg): it can reach what this tool is set to leave out.',
			);
		}
	}
	return { lines, stderr: run.stderr, code: run.code };
}

/**
 * Split rg `--null` output (lines joined back with "\n") into entries. Count mode yields
 * "path:N" (zero counts dropped), the other modes yield paths.
 */
export function splitNullOutput(lines: string[], mode: "count" | "files_with_matches"): string[] {
	const s = lines.join("\n");
	if (!s.includes("\0")) return lines;
	const out: string[] = [];
	if (mode === "count") {
		const re = /([^\0]*)\0:?(\d+)(?:\n|$)/y;
		for (let m = re.exec(s); m !== null; m = re.exec(s)) if (m[2] !== "0") out.push(`${m[1]}:${m[2]}`);
		return out;
	}
	const parts = s.split("\0");
	parts.pop();
	for (let i = 0; i < parts.length; i++) {
		const p = i === 0 ? parts[i] : parts[i].replace(/^\n/, "");
		if (p !== "") out.push(p);
	}
	return out;
}

/**
 * Split a glob parameter into individual rg --glob values. Whitespace separates patterns;
 * commas separate patterns too, except inside brace expressions like "*.{ts,tsx}".
 */
export function splitGlobs(glob: string): string[] {
	const out: string[] = [];
	for (const part of glob.split(/\s+/)) {
		if (part.includes("{") && part.includes("}")) out.push(part);
		else out.push(...part.split(",").filter(Boolean));
	}
	return out.filter(Boolean);
}

function applyPaging<T>(items: T[], limit: number | undefined, offset: number): { items: T[]; appliedLimit?: number } {
	if (limit === 0) return { items: items.slice(offset) };
	const n = limit ?? GREP_DEFAULT_HEAD_LIMIT;
	return { items: items.slice(offset, offset + n), appliedLimit: items.length - offset > n ? n : undefined };
}

function pagingText(limit: number | undefined, offset: number | undefined): string {
	const parts: string[] = [];
	if (limit !== undefined) parts.push(`limit: ${limit}`);
	if (offset) parts.push(`offset: ${offset}`);
	return parts.join(", ");
}

/** Build the rg argument list (Claude Code's order). Exported for tests. */
export function buildRgArgs(params: GrepParams, target: string): string[] {
	const mode: GrepOutputMode = params.output_mode ?? "files_with_matches";
	const args: string[] = ["--hidden"];
	for (const d of VCS_DIRS) args.push("--glob", `!${d}`);
	args.push("--max-columns", "500");
	if (params.multiline) args.push("-U", "--multiline-dotall");
	if (params["-i"]) args.push("-i");
	if (mode === "files_with_matches") args.push("-l");
	else if (mode === "count") args.push("-c", "-H");
	args.push(mode === "content" ? "--json" : "--null");
	if (mode === "content") {
		args.push("-n");
		if (params["-o"]) args.push("-o");
		if (params.context !== undefined) args.push("-C", String(params.context));
		else if (params["-C"] !== undefined) args.push("-C", String(params["-C"]));
		else {
			if (params["-B"] !== undefined) args.push("-B", String(params["-B"]));
			if (params["-A"] !== undefined) args.push("-A", String(params["-A"]));
		}
	}
	if (params.pattern.startsWith("-")) args.push("-e", params.pattern);
	else args.push(params.pattern);
	if (params.type) args.push("--type", params.type);
	if (params.glob) for (const g of splitGlobs(params.glob)) args.push("--glob", g);
	args.push(target);
	return args;
}

// ---------------------------------------------------------------------------
// content mode: rg --json → "path\0N:line" entries (Claude Code's format)
// ---------------------------------------------------------------------------

interface RgJsonText {
	text?: string;
	bytes?: string;
}
interface RgJsonEvent {
	type: string;
	data?: {
		path?: RgJsonText;
		lines?: RgJsonText;
		line_number?: number;
		submatches?: Array<{ match?: RgJsonText; start?: number }>;
		binary_offset?: number | null;
	};
}

const jsonText = (t: RgJsonText | undefined): string =>
	t === undefined ? "" : t.text !== undefined ? t.text : Buffer.from(t.bytes ?? "", "base64").toString("utf8");

function newlinesBefore(buf: Buffer, end: number): number {
	let n = 0;
	for (let i = Math.min(end, buf.length) - 1; i >= 0; i--) if (buf[i] === 10) n++;
	return n;
}

/**
 * Parse rg --json output into "path\0N:line" / "path\0N-line" entries plus "--" context breaks.
 * Claude Code keeps rg's (multi-threaded, unstable) file order; files are sorted by path here so
 * output and paging are deterministic.
 */
export function parseRgJson(lines: string[], opts: { contextBreaks: boolean; onlyMatching: boolean }): string[] {
	// group events per file (begin .. end)
	const groups: Array<{ path: string; events: RgJsonEvent[] }> = [];
	let current: { path: string; events: RgJsonEvent[] } | undefined;
	for (const line of lines) {
		if (!line.startsWith("{")) continue;
		let ev: RgJsonEvent;
		try {
			ev = JSON.parse(line);
		} catch {
			continue;
		}
		if (ev === null || typeof ev !== "object") continue;
		if (ev.type === "begin") {
			current = { path: jsonText(ev.data?.path), events: [ev] };
			groups.push(current);
			continue;
		}
		if (ev.type === "summary") continue;
		if (!current) {
			current = { path: jsonText(ev.data?.path), events: [] };
			groups.push(current);
		}
		current.events.push(ev);
		if (ev.type === "end") current = undefined;
	}
	groups.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

	const omit = (s: string, kind: "match" | "context") =>
		s.length > MAX_LINE_CHARS ? (kind === "match" ? "[Omitted long matching line]" : "[Omitted long context line]") : s;
	const out: string[] = [];
	let pending: string[] = [];
	let lastPath: string | null = null;
	let lastLine = -1;
	for (const g of groups) {
		for (const ev of g.events) {
			const d = ev.data ?? {};
			if (ev.type === "begin") {
				pending = [];
				continue;
			}
			if (ev.type === "end") {
				const binaryOffset = d.binary_offset;
				const isBinary = typeof binaryOffset === "number";
				for (const l of pending) if (!isBinary || !l.slice(l.indexOf("\0") + 1).includes("\0")) out.push(l);
				if (isBinary && pending.length > 0) out.push(`${jsonText(d.path)}\0binary file matches (found "\\0" byte around offset ${binaryOffset})`);
				pending = [];
				continue;
			}
			if (ev.type !== "match" && ev.type !== "context") continue;
			const path = jsonText(d.path);
			const lineNo = d.line_number ?? 0;
			const text = jsonText(d.lines).replace(/\r?\n$/, "");
			if (opts.contextBreaks && lastPath !== null && (path !== lastPath || lineNo > lastLine + 1)) pending.push("--");
			if (ev.type === "match" && opts.onlyMatching) {
				let last = lineNo;
				const buf = Buffer.from(text);
				for (const sm of d.submatches ?? []) {
					const start = lineNo + newlinesBefore(buf, sm.start ?? 0);
					jsonText(sm.match)
						.split("\n")
						.forEach((part, i) => {
							pending.push(`${path}\0${start + i}:${omit(part.replace(/\r$/, ""), "match")}`);
							last = start + i;
						});
				}
				lastPath = path;
				lastLine = last;
				continue;
			}
			const kind = ev.type === "match" ? "match" : "context";
			const sepChar = kind === "match" ? ":" : "-";
			const parts = text.split("\n").map((p) => p.replace(/\r$/, ""));
			parts.forEach((p, i) => pending.push(`${path}\0${lineNo + i}${sepChar}${omit(p, kind)}`));
			lastPath = path;
			lastLine = lineNo + parts.length - 1;
		}
	}
	for (const l of pending) out.push(l);
	return out;
}

// ---------------------------------------------------------------------------
// tool
// ---------------------------------------------------------------------------

function validateWholeNumber(name: "head_limit" | "offset", v: unknown): void {
	if (v === undefined || v === null) return;
	if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
		throw new Error(`${name} must be a whole number of 0 or more, got ${v}.${name === "head_limit" ? " Pass 0 for unlimited." : ""}`);
	}
}

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export async function executeGrep(
	params: GrepParams,
	cwd: string,
	signal?: AbortSignal,
): Promise<{ text: string; details: GrepDetails }> {
	const mode: GrepOutputMode = params.output_mode ?? "files_with_matches";
	if (typeof params.pattern !== "string") throw new Error("pattern must be a string");
	validateWholeNumber("head_limit", params.head_limit);
	validateWholeNumber("offset", params.offset);
	const limit = params.head_limit ?? undefined;
	const offset = params.offset ?? 0;

	const searchAbs = params.path ? resolvePath(cwd, params.path) : cwd;
	let isDirectory: boolean;
	try {
		isDirectory = statSync(searchAbs).isDirectory();
	} catch {
		if (params.path) throw new Error(missingPathMessage("Path", params.path, searchAbs, cwd));
		const empty = emptyDetails(mode);
		return { text: formatGrep(empty), details: empty };
	}

	// Directories: run inside the directory on "." (paths come back as "./x"); files: absolute path.
	const target = isDirectory ? "." : searchAbs;
	const spawnCwd = isDirectory ? searchAbs : dirname(searchAbs);
	const toAbs = (p: string) => (isDirectory ? join(searchAbs, p.startsWith("./") ? p.slice(2) : p) : p);
	const run = await runRipgrep(buildRgArgs(params, target), spawnCwd, signal);

	let details: GrepDetails;
	if (mode === "content") {
		const contextBreaks = [params.context, params["-C"], params["-B"], params["-A"]].some((v) => typeof v === "number" && v > 0);
		const entries = parseRgJson(run.lines, { contextBreaks, onlyMatching: params["-o"] === true });
		const showNumbers = params["-n"] !== false;
		const paged = applyPaging(entries, limit, offset);
		const out = paged.items.map((e) => {
			const nul = e.indexOf("\0");
			if (nul < 0) return showNumbers ? e : e.replace(/^\d+[:-]/, "");
			const rest = e.slice(nul + 1);
			const m = /^(\d+)([:-])/.exec(rest);
			const sepChar = m?.[2] ?? ":";
			const body = showNumbers || m === null ? rest : rest.slice(m[0].length);
			return isDirectory ? displayPath(cwd, toAbs(e.slice(0, nul))) + sepChar + body : body;
		});
		details = {
			mode: "content",
			numFiles: 0,
			filenames: [],
			content: out.join("\n"),
			numLines: out.length,
			totalLines: entries.length,
			...(paged.appliedLimit !== undefined && { appliedLimit: paged.appliedLimit }),
			...(offset > 0 && { appliedOffset: offset }),
		};
	} else if (mode === "count") {
		const entries = splitNullOutput(run.lines, "count").map((e) => {
			const i = e.lastIndexOf(":");
			return i > 0 ? toAbs(e.slice(0, i)) + e.slice(i) : e;
		});
		// rg prints files in thread-completion order; sort so output and paging are deterministic
		const key = (e: string) => e.slice(0, Math.max(0, e.lastIndexOf(":")));
		entries.sort((a, b) => byString(key(a), key(b)));
		const paged = applyPaging(entries, limit, offset);
		const out = paged.items.map((e) => {
			const i = e.lastIndexOf(":");
			return i > 0 ? displayPath(cwd, e.slice(0, i)) + e.slice(i) : e;
		});
		let numMatches = 0;
		let numFiles = 0;
		for (const e of entries) {
			const i = e.lastIndexOf(":");
			const n = Number.parseInt(e.slice(i + 1), 10);
			if (i > 0 && !Number.isNaN(n)) {
				numMatches += n;
				numFiles += 1;
			}
		}
		details = {
			mode: "count",
			numFiles,
			filenames: [],
			content: out.join("\n"),
			numMatches,
			...(paged.appliedLimit !== undefined && { appliedLimit: paged.appliedLimit }),
			...(offset > 0 && { appliedOffset: offset }),
		};
	} else {
		const files = splitNullOutput(run.lines, "files_with_matches").map(toAbs);
		const stats = await Promise.allSettled(files.map((f) => stat(f)));
		const sorted = files
			.map((f, i) => {
				const s = stats[i];
				return [f, s.status === "fulfilled" ? (s.value.mtimeMs ?? 0) : 0] as const;
			})
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.map((x) => x[0]);
		const paged = applyPaging(sorted, limit, offset);
		const filenames = paged.items.map((f) => displayPath(cwd, f));
		details = {
			mode: "files_with_matches",
			filenames,
			numFiles: filenames.length,
			totalFiles: sorted.length,
			...(paged.appliedLimit !== undefined && { appliedLimit: paged.appliedLimit }),
			...(offset > 0 && { appliedOffset: offset }),
		};
	}
	return { text: formatGrep(details), details };
}

function emptyDetails(mode: GrepOutputMode): GrepDetails {
	if (mode === "content") return { mode, numFiles: 0, filenames: [], content: "", numLines: 0, totalLines: 0 };
	if (mode === "count") return { mode, numFiles: 0, filenames: [], content: "", numMatches: 0 };
	return { mode, filenames: [], numFiles: 0, totalFiles: 0 };
}

/** Claude Code's Grep tool_result text. */
export function formatGrep(d: GrepDetails): string {
	const paging = pagingText(d.appliedLimit, d.appliedOffset);
	if (d.mode === "content") {
		const body = d.content || (d.appliedOffset && (d.totalLines ?? 0) > 0 ? "No entries at this offset" : "No matches found");
		return paging ? `${body}\n\n[Showing results with pagination = ${paging}]` : body;
	}
	if (d.mode === "count") {
		const matches = d.numMatches ?? 0;
		const files = d.numFiles ?? 0;
		const body = d.content || (matches > 0 ? "No entries at this offset" : "No matches found");
		return `${body}\n\nFound ${matches} total ${matches === 1 ? "occurrence" : "occurrences"} across ${files} ${files === 1 ? "file" : "files"}.${paging ? ` with pagination = ${paging}` : ""}`;
	}
	if (d.numFiles === 0) {
		return d.appliedOffset && (d.totalFiles ?? 0) > 0 ? `No entries at this offset. [Showing results with pagination = ${paging}]` : "No files found";
	}
	return `Found ${d.numFiles} ${d.numFiles === 1 ? "file" : "files"}${paging ? ` ${paging}` : ""}\n${d.filenames.join("\n")}`;
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

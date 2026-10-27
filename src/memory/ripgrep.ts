import { posix } from "node:path";
import type { Bash, InMemoryFs } from "just-bash";
import { braceExpand } from "minimatch";
import type { HostRipgrepResult } from "../host/types.js";
import { abortError } from "./errors.js";

/**
 * ripgrep on the memory host: just-bash's built-in `rg`, called with the argument vector unchanged
 * where its `rg` agrees with ripgrep, and adjusted where it does not. Every adjustment below was
 * found by running the argument vectors Grep builds (`buildRgArgs`) through both programs:
 *
 * - case: just-bash defaults to smart case, ripgrep to case-sensitive → `--case-sensitive` is put
 *   first (a later `-i` still wins).
 * - `--max-columns N`: not supported (rejected as an unknown option) → dropped. Grep already replaces
 *   lines longer than 500 characters itself in content mode, and the other modes print no lines.
 * - `--glob` brace sets (`*.{ts,tsx}`) match nothing in just-bash → expanded into one `--glob` each.
 * - `--glob !name`: just-bash only excludes files named `name`, ripgrep also everything inside a
 *   directory `name` (how Grep keeps `.git`, `.jj`, … out) → `!name/**` and `!**\/name/**` added.
 *   A leading `/` (anchored) is dropped: just-bash matches every glob against the whole relative path.
 * - `--type X` with an unknown X: just-bash searches nothing and exits 1 ("no matches"), ripgrep
 *   exits 2 with "unrecognized file type" → checked against `rg --type-list` first.
 * - `--json` with `-A/-B/-C`: just-bash prints no context events → synthesized from the file.
 * - `--json` with `-U`: just-bash prints no match events at all → the search is run again without
 *   `--json` and its `path:N:line` output converted into match/context events.
 * - `-c` with `-U`: just-bash counts every line a match spans, ripgrep each match → `--count-matches`.
 * - error messages are reworded to ripgrep's ("regex parse error", "error parsing glob") and exit 2,
 *   so Grep reports them as a rejected pattern instead of "No matches found".
 *
 * Not emulated (documented limitations): just-bash always skips directories named node_modules,
 * .git, .svn, .hg, __pycache__, .pytest_cache, .mypy_cache, venv, .venv, .next, .nuxt and .cargo
 * (ripgrep searches them unless ignored); .gitignore applies even outside a git repository; binary
 * files are skipped silently (no "binary file matches"); the regex dialect is just-bash's translation
 * to JavaScript (no inline flags such as `(?i)`).
 */

/** Options that take a value (the next argument, or `--flag=value`). */
const VALUE_FLAGS = new Set([
	"-A",
	"-B",
	"-C",
	"-M",
	"-T",
	"-d",
	"-e",
	"-f",
	"-g",
	"-j",
	"-m",
	"-r",
	"-t",
	"--after-context",
	"--before-context",
	"--context",
	"--context-separator",
	"--file",
	"--glob",
	"--iglob",
	"--ignore-file",
	"--max-columns",
	"--max-count",
	"--max-depth",
	"--max-filesize",
	"--pre",
	"--pre-glob",
	"--regexp",
	"--replace",
	"--sort",
	"--threads",
	"--type",
	"--type-add",
	"--type-clear",
	"--type-not",
]);

interface ParsedArgs {
	args: string[];
	json: boolean;
	multiline: boolean;
	onlyMatching: boolean;
	before: number;
	after: number;
	types: string[];
}

const longName: Record<string, string> = { "--after-context": "-A", "--before-context": "-B", "--context": "-C", "--glob": "-g", "--type": "-t", "--max-columns": "-M" };

/** Expand `{a,b}` sets and give negated globs ripgrep's directory semantics. */
export function adaptGlob(glob: string): string[] {
	const negated = glob.startsWith("!");
	const body = negated ? glob.slice(1) : glob;
	const out: string[] = [];
	for (let g of braceExpand(body)) {
		if (g.startsWith("/")) g = g.slice(1);
		if (!negated) {
			out.push(g);
			continue;
		}
		const dir = g.replace(/\/+$/, "");
		out.push(`!${dir}`, `!${dir}/**`);
		if (!g.includes("/")) out.push(`!**/${dir}/**`);
	}
	return out;
}

export function parseRgArgs(input: string[]): ParsedArgs {
	const p: ParsedArgs = { args: ["--case-sensitive"], json: false, multiline: false, onlyMatching: false, before: 0, after: 0, types: [] };
	let ctxA: number | undefined;
	let ctxB: number | undefined;
	let ctxC: number | undefined;
	const take = (flag: string, value: string) => {
		const f = longName[flag] ?? flag;
		switch (f) {
			case "-M":
				return; // --max-columns: unsupported, see above
			case "-g":
				for (const g of adaptGlob(value)) p.args.push("--glob", g);
				return;
			case "-t":
				p.types.push(value);
				break;
			case "-A":
				ctxA = Number(value);
				break;
			case "-B":
				ctxB = Number(value);
				break;
			case "-C":
				ctxC = Number(value);
				break;
		}
		p.args.push(flag, value);
	};
	for (let i = 0; i < input.length; i++) {
		const a = input[i];
		if (a === "--") {
			p.args.push(...input.slice(i));
			break;
		}
		const eq = a.startsWith("--") ? a.indexOf("=") : -1;
		if (eq > 0 && VALUE_FLAGS.has(a.slice(0, eq))) {
			take(a.slice(0, eq), a.slice(eq + 1));
			continue;
		}
		if (VALUE_FLAGS.has(a) && i + 1 < input.length) {
			take(a, input[++i]);
			continue;
		}
		if (a === "--max-columns-preview") continue;
		if (a === "--json") p.json = true;
		else if (a === "-U" || a === "--multiline" || a === "--multiline-dotall") p.multiline = true;
		else if (a === "-o" || a === "--only-matching") p.onlyMatching = true;
		else if (/^-[A-Za-z]{2,}$/.test(a)) {
			// bundled short flags (-io)
			if (a.includes("U")) p.multiline = true;
			if (a.includes("o")) p.onlyMatching = true;
		}
		p.args.push(a);
	}
	// ripgrep's -c counts each multiline match once; just-bash counts every line it spans
	if (p.multiline) p.args = p.args.map((a) => (a === "-c" || a === "--count" ? "--count-matches" : a));
	p.before = Math.max(0, (ctxB ?? ctxC ?? 0) | 0);
	p.after = Math.max(0, (ctxA ?? ctxC ?? 0) | 0);
	return p;
}

interface RgEvent {
	type: string;
	data?: {
		path?: { text?: string; bytes?: string };
		lines?: { text?: string; bytes?: string };
		line_number?: number;
		absolute_offset?: number;
		submatches?: Array<{ match: { text?: string }; start: number; end: number }>;
		[k: string]: unknown;
	};
}

const pathOf = (ev: RgEvent) => ev.data?.path?.text ?? (ev.data?.path?.bytes ? Buffer.from(ev.data.path.bytes, "base64").toString("utf8") : "");

function parseEvents(stdout: string): RgEvent[] {
	const events: RgEvent[] = [];
	for (const line of stdout.split("\n")) {
		if (!line.startsWith("{")) continue;
		try {
			events.push(JSON.parse(line));
		} catch {
			// not an event
		}
	}
	return events;
}

const stringify = (events: RgEvent[]) => events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : "");

/** Lines of a file with their 1-based numbers and byte offsets (terminators kept, as rg reports them). */
function splitLines(text: string): Array<{ text: string; offset: number }> {
	const out: Array<{ text: string; offset: number }> = [];
	let offset = 0;
	for (const part of text.split(/(?<=\n)/)) {
		if (part === "") continue;
		out.push({ text: part, offset });
		offset += Buffer.byteLength(part);
	}
	return out;
}

/** Add the context events just-bash leaves out of `--json` output. */
async function addContext(events: RgEvent[], vfs: InMemoryFs, cwd: string, before: number, after: number): Promise<RgEvent[]> {
	const out: RgEvent[] = [];
	let group: RgEvent[] | undefined;
	const flush = async (end: RgEvent) => {
		const matches = (group ?? []).filter((e) => e.type === "match");
		const path = pathOf(end);
		let lines: Array<{ text: string; offset: number }> = [];
		try {
			lines = splitLines(new TextDecoder().decode(await vfs.readFileBuffer(posix.resolve(cwd, path))));
		} catch {
			// unreadable now: keep the matches without context
		}
		const matched = new Set(matches.map((m) => m.data?.line_number ?? 0));
		const context = new Set<number>();
		for (const n of matched) {
			for (let k = Math.max(1, n - before); k <= Math.min(lines.length, n + after); k++) if (!matched.has(k)) context.add(k);
		}
		const merged: Array<{ n: number; ev: RgEvent }> = matches.map((m) => ({ n: m.data?.line_number ?? 0, ev: m }));
		for (const n of context) {
			const line = lines[n - 1];
			merged.push({
				n,
				ev: { type: "context", data: { path: { text: path }, lines: { text: line.text }, line_number: n, absolute_offset: line.offset, submatches: [] } },
			});
		}
		merged.sort((a, b) => a.n - b.n);
		out.push(...(group ?? []).filter((e) => e.type === "begin"), ...merged.map((m) => m.ev), end);
		group = undefined;
	};
	for (const ev of events) {
		if (ev.type === "begin") group = [ev];
		else if (ev.type === "end") await flush(ev);
		else if (group && (ev.type === "match" || ev.type === "context")) group.push(ev);
		else out.push(ev);
	}
	return out;
}

/**
 * Rebuild match/context events from just-bash's plain `path:N:line` / `path-N-line` output (used for
 * multiline searches, whose `--json` output has no match events). `paths` are the files the `--json`
 * run reported, which makes the `path:` prefix unambiguous.
 */
export function eventsFromPlain(stdout: string, paths: string[], onlyMatching: boolean): RgEvent[] {
	const byLength = [...new Set(paths)].sort((a, b) => b.length - a.length);
	const events: RgEvent[] = [];
	let currentPath: string | undefined;
	let open: RgEvent | undefined;
	const close = () => {
		if (currentPath !== undefined) events.push({ type: "end", data: { path: { text: currentPath }, binary_offset: null, stats: {} } });
	};
	const lines = stdout.endsWith("\n") ? stdout.slice(0, -1).split("\n") : stdout.split("\n");
	for (const line of lines) {
		if (line === "--") {
			open = undefined;
			continue;
		}
		let hit: { path: string; n: number; kind: "match" | "context"; text: string } | undefined;
		for (const path of byLength) {
			if (!line.startsWith(path)) continue;
			const m = /^([:-])(\d+)([:-])/.exec(line.slice(path.length));
			if (!m || m[1] !== m[3]) continue;
			hit = { path, n: Number(m[2]), kind: m[1] === ":" ? "match" : "context", text: line.slice(path.length + m[0].length) };
			break;
		}
		if (!hit) {
			// the rest of a multi-line -o match
			if (open?.data?.lines && open.data.submatches) {
				open.data.lines.text = `${open.data.lines.text?.replace(/\n$/, "")}\n${line}\n`;
				const sm = open.data.submatches[0];
				sm.match.text = `${sm.match.text}\n${line}`;
				sm.end = Buffer.byteLength(sm.match.text);
			}
			continue;
		}
		if (hit.path !== currentPath) {
			close();
			currentPath = hit.path;
			events.push({ type: "begin", data: { path: { text: hit.path } } });
		}
		const ev: RgEvent = {
			type: hit.kind,
			data: {
				path: { text: hit.path },
				lines: { text: `${hit.text}\n` },
				line_number: hit.n,
				absolute_offset: 0,
				submatches: hit.kind === "match" && onlyMatching ? [{ match: { text: hit.text }, start: 0, end: Buffer.byteLength(hit.text) }] : [],
			},
		};
		events.push(ev);
		open = hit.kind === "match" && onlyMatching ? ev : undefined;
	}
	close();
	return events;
}

/** ripgrep's wording for the errors just-bash words differently, with ripgrep's exit code 2. */
export function normalizeRgError(stderr: string): string | undefined {
	let m = /^rg: invalid regex: (.*)$/m.exec(stderr);
	if (m) return `rg: regex parse error:\n    ${m[1]}\nerror: invalid regular expression\n`;
	m = /^rg: glob '(.*)' (.*)$/m.exec(stderr);
	if (m) return `rg: error parsing glob '${m[1]}': ${m[2]}\n`;
	m = /^rg: unrecognized option '(.*)'$/m.exec(stderr);
	if (m) return `rg: error parsing flag ${m[1]}: not supported by the memory host's ripgrep (just-bash)\n`;
	m = /^rg: invalid --(\S+) value: (.*)$/m.exec(stderr);
	if (m) return `rg: error parsing flag --${m[1]}: invalid value ${m[2]}\n`;
	return undefined;
}

export class MemoryRipgrep {
	private typeNames?: Promise<Set<string>>;

	constructor(
		private readonly bash: Bash,
		private readonly vfs: InMemoryFs,
	) {}

	private knownTypes(cwd: string): Promise<Set<string>> {
		this.typeNames ??= this.bash.exec("rg", { cwd, args: ["--type-list"] }).then((r) => {
			const names = new Set<string>();
			for (const line of r.stdout.split("\n")) {
				const i = line.indexOf(":");
				if (i > 0) names.add(line.slice(0, i));
			}
			names.add("all");
			return names;
		});
		return this.typeNames;
	}

	async run(input: string[], options: { cwd: string; signal?: AbortSignal }): Promise<HostRipgrepResult> {
		const { cwd, signal } = options;
		if (signal?.aborted) throw abortError();
		const parsed = parseRgArgs(input);
		if (parsed.types.length > 0) {
			const known = await this.knownTypes(cwd);
			const unknown = parsed.types.find((t) => !known.has(t));
			if (unknown !== undefined) return { stdout: "", stderr: `rg: unrecognized file type: ${unknown}\n`, exitCode: 2 };
		}
		const exec = async (args: string[]) => {
			const r = await this.bash.exec("rg", { cwd, args, signal });
			if (signal?.aborted) throw abortError();
			return r;
		};
		const r = await exec(parsed.args);
		const error = normalizeRgError(r.stderr);
		if (error !== undefined) return { stdout: r.stdout, stderr: error, exitCode: 2 };
		let stdout = r.stdout;
		if (parsed.json && r.exitCode === 0) {
			const events = parseEvents(stdout);
			if (parsed.multiline) {
				const paths = events.filter((e) => e.type === "begin").map(pathOf);
				const plainArgs = parsed.args.filter((a) => a !== "--json" && a !== "--null" && a !== "-0");
				const plain = await exec(["--with-filename", ...plainArgs]);
				const rebuilt = eventsFromPlain(plain.stdout, paths, parsed.onlyMatching);
				stdout = stringify([...rebuilt, ...events.filter((e) => e.type === "summary")]);
			} else if (parsed.before > 0 || parsed.after > 0) {
				stdout = stringify(await addContext(events, this.vfs, cwd, parsed.before, parsed.after));
			}
		}
		return { stdout, stderr: r.stderr, exitCode: r.exitCode };
	}
}

import { shellQuote } from "../host/exec.js";

/** Hard cap on captured output kept in memory per command (characters). Oldest output is dropped. */
export const OUTPUT_HARD_CAP = 10 * 1024 * 1024;

/**
 * Append-only text buffer with a hard cap. When the cap is exceeded the oldest text is dropped,
 * but absolute offsets (used by read cursors) keep counting from the very first character.
 */
export class OutputBuffer {
	private text = "";
	/** Number of characters dropped from the front so far. */
	private dropped = 0;

	constructor(private readonly cap = OUTPUT_HARD_CAP) {}

	append(chunk: string): void {
		if (!chunk) return;
		this.text += chunk;
		if (this.text.length > this.cap) {
			// drop in larger steps to avoid re-slicing on every append
			const excess = this.text.length - Math.floor(this.cap * 0.9);
			this.text = this.text.slice(excess);
			this.dropped += excess;
		}
	}

	/** Absolute offset of the end of the buffer. */
	get end(): number {
		return this.dropped + this.text.length;
	}

	get droppedChars(): number {
		return this.dropped;
	}

	/** Text from absolute offset `from` to the end. Returns how many requested chars were already dropped. */
	readFrom(from: number): { text: string; lost: number } {
		const start = Math.max(0, from - this.dropped);
		const lost = Math.max(0, this.dropped - from);
		return { text: this.text.slice(start), lost };
	}

	/** Whole retained text. */
	toString(): string {
		return this.text;
	}

	/** Last `n` characters of retained text. */
	tail(n: number): string {
		return this.text.length > n ? this.text.slice(this.text.length - n) : this.text;
	}
}

export { shellQuote };

/**
 * Build the shell script that runs a user command. Everything is on ONE line so bash reports
 * errors in the user's command as "line 1" (like Claude Code, which also runs `eval '<cmd>'` on
 * the first line of its script):
 * - stderr merged into stdout (preserves interleaving order),
 * - stdin from /dev/null (spawned with stdio "ignore"),
 * - the user command runs through `eval` so syntax errors are reported as a normal non-zero exit,
 * - optional: on success, the final `pwd -P` is written to a side-channel file (Claude Code only
 *   updates the working directory when the command succeeds).
 *
 * Claude Code runs `eval '<cmd>' && pwd -P ...`: the eval is the left side of an `&&` list, where
 * bash ignores `set -e`, so a command using `set -e` keeps going after a failure (quirk
 * `bashErrexit`). With `errexit: true` the eval is a plain statement instead (errexit applies and
 * stops the shell with the failing status); the cwd is still only captured when it succeeded.
 */
export function buildScript(command: string, cwdFile?: string, opts: { errexit?: boolean } = {}): string {
	let script = `exec 2>&1; eval ${shellQuote(command)}`;
	if (!cwdFile) return script;
	if (opts.errexit) {
		script += `; __pi_cc_status=$?; if [ "$__pi_cc_status" -eq 0 ]; then pwd -P >| ${shellQuote(cwdFile)}; fi; exit "$__pi_cc_status"`;
	} else script += ` && pwd -P >| ${shellQuote(cwdFile)}`;
	return script;
}

/** Claude Code's duration format: "0s", "45s", "2m 5s", "30m" (hideTrailingZeros), "1h 30m". */
export function formatClaudeDuration(ms: number, hideTrailingZeros = false): string {
	if (ms < 60000) {
		if (ms === 0) return "0s";
		if (ms < 1) return `${(ms / 1000).toFixed(1)}s`;
		return `${Math.floor(ms / 1000)}s`;
	}
	let d = Math.floor(ms / 86400000);
	let h = Math.floor((ms % 86400000) / 3600000);
	let m = Math.floor((ms % 3600000) / 60000);
	let s = Math.round((ms % 60000) / 1000);
	if (s === 60) (s = 0), m++;
	if (m === 60) (m = 0), h++;
	if (h === 24) (h = 0), d++;
	const o = hideTrailingZeros;
	if (d > 0) {
		if (o && h === 0 && m === 0) return `${d}d`;
		if (o && m === 0) return `${d}d ${h}h`;
		return `${d}d ${h}h ${m}m`;
	}
	if (h > 0) {
		if (o && m === 0 && s === 0) return `${h}h`;
		if (o && s === 0) return `${h}h ${m}m`;
		return `${h}h ${m}m ${s}s`;
	}
	if (m > 0) {
		if (o && s === 0) return `${m}m`;
		return `${m}m ${s}s`;
	}
	return `${s}s`;
}

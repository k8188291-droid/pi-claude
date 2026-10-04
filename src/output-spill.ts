import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { CCContext } from "./shared/context.js";

/**
 * Large tool output → file, for every tool in the session (ours, other extensions', SDK
 * customTools, Task results).
 *
 * Implemented as a `tool_result` handler. pi chains `tool_result` handlers in extension load order
 * (and registration order within an extension); each handler sees the previous handler's patch.
 * This handler therefore sees everything earlier handlers did, but extensions loaded AFTER ours
 * run after it.
 */

const DEFAULT_MAX_CHARS = 30_000;
const DEFAULT_PREVIEW_CHARS = 2_000;
/** Never spilled: Read (spilling would make the model Read the spill file forever) and ToolSearch (schemas must stay inline). */
const ALWAYS_EXCLUDED = ["Read", "ToolSearch"];

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function previewLabel(chars: number): string {
	return chars >= 1000 && chars % 1000 === 0 ? `${chars / 1000}KB` : `${chars} characters`;
}

function sanitize(s: string, max = 100): string {
	const out = s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "_").slice(0, max);
	return out || "unknown";
}

/** First `max` chars, cut at the last line break if that keeps at least half of the budget. */
export function makePreview(text: string, max: number): { preview: string; truncated: boolean } {
	if (text.length <= max) return { preview: text, truncated: false };
	const slice = text.slice(0, max);
	const nl = slice.lastIndexOf("\n");
	return { preview: nl >= max / 2 ? slice.slice(0, nl) : slice, truncated: true };
}

function countLines(text: string): number {
	if (text.length === 0) return 0;
	let n = 1;
	for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
	return text.endsWith("\n") ? n - 1 : n;
}

export function registerOutputSpill(pi: ExtensionAPI, cc: CCContext): void {
	if (cc.options.outputSpill === false) return;
	const opts = cc.options.outputSpill;
	const maxChars = Math.max(1, opts?.maxChars ?? DEFAULT_MAX_CHARS);
	const previewChars = Math.max(0, Math.min(opts?.previewChars ?? DEFAULT_PREVIEW_CHARS, maxChars));
	const excluded = new Set([...ALWAYS_EXCLUDED, ...(opts?.exclude ?? [])]);
	const fallbackId = randomBytes(8).toString("hex");

	const spillDir = (ctx: ExtensionContext): string => {
		if (opts?.dir) return opts.dir;
		let sessionId: string | undefined;
		try {
			sessionId = ctx.sessionManager?.getSessionId?.();
		} catch {
			sessionId = undefined;
		}
		return join(tmpdir(), "pi-cc-tool-results", sanitize(sessionId || fallbackId));
	};

	pi.on("tool_result", async (event, ctx) => {
		if (excluded.has(event.toolName)) return undefined;
		const content = event.content ?? [];
		const texts: string[] = [];
		let total = 0;
		for (const block of content) {
			if (block.type === "text") {
				texts.push(block.text);
				total += block.text.length;
			}
		}
		if (total <= maxChars) return undefined;

		const fullText = texts.join("\n");
		const dir = spillDir(ctx);
		const path = join(dir, `${sanitize(event.toolName)}-${sanitize(event.toolCallId)}.txt`);
		const bytes = Buffer.byteLength(fullText, "utf8");
		const lines = countLines(fullText);
		const { preview, truncated } = makePreview(fullText, previewChars);

		let header: string;
		let footer: string;
		let saved = true;
		try {
			await mkdir(dir, { recursive: true });
			await writeFile(path, fullText, "utf8");
			header = `Output too large (${formatSize(bytes)}; ${fullText.length.toLocaleString("en-US")} characters, ${lines.toLocaleString("en-US")} lines). Full output saved to: ${path}`;
			footer = `Use the Read tool with offset/limit on ${path} to view the rest of the output (${lines.toLocaleString("en-US")} lines), or Grep to search it.`;
		} catch (err) {
			saved = false;
			const msg = err instanceof Error ? err.message : String(err);
			header = `Output too large (${formatSize(bytes)}; ${fullText.length.toLocaleString("en-US")} characters, ${lines.toLocaleString("en-US")} lines). The full output could not be saved to a file (${msg}) and was truncated.`;
			footer = "Re-run the tool with a narrower scope to see the remaining output.";
		}

		const text = [
			"<persisted-output>",
			header,
			"",
			`Preview (first ${previewLabel(previewChars)}):`,
			preview + (truncated ? "\n..." : ""),
			"",
			footer,
			"</persisted-output>",
		].join("\n");

		// Replace the first text block with the note, drop the other text blocks, keep images in place.
		const newContent: typeof content = [];
		let placed = false;
		for (const block of content) {
			if (block.type !== "text") newContent.push(block);
			else if (!placed) {
				newContent.push({ type: "text", text });
				placed = true;
			}
		}

		if (saved) cc.emit({ type: "output_spilled", toolName: event.toolName, toolCallId: event.toolCallId, path, totalChars: total });
		return { content: newContent };
	});
}

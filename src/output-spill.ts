import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CCContext } from "./shared/context.js";

/**
 * Large tool output → file, for every tool in the session (ours, other extensions', SDK
 * customTools, Task results). Mirrors Claude Code's tool-result persistence:
 *
 * - A result is persisted when its text exceeds the tool's threshold: Claude Code uses
 *   min(tool.maxResultSizeChars, 50000) — Grep 20000, Bash 30000, everything else 50000;
 *   Read is never persisted. `outputSpill.maxChars` overrides the threshold for every tool.
 * - Results containing images are never persisted.
 * - The inline replacement is `<persisted-output>` + size + path + a 2KB preview cut at a line break.
 * - A successful result with no text at all becomes "(<Tool> completed with no output)".
 *
 * Implemented as a `tool_result` handler. pi chains `tool_result` handlers in extension load order
 * (and registration order within an extension); each handler sees the previous handler's patch.
 * This handler therefore sees everything earlier handlers did, but extensions loaded AFTER ours
 * run after it.
 */

/** Claude Code's cap on any tool's persistence threshold. */
export const SPILL_THRESHOLD_CEILING = 50_000;
/** Claude Code's per-tool maxResultSizeChars where it is below the ceiling. */
export const TOOL_SPILL_THRESHOLDS: Record<string, number> = { Grep: 20_000, Bash: 30_000 };
const DEFAULT_PREVIEW_CHARS = 2_000;
/** Never spilled: Read (spilling would make the model Read the spill file forever) and tool_search (schemas must stay inline). */
const ALWAYS_EXCLUDED = ["Read", "tool_search"];

export const PERSISTED_OUTPUT_OPEN = "<persisted-output>";
export const PERSISTED_OUTPUT_CLOSE = "</persisted-output>";

/** Claude Code's size formatter (1024-based, trailing ".0" dropped). */
export function formatSize(bytes: number): string {
	const kb = bytes / 1024;
	if (kb < 1) return `${bytes} bytes`;
	if (kb < 1024) return `${kb.toFixed(1).replace(/\.0$/, "")}KB`;
	const mb = kb / 1024;
	if (mb < 1024) return `${mb.toFixed(1).replace(/\.0$/, "")}MB`;
	return `${(mb / 1024).toFixed(1).replace(/\.0$/, "")}GB`;
}

function sanitize(s: string, max = 100): string {
	const out = s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "_").slice(0, max);
	return out || "unknown";
}

/** First `max` chars, cut at the last line break when that keeps more than half of the budget. */
export function makePreview(text: string, max: number): { preview: string; truncated: boolean } {
	if (text.length <= max) return { preview: text, truncated: false };
	const nl = text.slice(0, max).lastIndexOf("\n");
	return { preview: text.slice(0, nl > max * 0.5 ? nl : max), truncated: true };
}

/** The `<persisted-output>` message Claude Code puts in place of a large result. */
export function formatPersistedOutput(opts: { size: number; path: string; preview: string; truncated: boolean; previewChars?: number }): string {
	return (
		`${PERSISTED_OUTPUT_OPEN}\n` +
		`Output too large (${formatSize(opts.size)}). Full output saved to: ${opts.path}\n\n` +
		`Preview (first ${formatSize(opts.previewChars ?? DEFAULT_PREVIEW_CHARS)}):\n` +
		opts.preview +
		(opts.truncated ? "\n...\n" : "\n") +
		PERSISTED_OUTPUT_CLOSE
	);
}

/** Persistence threshold for a tool (characters of text; results strictly larger are spilled). */
export function spillThreshold(toolName: string, maxChars?: number): number {
	if (maxChars !== undefined) return Math.max(1, maxChars);
	return Math.min(TOOL_SPILL_THRESHOLDS[toolName] ?? SPILL_THRESHOLD_CEILING, SPILL_THRESHOLD_CEILING);
}

export function registerOutputSpill(pi: ExtensionAPI, cc: CCContext): void {
	if (cc.options.outputSpill === false) return;
	const opts = cc.options.outputSpill;
	const previewChars = Math.max(0, opts?.previewChars ?? DEFAULT_PREVIEW_CHARS);
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
		if (event.isError) return undefined;
		const content = event.content ?? [];
		const texts = content.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text");
		const hasImage = content.some((b) => b.type !== "text");

		if (!hasImage && texts.every((b) => typeof b.text !== "string" || b.text.trim() === "")) {
			return { content: [{ type: "text", text: `(${event.toolName} completed with no output)` }] };
		}
		if (excluded.has(event.toolName) || hasImage) return undefined;

		let total = 0;
		for (const b of texts) total += b.text.length;
		if (total <= spillThreshold(event.toolName, opts?.maxChars)) return undefined;

		// Claude Code persists a single text result as text, a multi-block result as JSON.
		const isJson = texts.length > 1;
		const fullText = isJson ? JSON.stringify(texts, null, 2) : texts[0].text;
		const dir = spillDir(ctx);
		const path = join(dir, `${sanitize(event.toolCallId)}.${isJson ? "json" : "txt"}`);
		try {
			await mkdir(dir, { recursive: true });
			await writeFile(path, fullText, "utf8");
		} catch {
			// Claude Code keeps the original result when it cannot be persisted.
			return undefined;
		}
		const { preview, truncated } = makePreview(fullText, previewChars);
		const text = formatPersistedOutput({ size: fullText.length, path, preview, truncated, previewChars });
		cc.emit({ type: "output_spilled", toolName: event.toolName, toolCallId: event.toolCallId, path, totalChars: total });
		return { content: [{ type: "text", text }] };
	});
}

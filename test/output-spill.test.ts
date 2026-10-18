import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { formatPersistedOutput, formatSize, makePreview, registerOutputSpill, spillThreshold } from "../src/output-spill.js";
import { createCCContext } from "../src/shared/context.js";
import type { ClaudeCodeHostEvent } from "../src/shared/types.js";
import { createTestSession, fakeCtx, fauxAssistantMessage, fauxToolCall, tempDir } from "./helpers.js";

function bigText(lines: number, width = 99): string {
	const out: string[] = [];
	for (let i = 1; i <= lines; i++) out.push(`line ${String(i).padStart(5, "0")} ${"x".repeat(width - 11)}`);
	return out.join("\n");
}

function tool(pi: ExtensionAPI, name: string, run: (p: any) => any) {
	pi.registerTool({
		name,
		label: name,
		description: name,
		parameters: { type: "object", properties: { n: { type: "number" } } } as any,
		async execute(_id, p: any) {
			return run(p);
		},
	});
}

const BIG = bigText(600); // 600 lines * 100 chars ≈ 60k (> the 50k default threshold)
const tools: ExtensionFactory = (pi) => {
	tool(pi, "Big", () => ({ content: [{ type: "text", text: BIG }], details: { kept: true } }));
	tool(pi, "Small", () => ({ content: [{ type: "text", text: "small" }], details: {} }));
	tool(pi, "Empty", () => ({ content: [{ type: "text", text: "" }], details: {} }));
	tool(pi, "BigImg", () => ({
		content: [
			{ type: "text", text: BIG },
			{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
		],
		details: {},
	}));
	tool(pi, "BigFail", () => {
		throw new Error(BIG);
	});
};

/** Drive the registered tool_result handler directly. */
function handlerHarness(options: Parameters<typeof createCCContext>[0]) {
	const handlers: Function[] = [];
	const fakePi = new Proxy({}, { get: (_t, p) => (p === "on" ? (ev: string, h: Function) => ev === "tool_result" && handlers.push(h) : () => undefined) });
	registerOutputSpill(fakePi as any, createCCContext(options));
	const ctx = fakeCtx(tempDir());
	return async (toolName: string, content: any[], isError = false) => {
		let ev: any = { type: "tool_result", toolName, toolCallId: "x", input: {}, content, isError };
		for (const h of handlers) {
			const r = await h(ev, ctx);
			if (r) ev = { ...ev, ...r };
		}
		return ev.content as any[];
	};
}

describe("output spill", () => {
	it("spills large output to a file and leaves Claude Code's <persisted-output> preview", async () => {
		const events: ClaudeCodeHostEvent[] = [];
		const dir = tempDir("pi-cc-spill-");
		const t = await createTestSession({
			claudeCode: { outputSpill: { dir }, onEvent: (e) => events.push(e) },
			extraExtensions: [tools],
			responses: [
				fauxAssistantMessage([fauxToolCall("Big", {}, { id: "call/1" }), fauxToolCall("Small", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			],
		});
		await t.session.prompt("go");
		const [big, small] = t.toolResults();
		const path = join(dir, "call_1.txt");
		expect(readFileSync(path, "utf8")).toBe(BIG);
		expect(big!.isError).toBe(false);
		expect(big!.details).toEqual({ kept: true });
		const preview = BIG.slice(0, BIG.slice(0, 2000).lastIndexOf("\n"));
		expect(big!.text).toBe(
			`<persisted-output>\nOutput too large (58.6KB). Full output saved to: ${path}\n\nPreview (first 2KB):\n${preview}\n...\n</persisted-output>`,
		);
		expect(small!.text).toBe("small");
		expect(events).toContainEqual({ type: "output_spilled", toolName: "Big", toolCallId: "call/1", path, totalChars: BIG.length });
		t.dispose();
	});

	it("never spills results with images or error results; honors exclude/maxChars", async () => {
		const dir = tempDir("pi-cc-spill-");
		const t = await createTestSession({
			claudeCode: { outputSpill: { dir, maxChars: 40000, exclude: ["Small"] } },
			extraExtensions: [tools],
			responses: [
				fauxAssistantMessage([fauxToolCall("BigImg", {}), fauxToolCall("BigFail", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			],
		});
		await t.session.prompt("go");
		const msgs = t.session.messages.filter((m: any) => m.role === "toolResult") as any[];
		const img = msgs.find((m) => m.toolName === "BigImg");
		expect(img.content.map((c: any) => c.type)).toEqual(["text", "image"]);
		expect(img.content[0].text).toBe(BIG);
		const fail = msgs.find((m) => m.toolName === "BigFail");
		expect(fail.isError).toBe(true);
		expect(fail.content[0].text).not.toContain("Output too large");
		t.dispose();
	});

	it("does not spill when under the limit, excluded, or disabled", async () => {
		const dir = tempDir("pi-cc-spill-");
		const t = await createTestSession({
			claudeCode: { outputSpill: { dir, exclude: ["Big"] } },
			extraExtensions: [tools],
			responses: [fauxAssistantMessage(fauxToolCall("Big", {}), { stopReason: "toolUse" }), fauxAssistantMessage("done")],
		});
		await t.session.prompt("go");
		expect(t.toolResults()[0]!.text).toBe(BIG);
		t.dispose();

		const t2 = await createTestSession({
			claudeCode: { outputSpill: false },
			extraExtensions: [tools],
			responses: [fauxAssistantMessage(fauxToolCall("Big", {}), { stopReason: "toolUse" }), fauxAssistantMessage("done")],
		});
		await t2.session.prompt("go");
		expect(t2.toolResults()[0]!.text).toBe(BIG);
		t2.dispose();
	});

	it("defaults the directory to <tmpdir>/pi-cc-tool-results/<sessionId>", async () => {
		const t = await createTestSession({
			extraExtensions: [tools],
			responses: [fauxAssistantMessage(fauxToolCall("Big", {}, { id: "abc" }), { stopReason: "toolUse" }), fauxAssistantMessage("done")],
		});
		await t.session.prompt("go");
		const expected = join(tmpdir(), "pi-cc-tool-results", t.session.sessionManager.getSessionId(), "abc.txt");
		expect(t.toolResults()[0]!.text).toContain(expected);
		expect(existsSync(expected)).toBe(true);
		t.dispose();
	});

	it("replaces an empty result with '(<Tool> completed with no output)'", async () => {
		const t = await createTestSession({
			extraExtensions: [tools],
			responses: [fauxAssistantMessage(fauxToolCall("Empty", {}), { stopReason: "toolUse" }), fauxAssistantMessage("done")],
		});
		await t.session.prompt("go");
		expect(t.toolResults()[0]!.text).toBe("(Empty completed with no output)");
		t.dispose();
	});

	it("uses Claude Code's per-tool thresholds: Grep 20000, Bash 30000, others 50000; never Read", async () => {
		const run = handlerHarness({ outputSpill: { dir: tempDir() } });
		const text = (n: number) => [{ type: "text", text: "a".repeat(n) }];
		expect((await run("Grep", text(20000)))[0].text).toHaveLength(20000);
		expect((await run("Grep", text(20001)))[0].text).toMatch(/^<persisted-output>\nOutput too large \(19.5KB\)/);
		expect((await run("Bash", text(30000)))[0].text).toHaveLength(30000);
		expect((await run("Bash", text(30001)))[0].text).toContain("Output too large (29.3KB)");
		expect((await run("Glob", text(50000)))[0].text).toHaveLength(50000);
		expect((await run("Glob", text(50001)))[0].text).toContain("Output too large");
		expect((await run("Read", text(500000)))[0].text).toHaveLength(500000);
		expect(spillThreshold("Anything")).toBe(50000);
		expect(spillThreshold("Grep", 10)).toBe(10);
	});

	it("persists multi-block text results as JSON", async () => {
		const dir = tempDir();
		const run = handlerHarness({ outputSpill: { dir } });
		const blocks = [
			{ type: "text", text: "a".repeat(30000) },
			{ type: "text", text: "b".repeat(30000) },
		];
		const out = await run("Multi", blocks);
		const file = out[0].text.match(/saved to: (.*)\n/)[1];
		expect(file.endsWith(".json")).toBe(true);
		expect(readFileSync(file, "utf8")).toBe(JSON.stringify(blocks, null, 2));
	});

	it("keeps the original result when the file cannot be written", async () => {
		const blocker = join(tempDir(), "file");
		writeFileSync(blocker, "x");
		const run = handlerHarness({ outputSpill: { dir: join(blocker, "sub") } });
		expect((await run("Other", [{ type: "text", text: BIG }]))[0].text).toBe(BIG);
	});
});

describe("formatting helpers", () => {
	it("makePreview cuts at a line break only past half of the budget", () => {
		expect(makePreview("aaa\nbbb\nccc", 9)).toEqual({ preview: "aaa\nbbb", truncated: true });
		expect(makePreview("a\n" + "b".repeat(20), 10)).toEqual({ preview: "a\n" + "b".repeat(8), truncated: true });
		expect(makePreview("aaaaa\n" + "b".repeat(20), 10)).toEqual({ preview: "aaaaa\nbbbb", truncated: true });
		expect(makePreview("short", 10)).toEqual({ preview: "short", truncated: false });
	});

	it("formatSize matches Claude Code", () => {
		expect(formatSize(1000)).toBe("1000 bytes");
		expect(formatSize(2000)).toBe("2KB");
		expect(formatSize(228893)).toBe("223.5KB");
		expect(formatSize(3 * 1024 * 1024)).toBe("3MB");
	});

	it("formatPersistedOutput", () => {
		expect(formatPersistedOutput({ size: 30000, path: "/p", preview: "x", truncated: false })).toBe(
			"<persisted-output>\nOutput too large (29.3KB). Full output saved to: /p\n\nPreview (first 2KB):\nx\n</persisted-output>",
		);
	});
});

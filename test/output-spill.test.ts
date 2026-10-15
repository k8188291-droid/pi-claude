import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { makePreview, registerOutputSpill } from "../src/output-spill.js";
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

const BIG = bigText(500); // 500 lines * 100 chars ≈ 50k
const tools: ExtensionFactory = (pi) => {
	tool(pi, "Big", () => ({ content: [{ type: "text", text: BIG }], details: { kept: true } }));
	tool(pi, "Small", () => ({ content: [{ type: "text", text: "small" }], details: {} }));
	tool(pi, "BigImg", () => ({
		content: [
			{ type: "text", text: BIG.slice(0, 20000) },
			{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
			{ type: "text", text: BIG.slice(20000) },
		],
		details: {},
	}));
	tool(pi, "BigFail", () => {
		throw new Error(BIG);
	});
};

describe("output spill", () => {
	it("spills large output to a file and leaves a preview with instructions", async () => {
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
		const path = join(dir, "Big-call_1.txt");
		expect(readFileSync(path, "utf8")).toBe(BIG);
		expect(big!.isError).toBe(false);
		expect(big!.details).toEqual({ kept: true });
		expect(big!.text).toMatch(/^<persisted-output>\nOutput too large \(48\.8KB; 49,999 characters, 500 lines\)\. Full output saved to: /);
		expect(big!.text).toContain(`Full output saved to: ${path}`);
		expect(big!.text).toContain("Preview (first 2KB):\nline 00001");
		expect(big!.text).toContain("Read tool with offset/limit");
		expect(big!.text).toContain("Grep");
		expect(big!.text.length).toBeLessThan(2600);
		// preview cut at a line boundary: last preview line is complete
		const preview = big!.text.split("Preview (first 2KB):\n")[1]!.split("\n...")[0]!;
		expect(preview.split("\n").every((l) => l.length === 99)).toBe(true);
		expect(small!.text).toBe("small");
		expect(events).toContainEqual({ type: "output_spilled", toolName: "Big", toolCallId: "call/1", path, totalChars: BIG.length });
		t.dispose();
	});

	it("keeps images, preserves isError, and honors exclude/maxChars", async () => {
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
		expect(img.content[0].text).toContain("Output too large");
		const file = img.content[0].text.match(/saved to: (.*)\n/)[1];
		expect(readFileSync(file, "utf8")).toBe(`${BIG.slice(0, 20000)}\n${BIG.slice(20000)}`);
		const fail = msgs.find((m) => m.toolName === "BigFail");
		expect(fail.isError).toBe(true);
		expect(fail.content[0].text).toContain("Output too large");
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
		const expected = join(tmpdir(), "pi-cc-tool-results", t.session.sessionManager.getSessionId(), "Big-abc.txt");
		expect(t.toolResults()[0]!.text).toContain(expected);
		expect(existsSync(expected)).toBe(true);
		t.dispose();
	});

	it("never spills Read output", async () => {
		const handlers: Function[] = [];
		const fakePi = new Proxy({}, { get: (_t, p) => (p === "on" ? (ev: string, h: Function) => ev === "tool_result" && handlers.push(h) : () => undefined) });
		registerOutputSpill(fakePi as any, createCCContext({ outputSpill: { dir: tempDir(), maxChars: 10 } }));
		const ctx = fakeCtx(tempDir());
		const run = async (toolName: string) => {
			let ev: any = { type: "tool_result", toolName, toolCallId: "x", input: {}, content: [{ type: "text", text: BIG }], isError: false };
			for (const h of handlers) {
				const r = await h(ev, ctx);
				if (r) ev = { ...ev, ...r };
			}
			return ev.content[0].text as string;
		};
		expect(await run("Read")).toBe(BIG);
		expect(await run("Other")).toContain("Output too large");
	});
});

describe("makePreview", () => {
	it("cuts at a line boundary when possible", () => {
		expect(makePreview("aaa\nbbb\nccc", 9)).toEqual({ preview: "aaa\nbbb", truncated: true });
		expect(makePreview("a\n" + "b".repeat(20), 10)).toEqual({ preview: "a\n" + "b".repeat(8), truncated: true });
		expect(makePreview("short", 10)).toEqual({ preview: "short", truncated: false });
	});
});

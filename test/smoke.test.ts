import { describe, expect, it } from "vitest";
import { createTestSession, fauxAssistantMessage, fauxText, fauxToolCall } from "./helpers.js";

describe("harness smoke", () => {
	it("runs a faux session with the extension and builtins disabled", async () => {
		let seenTools: string[] = [];
		const t = await createTestSession({
			responses: [
				(ctx) => {
					seenTools = (ctx.tools ?? []).map((x: any) => x.name);
					return fauxAssistantMessage(fauxText("hello"));
				},
			],
		});
		await t.session.prompt("hi");
		expect(seenTools).not.toContain("read");
		expect(seenTools).not.toContain("bash");
		const last = t.session.messages.at(-1) as any;
		expect(last.role).toBe("assistant");
		t.dispose();
	});

	it("executes an extension tool call", async () => {
		const t = await createTestSession({
			responses: [fauxAssistantMessage(fauxToolCall("Echo", { v: "x" }), { stopReason: "toolUse" }), fauxAssistantMessage("done")],
			extraExtensions: [
				(pi) =>
					pi.registerTool({
						name: "Echo",
						label: "Echo",
						description: "echo",
						parameters: { type: "object", properties: { v: { type: "string" } }, required: ["v"] } as any,
						async execute(_id, p: any) {
							return { content: [{ type: "text", text: `echo:${p.v}` }], details: {} };
						},
					}),
			],
		});
		await t.session.prompt("go");
		expect(t.toolResults()[0]).toMatchObject({ toolName: "Echo", text: "echo:x", isError: false });
		t.dispose();
	});
});

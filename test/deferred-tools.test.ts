import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestSession, fauxAssistantMessage, fauxToolCall } from "./helpers.js";

const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
const names = (ctx: any): string[] => (ctx.tools ?? []).map((t: any) => t.name);

describe("deferred tools via pi's built-in tool_search", () => {
	it("hides deferred tools until tool_search loads them, usable in the same run", async () => {
		const seen: string[][] = [];
		const t = await createTestSession({
			claudeCode: { deferredTools: ["Glob"] },
			responses: [
				(ctx) => {
					seen.push(names(ctx));
					return toolUse(fauxToolCall("tool_search", { query: "glob file name pattern" }));
				},
				(ctx) => {
					seen.push(names(ctx));
					return toolUse(fauxToolCall("Glob", { pattern: "*.txt" }));
				},
				fauxAssistantMessage("done"),
			],
		});
		writeFileSync(join(t.cwd, "a.txt"), "x");
		await t.session.prompt("find txt files");
		expect(seen[0]).toContain("tool_search");
		expect(seen[0]).not.toContain("Glob");
		expect(seen[0]).toContain("Read");
		expect(seen[1]).toContain("Glob");
		const r = t.toolResults();
		expect(r[0]).toMatchObject({ toolName: "tool_search", isError: false });
		expect(r[1]).toMatchObject({ toolName: "Glob", isError: false });
		expect(r[1].text).toContain("a.txt");
		t.dispose();
	});

	it("does not activate tool_search when nothing is deferred", async () => {
		let seen: string[] = [];
		const t = await createTestSession({
			responses: [
				(ctx) => {
					seen = names(ctx);
					return fauxAssistantMessage("ok");
				},
			],
		});
		await t.session.prompt("hi");
		expect(seen).not.toContain("tool_search");
		t.dispose();
	});

	it("activates tool_search for host tools registered with exposure: deferred", async () => {
		let seen: string[] = [];
		const t = await createTestSession({
			extraExtensions: [
				(pi) =>
					pi.registerTool({
						name: "RareTool",
						label: "RareTool",
						description: "rarely used",
						exposure: "deferred",
						parameters: { type: "object", properties: {} } as any,
						async execute() {
							return { content: [{ type: "text", text: "x" }], details: undefined };
						},
					}),
			],
			responses: [
				(ctx) => {
					seen = names(ctx);
					return fauxAssistantMessage("ok");
				},
			],
		});
		await t.session.prompt("hi");
		expect(seen).toContain("tool_search");
		expect(seen).not.toContain("RareTool");
		t.dispose();
	});

	it("subagents restricted to a deferred tool get tool_search to load it", async () => {
		let child: string[] = [];
		let childAfter: string[] = [];
		const t = await createTestSession({
			claudeCode: {
				deferredTools: ["Glob"],
				loadAgentsFromDisk: false,
				agents: { finder: { description: "finds files", prompt: "CHILD", tools: ["Glob", "Read"] } },
			},
			responses: [
				toolUse(fauxToolCall("Task", { description: "find files", prompt: "go", subagent_type: "finder" })),
				(ctx) => {
					child = names(ctx);
					return toolUse(fauxToolCall("tool_search", { query: "glob file pattern" }));
				},
				(ctx) => {
					childAfter = names(ctx);
					return fauxAssistantMessage("child done");
				},
				fauxAssistantMessage("parent done"),
			],
		});
		await t.session.prompt("go");
		expect(child.sort()).toEqual(["Read", "tool_search"]);
		expect(childAfter).toContain("Glob");
		t.dispose();
	});
});

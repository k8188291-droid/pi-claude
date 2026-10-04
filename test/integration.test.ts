import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ClaudeCodeHostEvent } from "../src/shared/types.js";
import { createTestSession, fauxAssistantMessage, fauxToolCall } from "./helpers.js";

const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });

describe("integration: all modules together", () => {
	it("exposes exactly the Claude Code tool set", async () => {
		let names: string[] = [];
		const t = await createTestSession({
			responses: [
				(ctx) => {
					names = (ctx.tools ?? []).map((x: any) => x.name).sort();
					return fauxAssistantMessage("ok");
				},
			],
		});
		await t.session.prompt("hi");
		expect(names).toEqual(["AskUserQuestion", "Bash", "BashOutput", "Edit", "Glob", "Grep", "KillShell", "Read", "Task", "TodoWrite", "Write"]);
		t.dispose();
	});

	it("Read → Edit → Bash big output spilled → Read the spill file → TodoWrite", async () => {
		const events: ClaudeCodeHostEvent[] = [];
		const t = await createTestSession({
			responses: [],
			claudeCode: { onEvent: (e) => events.push(e) },
		});
		const file = join(t.cwd, "a.txt");
		writeFileSync(file, "hello world\n");
		let spillPath = "";
		t.faux.setResponses([
			toolUse(fauxToolCall("Edit", { file_path: file, old_string: "hello", new_string: "bye" })),
			toolUse(fauxToolCall("Read", { file_path: file })),
			toolUse(fauxToolCall("Edit", { file_path: file, old_string: "hello", new_string: "bye" })),
			toolUse(fauxToolCall("Bash", { command: "seq 1 20000" })),
			(ctx) => {
				const last = ctx.messages.at(-1) as any;
				const text = last.content.map((c: any) => c.text ?? "").join("");
				spillPath = /Full output saved to: (\S+)/.exec(text)?.[1] ?? "";
				return toolUse(fauxToolCall("Read", { file_path: spillPath, offset: 19999, limit: 2 }));
			},
			toolUse(
				fauxToolCall("TodoWrite", {
					todos: [{ content: "Check output", activeForm: "Checking output", status: "completed" }],
				}),
			),
			fauxAssistantMessage("done"),
		]);
		await t.session.prompt("go");
		const r = t.toolResults();
		expect(r[0]).toMatchObject({ toolName: "Edit", isError: true });
		expect(r[0].text).toMatch(/has not been read/);
		expect(r[1]).toMatchObject({ toolName: "Read", isError: false });
		expect(r[2]).toMatchObject({ toolName: "Edit", isError: false });
		expect(readFileSync(file, "utf8")).toBe("bye world\n");
		expect(r[3].toolName).toBe("Bash");
		expect(r[3].text.length).toBeLessThan(10000);
		expect(spillPath).not.toBe("");
		expect(r[4]).toMatchObject({ toolName: "Read", isError: false });
		expect(r[4].text).toMatch(/19999\t19999/);
		expect(r[4].text).toMatch(/20000\t20000/);
		expect(events.some((e) => e.type === "output_spilled")).toBe(true);
		expect(events.some((e) => e.type === "todos_updated" && e.todos.length === 1)).toBe(true);
		t.dispose();
	});

	it("subagentExtensions are installed in Task child sessions", async () => {
		let childTools: string[] = [];
		const t = await createTestSession({
			responses: [
				toolUse(fauxToolCall("Task", { description: "check tools", prompt: "list tools", subagent_type: "general-purpose" })),
				(ctx) => {
					childTools = (ctx.tools ?? []).map((x: any) => x.name);
					return fauxAssistantMessage("child done");
				},
				fauxAssistantMessage("parent done"),
			],
			claudeCode: {
				loadAgentsFromDisk: false,
				subagentExtensions: [
					(pi) =>
						pi.registerTool({
							name: "HostTool",
							label: "HostTool",
							description: "host tool",
							parameters: { type: "object", properties: {} } as any,
							async execute() {
								return { content: [{ type: "text", text: "x" }], details: {} };
							},
						}),
				],
			},
		});
		await t.session.prompt("go");
		expect(childTools).toContain("HostTool");
		expect(childTools).not.toContain("Task");
		expect(t.toolResults()[0].text).toMatch(/child done/);
		t.dispose();
	});
});

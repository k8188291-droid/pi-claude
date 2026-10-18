import { describe, expect, it } from "vitest";
import { createTestSession, fauxAssistantMessage, fauxToolCall } from "./helpers.js";

const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("background command completion notification", () => {
	it("is attached to the next tool result while the agent is running", async () => {
		const t = await createTestSession({
			responses: [
				toolUse(fauxToolCall("Bash", { command: "sleep 0.2; echo hi", run_in_background: true })),
				toolUse(fauxToolCall("Bash", { command: "sleep 0.6; echo waited" })),
				fauxAssistantMessage("done"),
				fauxAssistantMessage("UNEXPECTED extra turn"),
			],
		});
		await t.session.prompt("go");
		await sleep(300);
		await t.session.agent.waitForIdle();
		const results = t.toolResults();
		expect(results[1].text).toMatch(/^waited/);
		expect(results[1].text).toContain("<task-notification>");
		expect(results[1].text).toContain('<summary>Background command "sleep 0.2; echo hi" completed (exit code 0)</summary>');
		expect(t.faux.state.callCount).toBe(3);
		t.dispose();
	});

	it("starts a new turn when the command finishes while idle", async () => {
		const t = await createTestSession({
			responses: [
				toolUse(fauxToolCall("Bash", { command: "sleep 0.5; echo hi", run_in_background: true })),
				fauxAssistantMessage("started"),
				(ctx) => {
					const last = JSON.stringify(ctx.messages.at(-1));
					return fauxAssistantMessage(last.includes("<task-notification>") && last.includes("completed (exit code 0)") ? "notified" : "wrong");
				},
			],
		});
		await t.session.prompt("go");
		expect(t.faux.state.callCount).toBe(2);
		for (let i = 0; i < 40 && t.faux.state.callCount < 3; i++) await sleep(50);
		await t.session.agent.waitForIdle();
		expect(t.faux.state.callCount).toBe(3);
		const last = t.session.messages.at(-1) as any;
		expect(last.content[0].text).toBe("notified");
		t.dispose();
	});

	it("is not sent for a command stopped with TaskStop", async () => {
		const t = await createTestSession({
			responses: [
				toolUse(fauxToolCall("Bash", { command: "sleep 5", run_in_background: true })),
				(ctx) => {
					const text = JSON.stringify(ctx.messages.at(-1));
					const id = /ID: (b[0-9a-z]{8})/.exec(text)?.[1] ?? "none";
					return toolUse(fauxToolCall("TaskStop", { task_id: id }));
				},
				fauxAssistantMessage("stopped"),
				fauxAssistantMessage("UNEXPECTED extra turn"),
			],
		});
		await t.session.prompt("go");
		await sleep(400);
		await t.session.agent.waitForIdle();
		expect(t.toolResults()[1].text).toContain("Successfully stopped task");
		expect(t.faux.state.callCount).toBe(3);
		t.dispose();
	});
});

import { describe, expect, it } from "vitest";
import { createTestSession, fauxAssistantMessage, fauxToolCall } from "./helpers.js";

const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("background shell completion notice", () => {
	it("is skipped when the model already read the final status via BashOutput", async () => {
		const t = await createTestSession({
			responses: [
				toolUse(fauxToolCall("Bash", { command: "sleep 0.2; echo hi", run_in_background: true })),
				async () => {
					await sleep(600); // shell exits while the agent is still running
					return toolUse(fauxToolCall("BashOutput", { bash_id: "bash_1" }));
				},
				fauxAssistantMessage("done"),
				fauxAssistantMessage("UNEXPECTED extra turn"),
			],
		});
		await t.session.prompt("go");
		await sleep(400);
		await t.session.agent.waitForIdle();
		expect(t.toolResults()[1].text).toMatch(/<status>completed<\/status>/);
		expect(t.faux.state.callCount).toBe(3);
		t.dispose();
	});

	it("wakes the agent after the run when the model never read the result", async () => {
		const t = await createTestSession({
			responses: [
				toolUse(fauxToolCall("Bash", { command: "sleep 0.2; echo hi", run_in_background: true })),
				async () => {
					await sleep(600);
					return fauxAssistantMessage("first run done");
				},
				(ctx) => {
					const last = JSON.stringify(ctx.messages.at(-1));
					return fauxAssistantMessage(last.includes("bash_1") && last.includes("completed") ? "notified" : "wrong");
				},
			],
		});
		await t.session.prompt("go");
		for (let i = 0; i < 40 && t.faux.state.callCount < 3; i++) await sleep(50);
		await t.session.agent.waitForIdle();
		expect(t.faux.state.callCount).toBe(3);
		const last = t.session.messages.at(-1) as any;
		expect(last.content[0].text).toBe("notified");
		t.dispose();
	});

	it("wakes immediately when the shell exits while idle", async () => {
		const t = await createTestSession({
			responses: [
				toolUse(fauxToolCall("Bash", { command: "sleep 0.5; echo hi", run_in_background: true })),
				fauxAssistantMessage("started"),
				fauxAssistantMessage("notified"),
			],
		});
		await t.session.prompt("go");
		expect(t.faux.state.callCount).toBe(2);
		for (let i = 0; i < 40 && t.faux.state.callCount < 3; i++) await sleep(50);
		await t.session.agent.waitForIdle();
		expect(t.faux.state.callCount).toBe(3);
		t.dispose();
	});
});

import { describe, expect, it, vi } from "vitest";
import { registerAskUserQuestion } from "../src/tools/ask-user-question.js";
import { createCCContext } from "../src/shared/context.js";
import type { AskUserQuestionItem, ClaudeCodeToolsOptions } from "../src/shared/types.js";
import { captureTools, createTestSession, fakeCtx, fauxAssistantMessage, fauxToolCall, resultText } from "./helpers.js";

function setup(options: ClaudeCodeToolsOptions = {}) {
	const cc = createCCContext(options);
	const { tools } = captureTools((pi) => registerAskUserQuestion(pi, cc));
	const tool = tools.get("AskUserQuestion")!;
	const run = (params: any, opts: { signal?: AbortSignal; ctx?: any } = {}) =>
		tool.execute("call-1", params, opts.signal, undefined, opts.ctx ?? fakeCtx("/tmp"));
	return { tool, run };
}

const opt = (label: string) => ({ label, description: `${label} description` });
const q = (question: string, extra: Partial<AskUserQuestionItem> = {}): AskUserQuestionItem => ({
	question,
	header: "Header",
	options: [opt("A"), opt("B")],
	multiSelect: false,
	...extra,
});

describe("AskUserQuestion schema & validation", () => {
	it("exposes the Claude Code schema", () => {
		const { tool } = setup();
		const p = tool.parameters as any;
		expect(Object.keys(p.properties)).toEqual(["questions", "answers", "metadata"]);
		expect(p.required).toEqual(["questions"]);
		expect(p.properties.questions.minItems).toBe(1);
		expect(p.properties.questions.maxItems).toBe(4);
		const item = p.properties.questions.items;
		expect(item.required.sort()).toEqual(["header", "multiSelect", "options", "question"]);
		expect(item.properties.options.minItems).toBe(2);
		expect(item.properties.options.maxItems).toBe(4);
		expect(item.properties.options.items.required.sort()).toEqual(["description", "label"]);
	});

	const host = vi.fn(async () => ({}));
	it.each([
		["no questions", { questions: [] }, /1-4 questions/],
		["too many questions", { questions: [q("1?"), q("2?"), q("3?"), q("4?"), q("5?")] }, /1-4 questions/],
		["too few options", { questions: [q("1?", { options: [opt("A")] })] }, /2-4 options/],
		["too many options", { questions: [q("1?", { options: ["A", "B", "C", "D", "E"].map(opt) })] }, /2-4 options/],
		["header too long", { questions: [q("1?", { header: "Thirteen char" })] }, /too long \(max 12/],
		["duplicate labels", { questions: [q("1?", { options: [opt("A"), opt("A")] })] }, /labels must be unique/],
		["duplicate questions", { questions: [q("Same?"), q("Same?")] }, /question texts must be unique/],
	])("rejects %s", async (_name, params, re) => {
		const { run } = setup({ onAskUserQuestion: host });
		await expect(run(params)).rejects.toThrow(re);
		expect(host).not.toHaveBeenCalled();
	});

	it("accepts a 12-char header and the optional answers/metadata fields", async () => {
		const { run } = setup({ onAskUserQuestion: async () => ({ "1?": "A" }) });
		const r = await run({ questions: [q("1?", { header: "Twelve chars" })], answers: {}, metadata: { source: "x" } });
		expect(resultText(r)).toContain('"1?"="A"');
	});
});

describe("AskUserQuestion execution", () => {
	it("passes questions to the host callback and formats answers", async () => {
		const host = vi.fn(async (_qs: AskUserQuestionItem[], _ctx: any) => ({
			"Which library?": "date-fns",
			"Which features?": "Auth, Logging",
		}));
		const { run } = setup({ onAskUserQuestion: host });
		const questions = [q("Which library?"), q("Which features?", { multiSelect: true, header: "Features" })];
		const r = await run({ questions });
		expect(host).toHaveBeenCalledTimes(1);
		expect(host.mock.calls[0][0]).toEqual(questions);
		expect(host.mock.calls[0][1]).toMatchObject({ toolCallId: "call-1" });
		expect(resultText(r)).toBe(
			'User has answered your questions: "Which library?"="date-fns", "Which features?"="Auth, Logging". You can now continue with the user\'s answers in mind.',
		);
		expect(r.details).toEqual({
			questions,
			answers: { "Which library?": "date-fns", "Which features?": "Auth, Logging" },
			unanswered: [],
		});
	});

	it("marks missing answers as unanswered and joins array answers", async () => {
		const { run } = setup({ onAskUserQuestion: async () => ({ "Two?": ["X", "Y"] as any }) });
		const r = await run({ questions: [q("One?"), q("Two?", { multiSelect: true })] });
		expect(resultText(r)).toContain('"One?"=(unanswered), "Two?"="X, Y"');
		expect((r.details as any).unanswered).toEqual(["One?"]);
	});

	it("turns host errors into tool errors", async () => {
		const { run } = setup({
			onAskUserQuestion: async () => {
				throw new Error("dialog crashed");
			},
		});
		await expect(run({ questions: [q("One?")] })).rejects.toThrow(/dialog crashed/);
	});

	it("throws when aborted while waiting for the host", async () => {
		const ac = new AbortController();
		const { run } = setup({ onAskUserQuestion: () => new Promise(() => {}) });
		const p = run({ questions: [q("One?")] }, { signal: ac.signal });
		ac.abort();
		await expect(p).rejects.toThrow(/aborted/);
	});

	it("errors without a host callback or UI", async () => {
		const { run } = setup();
		await expect(run({ questions: [q("One?")] })).rejects.toThrow(/cannot be asked questions interactively.*best judgement/s);
	});

	it("falls back to ctx.ui.select when hasUI", async () => {
		const selectAnswers = ["B", "X", "Other (type your own answer)", "Done"];
		const select = vi.fn(async (_title: string, _choices: string[]) => selectAnswers.shift());
		const input = vi.fn(async () => "custom thing");
		const ctx = fakeCtx("/tmp", { hasUI: true, ui: { select, input } as any });
		const { run } = setup();
		const r = await run(
			{
				questions: [
					q("Single?"),
					q("Multi?", { multiSelect: true, options: [opt("X"), opt("Y"), opt("Z")] }),
				],
			},
			{ ctx },
		);
		expect(select.mock.calls[0][1]).toEqual(["A", "B", "Other (type your own answer)"]);
		// second multi-select round excludes the picked label and offers Done
		expect(select.mock.calls[2][1]).toEqual(["Y", "Z", "Other (type your own answer)", "Done"]);
		expect(input).toHaveBeenCalledTimes(1);
		expect((r.details as any).answers).toEqual({ "Single?": "B", "Multi?": "X, custom thing" });
	});

	it("UI dismissal leaves the question unanswered", async () => {
		const ctx = fakeCtx("/tmp", { hasUI: true, ui: { select: async () => undefined, input: async () => undefined } as any });
		const { run } = setup();
		const r = await run({ questions: [q("One?")] }, { ctx });
		expect(resultText(r)).toContain('"One?"=(unanswered)');
	});

	it("end-to-end through a session", async () => {
		const questions = [q("Pick?")];
		const t = await createTestSession({
			responses: [fauxAssistantMessage(fauxToolCall("AskUserQuestion", { questions }), { stopReason: "toolUse" }), fauxAssistantMessage("ok")],
			claudeCode: { onAskUserQuestion: async (qs) => ({ [qs[0].question]: "A" }), subagents: false },
		});
		await t.session.prompt("go");
		const r = t.toolResults()[0];
		expect(r).toMatchObject({ toolName: "AskUserQuestion", isError: false });
		expect(r.text).toContain('"Pick?"="A"');
		t.dispose();
	});

	it("end-to-end: missing callback is an error result for the model", async () => {
		const t = await createTestSession({
			responses: [fauxAssistantMessage(fauxToolCall("AskUserQuestion", { questions: [q("Pick?")] }), { stopReason: "toolUse" }), fauxAssistantMessage("ok")],
			claudeCode: { subagents: false },
		});
		await t.session.prompt("go");
		expect(t.toolResults()[0]).toMatchObject({ toolName: "AskUserQuestion", isError: true });
		expect(t.toolResults()[0].text).toMatch(/best judgement/);
		t.dispose();
	});
});

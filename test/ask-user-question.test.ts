import { describe, expect, it, vi } from "vitest";
import { formatAnswers, joinLabels, registerAskUserQuestion, SINGLE_OPTION_STEER } from "../src/tools/ask-user-question.js";
import { createCCContext } from "../src/shared/context.js";
import type { AskUserQuestionItem, ClaudeCodeToolsOptions } from "../src/shared/types.js";
import { captureTools, createTestSession, fakeCtx, fauxAssistantMessage, fauxToolCall, resultText } from "./helpers.js";

function setup(options: ClaudeCodeToolsOptions = {}) {
	const cc = createCCContext(options);
	const { tools } = captureTools((pi) => registerAskUserQuestion(pi, cc));
	const tool = tools.get("AskUserQuestion")!;
	const prepare = (params: any) => tool.prepareArguments!(params) as any;
	const run = (params: any, opts: { signal?: AbortSignal; ctx?: any } = {}) =>
		tool.execute("call-1", prepare(params), opts.signal, undefined, opts.ctx ?? fakeCtx("/tmp"));
	return { tool, run, prepare };
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
		expect(Object.keys(p.properties)).toEqual(["questions", "answers", "annotations", "metadata"]);
		expect(p.required).toEqual(["questions"]);
		expect(p.properties.questions.minItems).toBe(1);
		expect(p.properties.questions.maxItems).toBe(4);
		const item = p.properties.questions.items;
		expect(item.required).toEqual(["question", "header", "options", "multiSelect"]);
		expect(item.properties.options.minItems).toBe(2);
		expect(item.properties.options.maxItems).toBe(4);
		expect(Object.keys(item.properties.options.items.properties)).toEqual(["label", "description", "preview"]);
		expect(tool.description).toMatch(/^Use this tool only when you are blocked on a decision/);
	});

	it("reports a single-option question with Claude Code's steer and zod issue dump", () => {
		const { prepare } = setup();
		expect(() => prepare({ questions: [q("1?", { options: [opt("A")] })] })).toThrow(
			`InputValidationError: ${SINGLE_OPTION_STEER}\n\n${JSON.stringify(
				[{ origin: "array", code: "too_small", minimum: 2, inclusive: true, path: ["questions", 0, "options"], message: "Too small: expected array to have >=2 items" }],
				null,
				2,
			)}`,
		);
	});

	it.each([
		["no questions", { questions: [] }, /"code": "too_small"[\s\S]*expected array to have >=1 items/],
		["too many questions", { questions: [q("1?"), q("2?"), q("3?"), q("4?"), q("5?")] }, /expected array to have <=4 items/],
		["too many options", { questions: [q("1?", { options: ["A", "B", "C", "D", "E"].map(opt) })] }, /"path": \[\s*"questions",\s*0,\s*"options"/],
		["duplicate labels", { questions: [q("1?", { options: [opt("A"), opt("A")] })] }, /Question texts must be unique, option labels must be unique within each question/],
		["duplicate questions", { questions: [q("Same?"), q("Same?")] }, /Question texts must be unique/],
		["missing header", { questions: [{ question: "x?", multiSelect: false, options: [opt("A"), opt("B")] }] }, /^InputValidationError: AskUserQuestion failed due to the following issue:\nThe required parameter `questions\[0\]\.header` is missing$/],
		["unknown key", { questions: [q("1?")], extra: 1 }, /An unexpected parameter `extra` was provided/],
	])("rejects %s", (_name, params, re) => {
		const { prepare } = setup();
		expect(() => prepare(params)).toThrow(re);
	});

	it("accepts long headers, previews, a missing multiSelect and the optional fields", () => {
		const { prepare } = setup();
		const out = prepare({
			questions: [{ question: "1?", header: "A very long header", options: [{ ...opt("A"), preview: "x" }, opt("B")] }],
			answers: {},
			annotations: { "1?": { notes: "n" } },
			metadata: { source: "x" },
		});
		expect(out.questions[0].multiSelect).toBe(false);
	});

	it("end-to-end: validation errors reach the model with Claude Code's text", async () => {
		const host = vi.fn(async () => ({}));
		const t = await createTestSession({
			responses: [fauxAssistantMessage(fauxToolCall("AskUserQuestion", { questions: [q("Only?", { options: [opt("A")] })] }), { stopReason: "toolUse" }), fauxAssistantMessage("ok")],
			claudeCode: { onAskUserQuestion: host, subagents: false },
		});
		await t.session.prompt("go");
		expect(t.toolResults()[0]).toMatchObject({ toolName: "AskUserQuestion", isError: true });
		expect(t.toolResults()[0].text).toMatch(/^InputValidationError: This call included a question with fewer than 2 options/);
		expect(host).not.toHaveBeenCalled();
		t.dispose();
	});
});

describe("AskUserQuestion result text", () => {
	const qs = [q("Which library?"), q("Which features?", { multiSelect: true, options: [opt("Auth"), opt("Logging"), opt("a, b")] })];

	it("option answers", () => {
		expect(formatAnswers(qs, { "Which library?": "A", "Which features?": joinLabels(["Auth", "a, b"]) })).toBe(
			'Your questions have been answered: "Which library?"="A", "Which features?"="Auth, "a, b"". You can now continue with these answers in mind.',
		);
	});

	it("free-text answers and notes ask the model to read carefully", () => {
		expect(formatAnswers(qs, { "Which library?": "date-fns" })).toBe(
			'The user answered: "Which library?"="date-fns". Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.',
		);
		expect(formatAnswers(qs, { "Which library?": "A" }, { "Which library?": { preview: "P", notes: "careful" }, "Which features?": { notes: "none fit" } })).toBe(
			'The user answered: "Which library?"="A" selected preview:\nP notes: careful, "Which features?"=(no option selected) notes: none fit. Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.',
		);
	});

	it("no answers / a typed response", () => {
		expect(formatAnswers(qs, {})).toBe("The user did not answer the questions.");
		expect(formatAnswers(qs, { "Which library?": "A" }, undefined, "stop, use moment")).toBe("The user responded: stop, use moment");
	});
});

describe("AskUserQuestion execution", () => {
	it("passes questions to the host callback and formats answers", async () => {
		const host = vi.fn(async (_qs: AskUserQuestionItem[], _ctx: any) => ({ "Which library?": "A", "Which features?": "A, B" }));
		const { run } = setup({ onAskUserQuestion: host });
		const questions = [q("Which library?"), q("Which features?", { multiSelect: true, header: "Features" })];
		const r = await run({ questions });
		expect(host).toHaveBeenCalledTimes(1);
		expect(host.mock.calls[0][0]).toEqual(questions);
		expect(host.mock.calls[0][1]).toMatchObject({ toolCallId: "call-1" });
		expect(resultText(r)).toBe('Your questions have been answered: "Which library?"="A", "Which features?"="A, B". You can now continue with these answers in mind.');
		expect(r.details).toEqual({ questions, answers: { "Which library?": "A", "Which features?": "A, B" }, unanswered: [] });
	});

	it("leaves missing answers out, joins array answers and accepts the structured host result", async () => {
		const { run } = setup({ onAskUserQuestion: async () => ({ "Two?": ["A", "B"] as any }) });
		const r = await run({ questions: [q("One?"), q("Two?", { multiSelect: true })] });
		expect(resultText(r)).toBe('Your questions have been answered: "Two?"="A, B". You can now continue with these answers in mind.');
		expect((r.details as any).unanswered).toEqual(["One?"]);

		const { run: run2 } = setup({ onAskUserQuestion: async () => ({ answers: { "One?": "A" }, annotations: { "One?": { notes: "hmm" } } }) as any });
		const r2 = await run2({ questions: [q("One?")] });
		expect(resultText(r2)).toMatch(/^The user answered: "One\?"="A" notes: hmm\./);
		expect((r2.details as any).annotations).toEqual({ "One?": { notes: "hmm" } });
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
		const r = await run({ questions: [q("Single?"), q("Multi?", { multiSelect: true, options: [opt("X"), opt("Y"), opt("Z")] })] }, { ctx });
		expect(select.mock.calls[0][1]).toEqual(["A", "B", "Other (type your own answer)"]);
		// second multi-select round excludes the picked label and offers Done
		expect(select.mock.calls[2][1]).toEqual(["Y", "Z", "Other (type your own answer)", "Done"]);
		expect(input).toHaveBeenCalledTimes(1);
		expect((r.details as any).answers).toEqual({ "Single?": "B", "Multi?": "X, custom thing" });
		expect(resultText(r)).toMatch(/^The user answered:/);
	});

	it("UI dismissal leaves the question unanswered", async () => {
		const ctx = fakeCtx("/tmp", { hasUI: true, ui: { select: async () => undefined, input: async () => undefined } as any });
		const { run } = setup();
		const r = await run({ questions: [q("One?")] }, { ctx });
		expect(resultText(r)).toBe("The user did not answer the questions.");
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
		expect(r.text).toBe('Your questions have been answered: "Pick?"="A". You can now continue with these answers in mind.');
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

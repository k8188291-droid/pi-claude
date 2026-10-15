import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CCContext } from "../shared/context.js";
import { textResult } from "../shared/text.js";
import type { AskUserQuestionAnswers, AskUserQuestionItem } from "../shared/types.js";

export const ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";

export const ASK_USER_QUESTION_LIMITS = {
	minQuestions: 1,
	maxQuestions: 4,
	minOptions: 2,
	maxOptions: 4,
	maxHeaderChars: 12,
} as const;

export const ASK_USER_QUESTION_DESCRIPTION = `Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.

Usage notes:
- Users will always be able to select "Other" to provide custom text input
- Use multiSelect: true to allow multiple answers to be selected for a question
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label`;

const OptionSchema = Type.Object(
	{
		label: Type.String({
			description:
				"The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.",
		}),
		description: Type.String({
			description:
				"Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.",
		}),
	},
	{ additionalProperties: false },
);

const QuestionSchema = Type.Object(
	{
		question: Type.String({
			description:
				'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"',
		}),
		header: Type.String({
			description: 'Very short label displayed as a chip/tag (max 12 chars). Examples: "Auth method", "Library", "Approach".',
		}),
		options: Type.Array(OptionSchema, {
			minItems: ASK_USER_QUESTION_LIMITS.minOptions,
			maxItems: ASK_USER_QUESTION_LIMITS.maxOptions,
			description:
				"The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). There should be no 'Other' option, that will be provided automatically.",
		}),
		multiSelect: Type.Boolean({
			default: false,
			description:
				"Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.",
		}),
	},
	{ additionalProperties: false },
);

export const AskUserQuestionParams = Type.Object(
	{
		questions: Type.Array(QuestionSchema, {
			minItems: ASK_USER_QUESTION_LIMITS.minQuestions,
			maxItems: ASK_USER_QUESTION_LIMITS.maxQuestions,
			description: "Questions to ask the user (1-4 questions)",
		}),
		answers: Type.Optional(
			Type.Record(Type.String(), Type.String(), { description: "User answers collected by the permission component" }),
		),
		metadata: Type.Optional(
			Type.Object(
				{
					source: Type.Optional(
						Type.String({
							description: 'Optional identifier for the source of this question (e.g., "remember" for /remember command). Used for analytics tracking.',
						}),
					),
				},
				{ description: "Optional metadata for tracking and analytics purposes. Not displayed to user." },
			),
		),
	},
	{ additionalProperties: false },
);

export interface AskUserQuestionDetails {
	questions: AskUserQuestionItem[];
	/** Answers keyed by question text (only answered questions). */
	answers: AskUserQuestionAnswers;
	/** Question texts that received no answer. */
	unanswered: string[];
}

/** Validate and normalize raw `questions` input. Throws a model-facing Error on invalid input. */
export function validateQuestions(raw: unknown): AskUserQuestionItem[] {
	const L = ASK_USER_QUESTION_LIMITS;
	if (!Array.isArray(raw)) throw new Error("Invalid input: `questions` must be an array.");
	if (raw.length < L.minQuestions || raw.length > L.maxQuestions) {
		throw new Error(`Invalid input: \`questions\` must contain ${L.minQuestions}-${L.maxQuestions} questions (got ${raw.length}).`);
	}
	const seenQuestions = new Set<string>();
	return raw.map((q, i) => {
		if (!q || typeof q !== "object") throw new Error(`Invalid input: questions[${i}] must be an object.`);
		const { question, header, options, multiSelect } = q as Record<string, unknown>;
		if (typeof question !== "string" || question.trim() === "") {
			throw new Error(`Invalid input: questions[${i}].question must be a non-empty string.`);
		}
		if (seenQuestions.has(question)) {
			throw new Error(`Invalid input: question texts must be unique ("${question}" appears more than once).`);
		}
		seenQuestions.add(question);
		if (typeof header !== "string" || header.trim() === "") {
			throw new Error(`Invalid input: questions[${i}].header must be a non-empty string.`);
		}
		if ([...header].length > L.maxHeaderChars) {
			throw new Error(`Invalid input: questions[${i}].header "${header}" is too long (max ${L.maxHeaderChars} characters).`);
		}
		if (!Array.isArray(options) || options.length < L.minOptions || options.length > L.maxOptions) {
			throw new Error(
				`Invalid input: questions[${i}].options must contain ${L.minOptions}-${L.maxOptions} options (got ${Array.isArray(options) ? options.length : 0}).`,
			);
		}
		const seenLabels = new Set<string>();
		const normOptions = options.map((o, j) => {
			if (!o || typeof o !== "object") throw new Error(`Invalid input: questions[${i}].options[${j}] must be an object.`);
			const { label, description } = o as Record<string, unknown>;
			if (typeof label !== "string" || label.trim() === "") {
				throw new Error(`Invalid input: questions[${i}].options[${j}].label must be a non-empty string.`);
			}
			if (seenLabels.has(label)) {
				throw new Error(`Invalid input: option labels must be unique within a question ("${label}" appears more than once in questions[${i}]).`);
			}
			seenLabels.add(label);
			if (typeof description !== "string") {
				throw new Error(`Invalid input: questions[${i}].options[${j}].description must be a string.`);
			}
			return { label, description };
		});
		if (multiSelect !== undefined && typeof multiSelect !== "boolean") {
			throw new Error(`Invalid input: questions[${i}].multiSelect must be a boolean.`);
		}
		return { question, header, options: normOptions, multiSelect: multiSelect === true };
	});
}

function normalizeAnswer(v: unknown): string | undefined {
	if (v === undefined || v === null) return undefined;
	if (Array.isArray(v)) {
		const parts = v.filter((x) => x !== undefined && x !== null).map(String);
		return parts.length ? parts.join(", ") : undefined;
	}
	const s = typeof v === "string" ? v : String(v);
	return s.trim() === "" ? undefined : s;
}

/** Build the Claude Code-style result text. */
export function formatAnswers(questions: AskUserQuestionItem[], answers: AskUserQuestionAnswers): string {
	const parts = questions.map((q) =>
		q.question in answers ? `"${q.question}"="${answers[q.question]}"` : `"${q.question}"=(unanswered)`,
	);
	return `User has answered your questions: ${parts.join(", ")}. You can now continue with the user's answers in mind.`;
}

function abortError(): Error {
	return new Error("AskUserQuestion was aborted");
}

/** Resolve `p`, rejecting early when `signal` aborts. */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return p;
	if (signal.aborted) return Promise.reject(abortError());
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(abortError());
		signal.addEventListener("abort", onAbort, { once: true });
		p.then(
			(v) => {
				signal.removeEventListener("abort", onAbort);
				resolve(v);
			},
			(e) => {
				signal.removeEventListener("abort", onAbort);
				reject(e);
			},
		);
	});
}

const OTHER_LABEL = "Other (type your own answer)";
const DONE_LABEL = "Done";

/**
 * Fallback when no host callback is configured but pi has a UI: one `ctx.ui.select` per question
 * (option labels plus an "Other" entry that opens `ctx.ui.input`). For multiSelect questions the
 * select is shown repeatedly, removing already-picked labels and adding a "Done" entry, until the
 * user picks "Done", dismisses the dialog, or every option is picked. A dismissed dialog leaves
 * that question unanswered.
 */
async function askViaUI(questions: AskUserQuestionItem[], ctx: ExtensionContext, signal: AbortSignal | undefined): Promise<AskUserQuestionAnswers> {
	const answers: AskUserQuestionAnswers = {};
	const dialogOpts = signal ? { signal } : undefined;
	for (const q of questions) {
		if (signal?.aborted) throw abortError();
		const title = `${q.header}: ${q.question}`;
		const picked: string[] = [];
		while (true) {
			const remaining = q.options.map((o) => o.label).filter((l) => !picked.includes(l));
			const choices = [...remaining, OTHER_LABEL];
			if (q.multiSelect && picked.length > 0) choices.push(DONE_LABEL);
			const choice = await ctx.ui.select(q.multiSelect && picked.length ? `${title} (selected: ${picked.join(", ")})` : title, choices, dialogOpts);
			if (signal?.aborted) throw abortError();
			if (choice === undefined || choice === DONE_LABEL) break;
			if (choice === OTHER_LABEL) {
				const text = await ctx.ui.input(q.question, "Your answer", dialogOpts);
				if (signal?.aborted) throw abortError();
				if (text !== undefined && text.trim() !== "") picked.push(text.trim());
				if (!q.multiSelect) break;
				continue;
			}
			picked.push(choice);
			if (!q.multiSelect || picked.length >= q.options.length) break;
		}
		if (picked.length) answers[q.question] = picked.join(", ");
	}
	return answers;
}

export function registerAskUserQuestion(pi: ExtensionAPI, cc: CCContext): void {
	pi.registerTool({
		name: ASK_USER_QUESTION_TOOL_NAME,
		label: "AskUserQuestion",
		description: ASK_USER_QUESTION_DESCRIPTION,
		promptSnippet: "AskUserQuestion: ask the user 1-4 multiple-choice questions to clarify requirements or decisions",
		parameters: AskUserQuestionParams,
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const questions = validateQuestions((params as any)?.questions);
			if (signal?.aborted) throw abortError();

			let raw: unknown;
			const host = cc.options.onAskUserQuestion;
			if (host) {
				try {
					raw = await raceAbort(Promise.resolve().then(() => host(questions.map((q) => ({ ...q, options: q.options.map((o) => ({ ...o })) })), { signal, toolCallId })), signal);
				} catch (err) {
					if (signal?.aborted) throw abortError();
					const msg = err instanceof Error ? err.message : String(err);
					throw new Error(`Failed to ask the user: ${msg}`);
				}
			} else if (ctx?.hasUI) {
				raw = await askViaUI(questions, ctx, signal);
			} else {
				throw new Error(
					"The user cannot be asked questions interactively in this environment (no question handler is available). " +
						"Do not retry AskUserQuestion. Proceed using your best judgement, and clearly state any assumptions you make.",
				);
			}
			if (signal?.aborted) throw abortError();

			const rawMap = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
			const answers: AskUserQuestionAnswers = {};
			const unanswered: string[] = [];
			for (const q of questions) {
				const a = normalizeAnswer(Object.prototype.hasOwnProperty.call(rawMap, q.question) ? rawMap[q.question] : undefined);
				if (a === undefined) unanswered.push(q.question);
				else answers[q.question] = a;
			}
			return textResult<AskUserQuestionDetails>(formatAnswers(questions, answers), { questions, answers, unanswered });
		},
	});
}

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CCContext } from "../shared/context.js";
import { textResult } from "../shared/text.js";
import type { AskUserQuestionAnswers, AskUserQuestionItem } from "../shared/types.js";
import { claudeInputValidator, type Spec } from "./input-validation.js";

export const ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";

export const ASK_USER_QUESTION_LIMITS = {
	minQuestions: 1,
	maxQuestions: 4,
	minOptions: 2,
	maxOptions: 4,
} as const;

export const ASK_USER_QUESTION_DESCRIPTION = `Use this tool only when you are blocked on a decision that is genuinely the user's to make: one you cannot resolve from the request, the code, or sensible defaults.

Usage notes:
- Users will always be able to select "Other" to provide custom text input
- Use multiSelect: true to allow multiple answers to be selected for a question
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label

Plan mode note: To switch into plan mode, use EnterPlanMode (not this tool). Once in plan mode, use this tool to clarify requirements or choose between approaches BEFORE finalizing your plan. Do NOT use this tool to ask "Is my plan ready?", "Should I proceed?", or otherwise reference "the plan" in questions — the user cannot see the plan until you call ExitPlanMode for approval.
`;

const stringRecord = (description: string, value: unknown) => ({ description, type: "object", propertyNames: { type: "string" }, additionalProperties: value });

/** JSON schema exactly as Claude Code declares it. */
export const AskUserQuestionParams = {
	type: "object",
	properties: {
		questions: {
			description: "Questions to ask the user (1-4 questions)",
			minItems: ASK_USER_QUESTION_LIMITS.minQuestions,
			maxItems: ASK_USER_QUESTION_LIMITS.maxQuestions,
			type: "array",
			items: {
				type: "object",
				properties: {
					question: {
						description:
							'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"',
						type: "string",
					},
					header: {
						description: 'Very short label displayed as a chip/tag (max 12 chars). Examples: "Auth method", "Library", "Approach".',
						type: "string",
					},
					options: {
						description:
							"The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). There should be no 'Other' option, that will be provided automatically.",
						minItems: ASK_USER_QUESTION_LIMITS.minOptions,
						maxItems: ASK_USER_QUESTION_LIMITS.maxOptions,
						type: "array",
						items: {
							type: "object",
							properties: {
								label: {
									description:
										"The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.",
									type: "string",
								},
								description: {
									description:
										"Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.",
									type: "string",
								},
								preview: {
									description:
										"Optional preview content rendered when this option is focused. Use for mockups, code snippets, or visual comparisons that help users compare options. See the tool description for the expected content format.",
									type: "string",
								},
							},
							required: ["label", "description"],
							additionalProperties: false,
						},
					},
					multiSelect: {
						description: "Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.",
						default: false,
						type: "boolean",
					},
				},
				required: ["question", "header", "options", "multiSelect"],
				additionalProperties: false,
			},
		},
		answers: stringRecord("User answers collected by the permission component", { type: "string" }),
		annotations: stringRecord("Optional per-question annotations from the user (e.g., notes on preview selections). Keyed by question text.", {
			type: "object",
			properties: {
				preview: { description: "The preview content of the selected option, if the question used previews.", type: "string" },
				notes: { description: "Free-text notes the user added to their selection.", type: "string" },
			},
			additionalProperties: false,
		}),
		metadata: {
			description: "Optional metadata for tracking and analytics purposes. Not displayed to user.",
			type: "object",
			properties: {
				source: {
					description: 'Optional identifier for the source of this question (e.g., "remember" for /remember command). Used for analytics tracking.',
					type: "string",
				},
			},
			additionalProperties: false,
		},
	},
	required: ["questions"],
	additionalProperties: false,
};

const str: Spec = { kind: "string" };

/** Claude Code: question texts unique, option labels unique within a question. */
function uniqueTexts(input: { questions: AskUserQuestionItem[] }): boolean {
	const texts = input.questions.map((q) => q.question);
	if (new Set(texts).size !== texts.length) return false;
	return input.questions.every((q) => new Set(q.options.map((o) => o.label)).size === q.options.length);
}

const AskUserQuestionSpec: Spec = {
	kind: "object",
	props: {
		questions: {
			spec: {
				kind: "array",
				min: ASK_USER_QUESTION_LIMITS.minQuestions,
				max: ASK_USER_QUESTION_LIMITS.maxQuestions,
				items: {
					kind: "object",
					props: {
						question: { spec: str },
						header: { spec: str },
						options: {
							spec: {
								kind: "array",
								min: ASK_USER_QUESTION_LIMITS.minOptions,
								max: ASK_USER_QUESTION_LIMITS.maxOptions,
								items: { kind: "object", props: { label: { spec: str }, description: { spec: str }, preview: { spec: str, optional: true } } },
							},
						},
						multiSelect: { spec: { kind: "boolean", default: false } },
					},
				},
			},
		},
		answers: { spec: { kind: "record", value: str }, optional: true },
		annotations: { spec: { kind: "record", value: { kind: "object", props: { preview: { spec: str, optional: true }, notes: { spec: str, optional: true } } } }, optional: true },
		metadata: { spec: { kind: "object", props: { source: { spec: str, optional: true } } }, optional: true },
	},
	refine: { check: uniqueTexts, message: "Question texts must be unique, option labels must be unique within each question" },
};

export const SINGLE_OPTION_STEER =
	"This call included a question with fewer than 2 options, so it was rejected and the person never saw it. A question with a single option has no decision in it. Do not retry this call and do not invent a filler second option. Instead, state the one path you were going to offer as the approach you are taking, then continue with the task. If this call also contained questions with 2 to 4 options (each with distinct labels), you may re-ask those questions alone in a new call. Ask a question only when the person has at least two genuinely distinct choices.";

/** Claude Code's validationErrorSteer: a question with fewer than 2 options gets extra guidance. */
function singleOptionSteer(input: unknown): string | null {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
	const questions = (input as Record<string, unknown>).questions;
	if (!Array.isArray(questions)) return null;
	for (const q of questions) {
		if (typeof q !== "object" || q === null || Array.isArray(q)) continue;
		const options = (q as Record<string, unknown>).options;
		if (Array.isArray(options) && options.length < 2) return SINGLE_OPTION_STEER;
	}
	return null;
}

export interface AskUserQuestionAnnotation {
	preview?: string;
	notes?: string;
}

export interface AskUserQuestionInput {
	questions: AskUserQuestionItem[];
	answers?: Record<string, string>;
	annotations?: Record<string, AskUserQuestionAnnotation>;
	metadata?: { source?: string };
}

/**
 * What a host callback may return besides a plain answers map: `answers` (multiSelect: labels
 * joined with ", ", or an array of labels) plus optional per-question `annotations` (preview /
 * notes) and a free-text `response` the user typed instead of answering.
 */
export interface AskUserQuestionHostResult {
	answers?: Record<string, string | string[]>;
	annotations?: Record<string, AskUserQuestionAnnotation>;
	response?: string;
}

export interface AskUserQuestionDetails {
	questions: AskUserQuestionItem[];
	/** Answers keyed by question text (only answered questions). */
	answers: AskUserQuestionAnswers;
	annotations?: Record<string, AskUserQuestionAnnotation>;
	response?: string;
	/** Question texts that received no answer. */
	unanswered: string[];
}

/** Claude Code's sentinel answer for "the user only added notes". */
const NOTES_ONLY = "(notes only)";

const own = <T>(obj: Record<string, T> | undefined, key: string): T | undefined => (obj && Object.hasOwn(obj, key) ? obj[key] : undefined);

/** Join multiSelect labels the way Claude Code's UI does (labels with ", " or quotes are JSON-quoted). */
export function joinLabels(labels: string[]): string {
	return labels.map((l) => (l.includes(", ") || l.includes('"') ? JSON.stringify(l) : l)).join(", ");
}

/** Split a joined multiSelect answer (inverse of joinLabels); null when it is not such a list. */
function splitLabels(answer: string): string[] | null {
	const out: string[] = [];
	let rest = answer;
	for (;;) {
		if (rest.startsWith('"')) {
			let end = -1;
			let escaped = false;
			for (let i = 1; i < rest.length; i++) {
				const ch = rest[i];
				if (escaped) {
					escaped = false;
					continue;
				}
				if (ch === "\\") {
					escaped = true;
					continue;
				}
				if (ch === '"') {
					end = i;
					break;
				}
			}
			if (end === -1) return null;
			try {
				const v = JSON.parse(rest.slice(0, end + 1));
				if (typeof v !== "string") return null;
				out.push(v);
			} catch {
				return null;
			}
			rest = rest.slice(end + 1);
		} else {
			const i = rest.indexOf(", ");
			const part = i === -1 ? rest : rest.slice(0, i);
			if (part.includes('"')) return null;
			out.push(part);
			rest = i === -1 ? "" : rest.slice(i);
		}
		if (rest === "") break;
		if (!rest.startsWith(", ")) return null;
		rest = rest.slice(2);
		if (rest === "") return null;
	}
	return out;
}

/** Build Claude Code's result text. */
export function formatAnswers(
	questions: AskUserQuestionItem[],
	answers: Record<string, string | string[]>,
	annotations?: Record<string, AskUserQuestionAnnotation>,
	response?: string,
): string {
	const parts = questions
		.map(({ question }) => {
			const answer = own(answers, question);
			const note = own(annotations, question);
			const answered = !!answer && answer !== NOTES_ONLY && !(Array.isArray(answer) && answer.length === 0);
			if (!answered && !note?.notes) return null;
			const p = [answered ? `"${question}"="${answer}"` : `"${question}"=(no option selected)`];
			if (note?.preview) p.push(`selected preview:\n${note.preview}`);
			if (note?.notes) p.push(`notes: ${note.notes}`);
			return p.join(" ");
		})
		.filter((p): p is string => p !== null)
		.join(", ");
	if (response?.trim()) return `The user responded: ${response}`;
	if (!parts) return "The user did not answer the questions.";
	const allOptionLabels = questions.every(({ question, options, multiSelect }) => {
		if (own(annotations, question)?.notes) return false;
		const answer = own(answers, question);
		const labels = new Set(options.map((o) => o.label));
		if (Array.isArray(answer)) return multiSelect && answer.length > 0 && answer.every((a) => labels.has(a));
		if (!answer || answer === NOTES_ONLY) return true;
		if (labels.has(answer)) return true;
		if (!multiSelect) return false;
		const split = splitLabels(answer);
		return split !== null && split.length >= 1 && joinLabels(split) === answer && split.every((a) => labels.has(a));
	});
	return allOptionLabels
		? `Your questions have been answered: ${parts}. You can now continue with these answers in mind.`
		: `The user answered: ${parts}. Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.`;
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
async function askViaUI(questions: AskUserQuestionItem[], ctx: ExtensionContext, signal: AbortSignal | undefined): Promise<Record<string, string | string[]>> {
	// null prototype: a question may be any string, "__proto__" included (#28)
	const answers: Record<string, string | string[]> = Object.create(null);
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
		if (picked.length) answers[q.question] = q.multiSelect ? picked : picked[0];
	}
	return answers;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Normalize what the host returned into string answers (multiSelect arrays joined) plus extras. */
function normalizeHostResult(
	questions: AskUserQuestionItem[],
	raw: unknown,
): { answers: Record<string, string>; annotations?: Record<string, AskUserQuestionAnnotation>; response?: string } {
	let answersIn: Record<string, unknown> = {};
	let annotations: Record<string, AskUserQuestionAnnotation> | undefined;
	let response: string | undefined;
	if (isPlainObject(raw)) {
		// structured form: { answers: {...}, annotations?, response? } (an answer is never an object)
		if (isPlainObject(raw.answers) || isPlainObject(raw.annotations)) {
			answersIn = isPlainObject(raw.answers) ? raw.answers : {};
			if (isPlainObject(raw.annotations)) annotations = raw.annotations as Record<string, AskUserQuestionAnnotation>;
			if (typeof raw.response === "string") response = raw.response;
		} else answersIn = raw;
	}
	// null prototype: a question may be any string, "__proto__" included (#28)
	const answers: Record<string, string> = Object.create(null);
	for (const q of questions) {
		const v = own(answersIn, q.question);
		if (Array.isArray(v)) {
			const labels = v.filter((x) => x !== undefined && x !== null).map(String);
			if (labels.length) answers[q.question] = joinLabels(labels);
		} else if (v !== undefined && v !== null && String(v) !== "") answers[q.question] = String(v);
	}
	return { answers, annotations, response };
}

export function registerAskUserQuestion(pi: ExtensionAPI, cc: CCContext): void {
	pi.registerTool({
		name: ASK_USER_QUESTION_TOOL_NAME,
		label: "AskUserQuestion",
		description: ASK_USER_QUESTION_DESCRIPTION,
		promptSnippet: "AskUserQuestion: ask the user 1-4 multiple-choice questions to clarify requirements or decisions",
		parameters: AskUserQuestionParams as any,
		prepareArguments: claudeInputValidator<AskUserQuestionInput>(ASK_USER_QUESTION_TOOL_NAME, AskUserQuestionSpec, { steer: singleOptionSteer }),
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const { questions } = params as AskUserQuestionInput;
			if (signal?.aborted) throw abortError();

			let raw: unknown;
			const host = cc.options.onAskUserQuestion;
			if (host) {
				try {
					const copy = questions.map((q) => ({ ...q, options: q.options.map((o) => ({ ...o })) }));
					raw = await raceAbort(Promise.resolve().then(() => host(copy, { signal, toolCallId })), signal);
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

			const { answers, annotations, response } = normalizeHostResult(questions, raw);
			const unanswered = questions.filter((q) => !Object.hasOwn(answers, q.question)).map((q) => q.question);
			const details: AskUserQuestionDetails = { questions, answers, unanswered };
			if (annotations) details.annotations = annotations;
			if (response?.trim()) details.response = response;
			return textResult<AskUserQuestionDetails>(formatAnswers(questions, answers, annotations, response), details);
		},
	});
}

/**
 * Claude Code-compatible tool input validation.
 *
 * Claude Code validates tool input with zod (v4) and reports failures as
 * `InputValidationError: <text>`, where <text> is either a readable summary
 * ("<Tool> failed due to the following issue:\nThe required parameter `x` is missing") or, when every
 * issue is of a kind the summary does not describe (too_small, invalid_value, ...), zod's own
 * JSON dump of the issues. pi validates tool arguments with its own (TypeBox) validator before a
 * tool runs, with different wording, so tools that want Claude's exact errors validate in
 * `prepareArguments` with this module and throw (pi turns the throw into an error tool result).
 *
 * Only the subset of zod used by these tools' schemas is modelled.
 */

export type Spec =
	| { kind: "string" }
	| { kind: "boolean"; default?: boolean }
	| { kind: "enum"; values: readonly string[] }
	| { kind: "literal"; value: string }
	| { kind: "union"; options: Spec[] }
	| { kind: "array"; items: Spec; min?: number; max?: number }
	| { kind: "object"; props: Record<string, { spec: Spec; optional?: boolean }>; strict?: boolean; refine?: { check: (v: any) => boolean; message: string } }
	/** z.record(z.string(), valueSpec) */
	| { kind: "record"; value: Spec }
	| { kind: "unknown" };

export type Path = Array<string | number>;
export type ZodIssue = Record<string, unknown> & { code: string; path: Path; message: string };

/** zod v4's name for a value's type (used in "received X"). */
function parsedType(v: unknown): string {
	if (v === undefined) return "undefined";
	if (v === null) return "null";
	if (Array.isArray(v)) return "array";
	if (typeof v === "number") return Number.isNaN(v) ? "nan" : "number";
	return typeof v;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function quote(v: string): string {
	return JSON.stringify(v);
}

function invalidType(expected: string, value: unknown, path: Path): ZodIssue {
	return { expected, code: "invalid_type", path, message: `Invalid input: expected ${expected}, received ${parsedType(value)}` };
}

/** zod v4 length checks also run on strings (with "characters" wording) when the type check failed. */
function lengthIssues(spec: { min?: number; max?: number }, value: unknown, path: Path): ZodIssue[] {
	const out: ZodIssue[] = [];
	let origin: string;
	let unit: string;
	if (Array.isArray(value)) {
		origin = "array";
		unit = "items";
	} else if (typeof value === "string") {
		origin = "string";
		unit = "characters";
	} else return out;
	const len = value.length;
	if (spec.min !== undefined && len < spec.min) {
		out.push({ origin, code: "too_small", minimum: spec.min, inclusive: true, path, message: `Too small: expected ${origin} to have >=${spec.min} ${unit}` });
	}
	if (spec.max !== undefined && len > spec.max) {
		out.push({ origin, code: "too_big", maximum: spec.max, inclusive: true, path, message: `Too big: expected ${origin} to have <=${spec.max} ${unit}` });
	}
	return out;
}

/** Parse `value` against `spec`: returns the parsed value (defaults applied) and zod-style issues. */
export function parse(spec: Spec, value: unknown, path: Path = []): { value: unknown; issues: ZodIssue[] } {
	switch (spec.kind) {
		case "unknown":
			return { value, issues: [] };
		case "string":
			return typeof value === "string" ? { value, issues: [] } : { value, issues: [invalidType("string", value, path)] };
		case "boolean":
			if (value === undefined && spec.default !== undefined) return { value: spec.default, issues: [] };
			return typeof value === "boolean" ? { value, issues: [] } : { value, issues: [invalidType("boolean", value, path)] };
		case "enum":
			if (typeof value === "string" && spec.values.includes(value)) return { value, issues: [] };
			return {
				value,
				issues: [{ code: "invalid_value", values: [...spec.values], path, message: `Invalid option: expected one of ${spec.values.map(quote).join("|")}` }],
			};
		case "literal":
			if (value === spec.value) return { value, issues: [] };
			return { value, issues: [{ code: "invalid_value", values: [spec.value], path, message: `Invalid input: expected ${quote(spec.value)}` }] };
		case "union": {
			const errors: ZodIssue[][] = [];
			for (const option of spec.options) {
				const r = parse(option, value, []);
				if (r.issues.length === 0) return r;
				errors.push(r.issues);
			}
			return { value, issues: [{ code: "invalid_union", errors, path, message: "Invalid input" }] };
		}
		case "array": {
			const issues: ZodIssue[] = [];
			let out: unknown = value;
			if (!Array.isArray(value)) issues.push(invalidType("array", value, path));
			else {
				const items: unknown[] = [];
				value.forEach((item, i) => {
					const r = parse(spec.items, item, [...path, i]);
					issues.push(...r.issues);
					items.push(r.value);
				});
				out = items;
			}
			issues.push(...lengthIssues(spec, value, path));
			return { value: out, issues };
		}
		case "record": {
			if (!isPlainObject(value)) return { value, issues: [invalidType("record", value, path)] };
			const issues: ZodIssue[] = [];
			const out: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(value)) {
				const r = parse(spec.value, v, [...path, k]);
				issues.push(...r.issues);
				out[k] = r.value;
			}
			return { value: out, issues };
		}
		case "object": {
			if (!isPlainObject(value)) return { value, issues: [invalidType("object", value, path)] };
			const issues: ZodIssue[] = [];
			const out: Record<string, unknown> = {};
			for (const [key, { spec: propSpec, optional }] of Object.entries(spec.props)) {
				const v = value[key];
				if (v === undefined && optional) continue;
				const r = parse(propSpec, v, [...path, key]);
				issues.push(...r.issues);
				if (r.value !== undefined) out[key] = r.value;
			}
			const unknownKeys = Object.keys(value).filter((k) => !(k in spec.props));
			if (unknownKeys.length > 0) {
				if (spec.strict !== false) {
					issues.push({
						code: "unrecognized_keys",
						keys: unknownKeys,
						path,
						message: `Unrecognized key${unknownKeys.length > 1 ? "s" : ""}: ${unknownKeys.map(quote).join(", ")}`,
					});
				}
			}
			if (issues.length === 0 && spec.refine && !spec.refine.check(out)) {
				issues.push({ code: "custom", path, message: spec.refine.message });
			}
			return { value: out, issues };
		}
	}
}

/** `a.b[0].c` (Claude Code's rendering of an issue path). */
function formatPath(path: Path): string {
	return path.reduce<string>((acc, part, i) => (typeof part === "number" ? `${acc}[${part}]` : i === 0 ? String(part) : `${acc}.${part}`), "");
}

const MAX_LISTED_ISSUES = 20;
const MAX_ISSUE_MESSAGE = 500;

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Claude Code's text for a failed schema validation (without the "InputValidationError: " prefix). */
export function formatIssues(toolName: string, issues: ZodIssue[]): string {
	const missing = issues.filter((i) => i.code === "invalid_type" && i.message.includes("received undefined")).map((i) => formatPath(i.path));
	const unexpected = issues.filter((i) => i.code === "unrecognized_keys").flatMap((i) => (i.keys as string[]).map((k) => formatPath([...i.path, k])));
	const wrongType = issues
		.filter((i) => i.code === "invalid_type" && !i.message.includes("received undefined"))
		.map((i) => ({ param: formatPath(i.path), expected: i.expected as string, received: i.message.match(/received (\w+)/)?.[1] ?? "unknown" }));
	const other = issues
		.filter((i) => i.code !== "invalid_type" && i.code !== "unrecognized_keys")
		.map((i) => {
			const p = formatPath(i.path);
			const subject = p === "" ? "The input" : `The parameter \`${p}\``;
			const msg = truncate(i.message.replace(/^Invalid input(?:: |$)/, ""), MAX_ISSUE_MESSAGE);
			if (msg !== "") return `${subject} is invalid: ${msg}`;
			return i.code === "invalid_union" ? `${subject} matches none of the accepted forms` : `${subject} is invalid`;
		});
	const lines: string[] = [
		...missing.map((p) => `The required parameter \`${p}\` is missing`),
		...unexpected.map((p) => `An unexpected parameter \`${p}\` was provided`),
		...wrongType.map(({ param, expected, received }) => `The parameter \`${param}\` type is expected as \`${expected}\` but provided as \`${received}\``),
	];
	if (lines.length === 0) return JSON.stringify(issues, null, 2);
	lines.push(...other.slice(0, MAX_LISTED_ISSUES));
	const more = other.length - MAX_LISTED_ISSUES;
	if (more > 0) lines.push(`(${more} more ${more === 1 ? "issue" : "issues"} not listed)`);
	return `${toolName} failed due to the following ${lines.length > 1 ? "issues" : "issue"}:\n${lines.join("\n")}`;
}

export class InputValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InputValidationError";
	}
}

export interface ValidateOptions {
	/** Claude Code's `coerceInput`: repairs common input shapes before validation (null = unchanged). */
	coerce?: (input: unknown) => unknown | null;
	/** Claude Code's `validationErrorSteer`: extra guidance put before the issue text. Gets the raw input. */
	steer?: (input: unknown, issues: ZodIssue[]) => string | null;
}

/**
 * Validate raw tool arguments like Claude Code does. Returns the parsed input, or throws an
 * InputValidationError whose message is Claude Code's model-facing text.
 */
export function validateInput<T>(toolName: string, spec: Spec, raw: unknown, opts: ValidateOptions = {}): T {
	const coerced = opts.coerce?.(raw) ?? null;
	const input = coerced === null ? raw : coerced;
	const { value, issues } = parse(spec, input);
	if (issues.length === 0) return value as T;
	let text = formatIssues(toolName, issues);
	const steer = opts.steer?.(raw, issues);
	if (steer) text = `${steer}\n\n${text}`;
	throw new InputValidationError(`InputValidationError: ${text}`);
}

/** prepareArguments implementation for pi tools: validate like Claude Code, pass the parsed input on. */
export function claudeInputValidator<T>(toolName: string, spec: Spec, opts: ValidateOptions = {}): (args: unknown) => T {
	return (args) => validateInput<T>(toolName, spec, args, opts);
}

import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

/** Model aliases accepted by the Agent tool's `model` parameter (Claude Code's enum). */
export const MODEL_ALIASES = ["sonnet", "opus", "haiku", "fable"] as const;

export function isModelAlias(s: string): boolean {
	return (MODEL_ALIASES as readonly string[]).includes(s.toLowerCase());
}

function safe<T>(fn: () => T, fallback: T): T {
	try {
		return fn();
	} catch {
		return fallback;
	}
}

function hasAuth(registry: ModelRegistry, m: Model<any>): boolean {
	return safe(() => registry.hasConfiguredAuth(m), false);
}

/** Prefer: same provider as parent, then configured auth, then undated ids, then highest (latest-looking) id. */
function pickBest(candidates: Model<any>[], registry: ModelRegistry, parent: Model<any> | undefined): Model<any> | undefined {
	if (candidates.length === 0) return undefined;
	const score = (m: Model<any>) => (parent && m.provider === parent.provider ? 2 : 0) + (hasAuth(registry, m) ? 1 : 0);
	const dated = (m: Model<any>) => (/\d{8}/.test(m.id) ? 1 : 0); // prefer undated aliases like "claude-haiku-4-5"
	return [...candidates].sort((a, b) => score(b) - score(a) || dated(a) - dated(b) || b.id.localeCompare(a.id))[0];
}

export type ModelResolution =
	| { ok: true; model: Model<any> | undefined; note?: string }
	| { ok: false; error: string };

/**
 * Resolve a model spec for a subagent.
 * - undefined / "inherit" → parent model
 * - a pi Model object → used as-is
 * - "sonnet" | "opus" | "haiku" | "fable" → best available registry model whose id contains the alias
 *   (preferring the parent's provider); falls back to the parent model when none is found
 * - "provider/model-id" or bare "model-id" → registry lookup (exact id match; the parent model
 *   itself also matches). Unknown ids → error (strict) or parent model with a note (non-strict).
 */
export function resolveSubagentModel(
	spec: Model<any> | string | undefined,
	registry: ModelRegistry | undefined,
	parent: Model<any> | undefined,
	opts: { strict: boolean },
): ModelResolution {
	if (spec === undefined) return { ok: true, model: parent };
	if (typeof spec !== "string") return { ok: true, model: spec };
	const s = spec.trim();
	if (!s || s === "inherit") return { ok: true, model: parent };

	if (parent && (s === parent.id || s === `${parent.provider}/${parent.id}`)) return { ok: true, model: parent };

	const all: Model<any>[] = registry ? safe(() => registry.getAll(), [] as Model<any>[]) : [];

	if (isModelAlias(s)) {
		const alias = s.toLowerCase();
		if (parent && parent.id.toLowerCase().includes(alias)) return { ok: true, model: parent };
		const best = pickBest(
			all.filter((m) => m.id.toLowerCase().includes(alias) && hasAuth(registry!, m)),
			registry!,
			parent,
		);
		if (best) return { ok: true, model: best };
		return { ok: true, model: parent, note: `No available model matches alias "${s}"; using the parent model.` };
	}

	let found: Model<any> | undefined;
	const slash = s.indexOf("/");
	if (slash > 0 && registry) {
		found = safe(() => registry.find(s.slice(0, slash), s.slice(slash + 1)), undefined);
	}
	if (!found) found = pickBest(all.filter((m) => m.id === s), registry!, parent);
	if (found) return { ok: true, model: found };

	if (opts.strict) {
		return { ok: false, error: `Unknown model "${s}". Use "sonnet", "opus", "haiku", "fable", a model id, or "provider/model-id", or omit the model parameter to inherit the parent model.` };
	}
	return { ok: true, model: parent, note: `Unknown model "${s}"; using the parent model.` };
}

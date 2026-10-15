import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Returns a view of `pi` whose registerTool() registers the named tools with pi's native
 * `exposure: "deferred"`: they are not declared to the model until pi's built-in `tool_search`
 * finds and activates them.
 */
export function withDeferredExposure(pi: ExtensionAPI, deferred: ReadonlySet<string>): ExtensionAPI {
	if (deferred.size === 0) return pi;
	return new Proxy(pi, {
		get(target, prop, receiver) {
			if (prop === "registerTool") {
				return (def: Parameters<ExtensionAPI["registerTool"]>[0]) =>
					target.registerTool(deferred.has(def.name) ? { ...def, exposure: "deferred" } : def);
			}
			const value = Reflect.get(target, prop, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/**
 * Activates pi's built-in `tool_search` (registered inactive by createToolSearchExtension())
 * whenever any registered tool — ours, the host's, or an MCP server's — has deferred exposure.
 */
export function registerToolSearchActivation(pi: ExtensionAPI): void {
	const ensure = () => {
		const all = pi.getAllTools();
		if (!all.some((t) => t.name === "tool_search")) return;
		if (!all.some((t) => t.exposure === "deferred")) return;
		const active = pi.getActiveTools();
		if (!active.includes("tool_search")) pi.setActiveTools([...active, "tool_search"]);
	};
	pi.on("session_start", ensure);
	pi.on("before_agent_start", ensure);
}

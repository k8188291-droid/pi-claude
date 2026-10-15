import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

export function textResult<T = Record<string, unknown>>(text: string, details?: T): AgentToolResult<T> {
	return { content: [{ type: "text", text }], details: (details ?? {}) as T };
}

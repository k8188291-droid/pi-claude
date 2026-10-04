import type { AgentToolResult } from "@mariozechner/pi-coding-agent";

export function textResult<T = Record<string, unknown>>(text: string, details?: T): AgentToolResult<T> {
	return { content: [{ type: "text", text }], details: (details ?? {}) as T };
}

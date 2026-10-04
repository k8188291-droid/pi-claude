import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export const REMINDER_CUSTOM_TYPE = "cc-system-reminder";

export function wrapReminder(text: string): string {
	return `<system-reminder>\n${text}\n</system-reminder>`;
}

/**
 * Inject a <system-reminder> message into the conversation.
 * - wake=false: delivered with the next LLM call (steer) or next user prompt if idle.
 * - wake=true: if the agent is idle, triggers a new turn (e.g. background task finished).
 */
export function sendReminder(pi: ExtensionAPI, text: string, opts: { wake?: boolean; details?: unknown } = {}): void {
	pi.sendMessage(
		{ customType: REMINDER_CUSTOM_TYPE, content: wrapReminder(text), display: false, details: opts.details },
		opts.wake ? { deliverAs: "followUp", triggerTurn: true } : { deliverAs: "nextTurn" },
	);
}

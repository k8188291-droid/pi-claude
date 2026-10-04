import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export const REMINDER_CUSTOM_TYPE = "cc-system-reminder";

export function wrapReminder(text: string): string {
	return `<system-reminder>\n${text}\n</system-reminder>`;
}

/**
 * Inject a <system-reminder> message into the conversation.
 * - wake=false: while streaming, steered in before the next LLM call; while idle, appended to the
 *   session immediately (seen with the next prompt). Never starts a turn.
 * - wake=true: while streaming, delivered as a follow-up; while idle, starts a new turn
 *   (e.g. a background task finished).
 */
export function sendReminder(pi: ExtensionAPI, text: string, opts: { wake?: boolean; details?: unknown } = {}): void {
	pi.sendMessage(
		{ customType: REMINDER_CUSTOM_TYPE, content: wrapReminder(text), display: false, details: opts.details },
		opts.wake ? { deliverAs: "followUp", triggerTurn: true } : { deliverAs: "steer" },
	);
}

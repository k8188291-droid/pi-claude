import { randomBytes } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLocalHost } from "../host/local.js";
import type { ClaudeCodeHost } from "../host/types.js";
import { BackgroundTaskRegistry } from "./background.js";
import { FileStateTracker } from "./file-state.js";
import { NotificationQueue } from "./notifications.js";
import type { ClaudeCodeHostEvent, ClaudeCodeToolsOptions } from "./types.js";

/** Per-session shared state handed to every module's register function. */
export interface CCContext {
	options: ClaudeCodeToolsOptions;
	/** Filesystem, shell and search every tool goes through (`options.host`, else the local machine). */
	host: ClaudeCodeHost;
	fileState: FileStateTracker;
	/** Background bash commands and agents (TaskStop, notifications). */
	tasks: BackgroundTaskRegistry;
	/** Background-task notifications: attached to the next tool result, or start a turn when idle. */
	notifications: Pick<NotificationQueue, "enqueue" | "discard">;
	emit(event: ClaudeCodeHostEvent): void;
	/** The session's task list (set by the task tools; passed to subagents). */
	taskStore?: import("../tools/task-tools.js").TaskStore;
}

/** `pi` is needed for notifications; unit tests may omit it (notifications are then dropped). */
export function createCCContext(options: ClaudeCodeToolsOptions, pi?: ExtensionAPI): CCContext {
	const sessionKey = randomBytes(8).toString("hex");
	const host = options.host ?? createLocalHost();
	return {
		options,
		host,
		fileState: new FileStateTracker(host.fs),
		tasks: new BackgroundTaskRegistry(() => sessionKey, host),
		notifications: pi ? new NotificationQueue(pi) : { enqueue() {}, discard() {} },
		emit(event) {
			try {
				// `onEvent` is typed `=> void`, but an async callback still type-checks: swallow its
				// rejection too, or a failing host handler becomes an unhandled rejection (#21).
				const result: unknown = options.onEvent?.(event);
				if (result !== null && typeof result === "object" && typeof (result as PromiseLike<unknown>).then === "function") {
					Promise.resolve(result as PromiseLike<unknown>).then(undefined, () => {});
				}
			} catch {
				// host errors must never break the agent loop
			}
		},
	};
}

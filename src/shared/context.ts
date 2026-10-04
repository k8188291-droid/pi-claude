import type { ClaudeCodeHostEvent, ClaudeCodeToolsOptions } from "./types.js";
import { FileStateTracker } from "./file-state.js";

/** Per-session shared state handed to every module's register function. */
export interface CCContext {
	options: ClaudeCodeToolsOptions;
	fileState: FileStateTracker;
	emit(event: ClaudeCodeHostEvent): void;
}

export function createCCContext(options: ClaudeCodeToolsOptions): CCContext {
	return {
		options,
		fileState: new FileStateTracker(),
		emit(event) {
			try {
				options.onEvent?.(event);
			} catch {
				// host errors must never break the agent loop
			}
		},
	};
}

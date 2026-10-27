import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createCCContext } from "./shared/context.js";
import type { ClaudeCodeToolsOptions } from "./shared/types.js";
import { registerOutputSpill } from "./output-spill.js";
import { registerRead } from "./tools/read.js";
import { registerWrite } from "./tools/write.js";
import { registerEdit } from "./tools/edit.js";
import { registerGrep } from "./tools/grep.js";
import { registerGlob } from "./tools/glob.js";
import { registerBash } from "./tools/bash.js";
import { registerTaskTools } from "./tools/task-tools.js";
import { registerNotebookEdit } from "./tools/notebook-edit.js";
import { registerTaskStop } from "./tools/task-stop.js";
import { registerAskUserQuestion } from "./tools/ask-user-question.js";
import { registerToolSearchActivation, withDeferredExposure } from "./deferred-tools.js";
import { registerTask, registerUnknownToolErrors } from "./subagent/index.js";

export * from "./shared/types.js";
export type * from "./host/types.js";
export { QUIRKS, type Quirk, type QuirkMode } from "./shared/quirks.js";
export { createClaudeCodeSession, type CreateClaudeCodeSessionOptions } from "./sdk.js";

/**
 * Build a pi extension factory that installs Claude Code-compatible tools.
 * Pair with `createAgentSession({ noTools: "builtin" })` so pi's own read/bash/edit/write are disabled,
 * and add pi's `createToolSearchExtension()` if you use `deferredTools`.
 */
export function createClaudeCodeExtension(options: ClaudeCodeToolsOptions = {}): ExtensionFactory {
	return (realPi: ExtensionAPI) => {
		const cc = createCCContext(options, realPi);
		const pi = withDeferredExposure(realPi, new Set(options.deferredTools ?? []));
		registerRead(pi, cc);
		registerWrite(pi, cc);
		registerEdit(pi, cc);
		registerGrep(pi, cc);
		registerGlob(pi, cc);
		registerBash(pi, cc);
		registerNotebookEdit(pi, cc);
		registerTaskTools(pi, cc);
		registerTaskStop(pi, cc);
		if (!options.isSubagent) registerAskUserQuestion(pi, cc);
		if (!options.isSubagent && options.subagents !== false) registerTask(pi, cc);
		// Claude Code wording for calls to tools that are not available
		if (!options.isSubagent) registerUnknownToolErrors(realPi);
		registerToolSearchActivation(realPi);
		if (options.outputSpill !== false) registerOutputSpill(pi, cc);
		// after spill, so notifications are never spilled into a file
		(cc.notifications as { attachToToolResults?: () => void }).attachToToolResults?.();
	};
}

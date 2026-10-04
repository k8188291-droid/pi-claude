import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { createCCContext } from "./shared/context.js";
import type { ClaudeCodeToolsOptions } from "./shared/types.js";
import { registerOutputSpill } from "./output-spill.js";
import { registerRead } from "./tools/read.js";
import { registerWrite } from "./tools/write.js";
import { registerEdit } from "./tools/edit.js";
import { registerGrep } from "./tools/grep.js";
import { registerGlob } from "./tools/glob.js";
import { registerBash } from "./tools/bash.js";
import { registerTodoWrite } from "./tools/todo-write.js";
import { registerAskUserQuestion } from "./tools/ask-user-question.js";
import { registerToolSearch } from "./tools/tool-search.js";
import { registerTask } from "./subagent/index.js";

export * from "./shared/types.js";
export { createClaudeCodeSession, type CreateClaudeCodeSessionOptions } from "./sdk.js";

/**
 * Build a pi extension factory that installs Claude Code-compatible tools.
 * Pair with `createAgentSession({ noTools: "builtin" })` so pi's own read/bash/edit/write are disabled.
 */
export function createClaudeCodeExtension(options: ClaudeCodeToolsOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		const cc = createCCContext(options);
		registerRead(pi, cc);
		registerWrite(pi, cc);
		registerEdit(pi, cc);
		registerGrep(pi, cc);
		registerGlob(pi, cc);
		registerBash(pi, cc);
		registerTodoWrite(pi, cc);
		if (!options.isSubagent) registerAskUserQuestion(pi, cc);
		if (!options.isSubagent && options.subagents !== false) registerTask(pi, cc);
		// must run after all tools are registered
		registerToolSearch(pi, cc);
		if (options.outputSpill !== false) registerOutputSpill(pi, cc);
	};
}

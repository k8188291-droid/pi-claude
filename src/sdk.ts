import {
	createAgentSession,
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	createToolSearchExtension,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { createClaudeCodeExtension } from "./index.js";
import type { ClaudeCodeToolsOptions } from "./shared/types.js";

type LoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];

export interface CreateClaudeCodeSessionOptions extends Omit<CreateAgentSessionOptions, "resourceLoader" | "noTools"> {
	/** Options for the Claude Code tools. */
	claudeCode?: ClaudeCodeToolsOptions;
	/** Install pi's built-in `tool_search` extension (activated when deferred tools exist). Default true. */
	toolSearch?: boolean;
	/** Extra DefaultResourceLoader options (extensionFactories are appended after ours). */
	loader?: Partial<Omit<LoaderOptions, "cwd" | "agentDir">>;
}

/**
 * Convenience wrapper: createAgentSession with pi's built-in tools disabled, the Claude Code tool
 * extension installed, and pi's tool_search extension for deferred tools.
 */
export async function createClaudeCodeSession(opts: CreateClaudeCodeSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const { claudeCode, toolSearch = true, loader: loaderOpts, ...sessionOpts } = opts;
	const cwd = sessionOpts.cwd ?? process.cwd();
	const agentDir = sessionOpts.agentDir ?? getAgentDir();
	// Created here (instead of inside createAgentSession) so subagent sessions can share it.
	const modelRuntime = sessionOpts.modelRuntime ?? claudeCode?.modelRuntime ?? (await ModelRuntime.create());
	const loader = new DefaultResourceLoader({
		...loaderOpts,
		cwd,
		agentDir,
		settingsManager: loaderOpts?.settingsManager ?? sessionOpts.settingsManager,
		extensionFactories: [
			createClaudeCodeExtension({ ...claudeCode, modelRuntime }),
			...(toolSearch ? [createToolSearchExtension()] : []),
			...(loaderOpts?.extensionFactories ?? []),
		],
	});
	await loader.reload();
	return createAgentSession({ ...sessionOpts, cwd, agentDir, modelRuntime, resourceLoader: loader, noTools: "builtin" });
}

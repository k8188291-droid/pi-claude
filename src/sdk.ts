import {
	createAgentSession,
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	DefaultResourceLoader,
	getAgentDir,
} from "@mariozechner/pi-coding-agent";
import { createClaudeCodeExtension } from "./index.js";
import type { ClaudeCodeToolsOptions } from "./shared/types.js";

type LoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];

export interface CreateClaudeCodeSessionOptions extends Omit<CreateAgentSessionOptions, "resourceLoader" | "noTools"> {
	/** Options for the Claude Code tools. */
	claudeCode?: ClaudeCodeToolsOptions;
	/** Extra DefaultResourceLoader options (extensionFactories are appended after ours). */
	loader?: Partial<Omit<LoaderOptions, "cwd" | "agentDir">>;
}

/**
 * Convenience wrapper: createAgentSession with pi's built-in tools disabled and the
 * Claude Code tool extension installed.
 */
export async function createClaudeCodeSession(opts: CreateClaudeCodeSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const { claudeCode, loader: loaderOpts, ...sessionOpts } = opts;
	const cwd = sessionOpts.cwd ?? process.cwd();
	const agentDir = sessionOpts.agentDir ?? getAgentDir();
	const loader = new DefaultResourceLoader({
		...loaderOpts,
		cwd,
		agentDir,
		settingsManager: loaderOpts?.settingsManager ?? sessionOpts.settingsManager,
		extensionFactories: [createClaudeCodeExtension(claudeCode), ...(loaderOpts?.extensionFactories ?? [])],
	});
	await loader.reload();
	return createAgentSession({ ...sessionOpts, cwd, agentDir, resourceLoader: loader, noTools: "builtin" });
}

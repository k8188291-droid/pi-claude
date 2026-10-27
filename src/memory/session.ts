import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	createToolSearchExtension,
	type ExtensionFactory,
	ModelRuntime,
	type SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { InMemoryFs } from "just-bash";
import { createClaudeCodeExtension } from "../index.js";
import type { ClaudeCodeToolsOptions } from "../shared/types.js";
import { createMemoryHost, DEFAULT_MEMORY_FS_BYTES, type MemoryHost, type MemoryHostOptions } from "./host.js";
import { DEFAULT_MEMORY_CWD, normalizeVirtualPath } from "./paths.js";
import { DEFAULT_MEMORY_AGENT_DIR, MemoryResourceLoader, type MemoryResourceLoaderOptions } from "./resource-loader.js";
import { createSnapshotSessionManager, loadSnapshot, type MemorySnapshot, type SessionSnapshot, serializeSnapshot } from "./snapshot.js";

type CredentialStore = NonNullable<NonNullable<Parameters<typeof ModelRuntime.create>[0]>["credentials"]>;

/**
 * A `ModelRuntime` that touches no file and no network: credentials in memory, the built-in model
 * catalog only (`modelsPath: null`, no catalog refresh). Register providers or set API keys on it
 * (`setRuntimeApiKey`, `registerProvider`) for Bedrock, OpenAI-compatible endpoints, etc.
 */
export async function createMemoryModelRuntime(options: { credentials?: CredentialStore } = {}): Promise<ModelRuntime> {
	return ModelRuntime.create({
		credentials: options.credentials ?? new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
}

export interface CreateMemoryClaudeCodeSessionOptions
	extends Omit<CreateAgentSessionOptions, "resourceLoader" | "noTools" | "cwd" | "agentDir" | "sessionManager" | "settingsManager"> {
	/** An existing memory host (its filesystem is used). Default: one created from `hostOptions`. */
	host?: MemoryHost;
	/** Options for the memory host created when `host` is not given. */
	hostOptions?: MemoryHostOptions;
	/** Restored into the filesystem first; supplies the cwd and the session tree. */
	snapshot?: MemorySnapshot | string;
	/** Virtual working directory. Default: the snapshot's, the host's, or `/workspace`. */
	cwd?: string;
	/** Virtual pi agent directory (global AGENTS.md, skills, prompts). Default `/agent`. */
	agentDir?: string;
	/** In-memory settings. Ignored when `settingsManager` is given. */
	settings?: Parameters<typeof SettingsManager.inMemory>[0];
	settingsManager?: SettingsManager;
	/** Default: in memory, restored from `snapshot.session` when present. */
	sessionManager?: SessionManager;
	/**
	 * Options for the Claude Code tools (`host` is always the memory host). `subagents` defaults to
	 * false here: the Task tool builds child sessions with pi's DefaultResourceLoader, which reads the
	 * host disk; enable it only once child sessions can use a memory resource loader.
	 */
	claudeCode?: Omit<ClaudeCodeToolsOptions, "host">;
	/** Install pi's built-in `tool_search` extension. Default true. */
	toolSearch?: boolean;
	/** More in-process extensions (after the Claude Code tools). */
	extensionFactories?: ExtensionFactory[];
	/** Resource loader options (extra skill/prompt roots, system prompt, ...). */
	loader?: Omit<MemoryResourceLoaderOptions, "vfs" | "cwd" | "agentDir" | "extensionFactories">;
}

export interface MemoryClaudeCodeSession extends CreateAgentSessionResult {
	host: MemoryHost;
	vfs: InMemoryFs;
	cwd: string;
	resourceLoader: MemoryResourceLoader;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	modelRuntime: ModelRuntime;
	/** The filesystem and the session tree as a snapshot object, ready for `JSON.stringify`. */
	snapshot(): Promise<MemorySnapshot>;
}

/**
 * `createClaudeCodeSession` for a sandbox with no host filesystem or processes: a memory host
 * (just-bash `InMemoryFs` + interpreter), a resource loader reading AGENTS.md / skills / prompt
 * templates from that filesystem (file-based extensions never load), in-memory settings and session,
 * pi's built-in tools off and the Claude Code tools installed on the memory host.
 *
 * `model` and `modelRuntime` come from the caller (any provider); without a runtime, an empty
 * in-memory one is created (`createMemoryModelRuntime`).
 */
export async function createMemoryClaudeCodeSession(opts: CreateMemoryClaudeCodeSessionOptions = {}): Promise<MemoryClaudeCodeSession> {
	const {
		host: givenHost,
		hostOptions,
		snapshot,
		cwd: givenCwd,
		agentDir: givenAgentDir,
		settings,
		settingsManager: givenSettings,
		sessionManager: givenSessionManager,
		claudeCode,
		toolSearch = true,
		extensionFactories = [],
		loader: loaderOptions,
		...sessionOpts
	} = opts;

	const vfs = givenHost?.vfs ?? hostOptions?.fs ?? new InMemoryFs({}, { maxTotalBytes: hostOptions?.maxFileSystemBytes ?? DEFAULT_MEMORY_FS_BYTES });
	let restoredSession: SessionSnapshot | undefined;
	let snapshotCwd: string | undefined;
	if (snapshot !== undefined) {
		const loaded = await loadSnapshot(vfs, snapshot);
		restoredSession = loaded.session;
		snapshotCwd = loaded.cwd;
	}
	const cwd = normalizeVirtualPath(givenCwd ?? snapshotCwd ?? givenHost?.cwd ?? hostOptions?.cwd ?? DEFAULT_MEMORY_CWD, "/");
	const host = givenHost ?? (await createMemoryHost({ ...hostOptions, fs: vfs, cwd }));
	await vfs.mkdir(cwd, { recursive: true });
	const agentDir = normalizeVirtualPath(givenAgentDir ?? DEFAULT_MEMORY_AGENT_DIR, "/");

	const modelRuntime = sessionOpts.modelRuntime ?? claudeCode?.modelRuntime ?? (await createMemoryModelRuntime());
	const settingsManager = givenSettings ?? SettingsManager.inMemory(settings);
	const sessionManager = givenSessionManager ?? createSnapshotSessionManager(cwd, restoredSession);
	const resourceLoader = new MemoryResourceLoader({
		...loaderOptions,
		vfs,
		cwd,
		agentDir,
		extensionFactories: [
			createClaudeCodeExtension({ ...claudeCode, subagents: claudeCode?.subagents ?? false, host, modelRuntime }),
			...(toolSearch ? [createToolSearchExtension()] : []),
			...extensionFactories,
		],
	});
	await resourceLoader.reload();
	const result = await createAgentSession({
		...sessionOpts,
		cwd,
		agentDir,
		modelRuntime,
		settingsManager,
		sessionManager,
		resourceLoader,
		noTools: "builtin",
	});
	return {
		...result,
		host,
		vfs,
		cwd,
		resourceLoader,
		sessionManager,
		settingsManager,
		modelRuntime,
		snapshot: () => serializeSnapshot(vfs, { cwd, sessionManager }),
	};
}

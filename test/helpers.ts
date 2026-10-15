import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import {
	type AgentSession,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionFactory,
	type ToolDefinition,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createClaudeCodeSession } from "../src/sdk.js";
import type { ClaudeCodeToolsOptions } from "../src/shared/types.js";

export { fauxAssistantMessage, fauxText, fauxToolCall };

export function tempDir(prefix = "pi-cc-test-"): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

export interface TestSession {
	session: AgentSession;
	faux: ReturnType<typeof registerFauxProvider>;
	cwd: string;
	/** Tool results seen in the session, in order. */
	toolResults(): Array<{ toolName: string; text: string; isError: boolean; details: any }>;
	dispose(): void;
}

/**
 * Create a real AgentSession backed by the faux provider with the Claude Code extension installed.
 * `responses` is the scripted list of assistant messages (or factories) the model will return.
 */
export async function createTestSession(opts: {
	responses: FauxResponseStep[];
	cwd?: string;
	claudeCode?: ClaudeCodeToolsOptions;
	extraExtensions?: ExtensionFactory[];
}): Promise<TestSession> {
	const cwd = opts.cwd ?? tempDir();
	const agentDir = tempDir("pi-cc-agentdir-");
	const faux = withLegacyContext(registerFauxProvider());
	faux.setResponses(opts.responses);
	const modelRuntime = await createTestModelRuntime(faux, agentDir);
	const { session } = await createClaudeCodeSession({
		cwd,
		agentDir,
		model: faux.getModel(),
		modelRuntime,
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } } as any),
		claudeCode: opts.claudeCode,
		loader: { extensionFactories: opts.extraExtensions ?? [], noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true },
	});
	return {
		session,
		faux,
		cwd,
		toolResults() {
			return session.messages
				.filter((m: any) => m.role === "toolResult")
				.map((m: any) => ({
					toolName: m.toolName,
					text: m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n"),
					isError: !!m.isError,
					details: m.details,
				}));
		},
		dispose() {
			session.dispose();
			faux.unregister();
		},
	};
}

/**
 * Directly execute a registered tool without a model, for unit tests.
 * Returns the tool definition map captured from the extension factory.
 */
export function captureTools(factory: ExtensionFactory): { tools: Map<string, ToolDefinition>; handlers: Map<string, Function[]> } {
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, Function[]>();
	const fakePi = new Proxy(
		{},
		{
			get(_t, prop) {
				if (prop === "registerTool") return (def: ToolDefinition) => tools.set(def.name, def);
				if (prop === "on") return (ev: string, h: Function) => handlers.set(ev, [...(handlers.get(ev) ?? []), h]);
				if (prop === "getAllTools") return () => [...tools.values()].map((t) => ({ name: t.name, description: t.description, parameters: t.parameters, sourceInfo: { source: "extension" } }));
				if (prop === "getActiveTools") return () => [...tools.keys()];
				return () => undefined;
			},
		},
	) as ExtensionAPI;
	factory(fakePi);
	return { tools, handlers };
}

export function fakeCtx(cwd: string, extra: Partial<ExtensionContext> = {}): ExtensionContext {
	return { cwd, hasUI: false, signal: undefined, ...extra } as unknown as ExtensionContext;
}

export function resultText(r: { content: Array<{ type: string; text?: string }> }): string {
	return r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
}

/**
 * ModelRuntime (auth file in a temp dir, no network). Pass a faux registration to register the faux
 * provider and its models with the runtime (pi 1.x only runs models of providers the runtime knows),
 * or a provider id to just give that provider a test key.
 */
export async function createTestModelRuntime(
	providerOrFaux: string | ReturnType<typeof registerFauxProvider>,
	dir = tempDir("pi-cc-auth-"),
): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	if (typeof providerOrFaux === "string") {
		await runtime.setRuntimeApiKey(providerOrFaux, "test-key");
		return runtime;
	}
	const faux = providerOrFaux;
	const provider = faux.getModel().provider;
	runtime.registerProvider(provider, {
		name: "Faux",
		api: faux.api as any,
		baseUrl: faux.getModel().baseUrl || "http://faux.invalid",
		apiKey: "test-key",
		models: faux.models.map((m) => ({
			id: m.id,
			name: m.name,
			reasoning: m.reasoning,
			input: m.input,
			cost: m.cost,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
		})) as any,
	});
	return runtime;
}

/**
 * pi 1.x passes faux response factories a TranscriptContext whose prompt and tool declarations live
 * in system messages. Tests read `context.tools` / `context.systemPrompt`, so expose them again.
 */
export function withLegacyContext<T extends ReturnType<typeof registerFauxProvider>>(faux: T): T {
	const wrap = (steps: FauxResponseStep[]) =>
		steps.map((step) =>
			typeof step === "function"
				? ((ctx: any, ...rest: any[]) =>
						(step as any)(
							Object.assign(Object.create(ctx), {
								messages: ctx.messages,
								tools: getCurrentTools(ctx.messages),
								systemPrompt: getCurrentSystemPrompt(ctx.messages),
							}),
							...rest,
						)) as FauxResponseStep
				: step,
		);
	const set = faux.setResponses.bind(faux);
	const append = faux.appendResponses.bind(faux);
	faux.setResponses = (steps) => set(wrap(steps));
	faux.appendResponses = (steps) => append(wrap(steps));
	return faux;
}

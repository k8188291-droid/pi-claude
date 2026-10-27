import { createRequire } from "node:module";
import { dirname, join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	createEventBus,
	createExtensionRuntime,
	createSyntheticSourceInfo,
	type EventBus,
	type ExtensionFactory,
	type ExtensionRuntime,
	type LoadExtensionsResult,
	parseFrontmatter,
	type ResourceDiagnostic,
	type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { InMemoryFs } from "just-bash";
import { DEFAULT_MEMORY_CWD, isWithin, normalizeVirtualPath } from "./paths.js";

type Skill = ReturnType<ResourceLoader["getSkills"]>["skills"][number];
type PromptTemplate = ReturnType<ResourceLoader["getPrompts"]>["prompts"][number];
type Extension = LoadExtensionsResult["extensions"][number];
type ResourceExtensionPaths = Parameters<ResourceLoader["extendResources"]>[0];

/** Default pi agent directory inside the virtual filesystem (`<agentDir>/skills`, `/prompts`, `AGENTS.md`). */
export const DEFAULT_MEMORY_AGENT_DIR = "/agent";

const CONTEXT_FILE_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

export interface MemoryResourceLoaderOptions {
	vfs: InMemoryFs;
	/** Default `/workspace`. */
	cwd?: string;
	/** Default `/agent`. */
	agentDir?: string;
	/**
	 * In-process extension factories (such as `createClaudeCodeExtension`). These are the only
	 * extensions: nothing is ever discovered or loaded from a file, in the VFS or on the host.
	 */
	extensionFactories?: ExtensionFactory[];
	/** Extra skill roots (virtual paths, relative to cwd). Defaults: `<agentDir>/skills`, `<cwd>/.pi/skills`, `<cwd>/.agents/skills`. */
	skillPaths?: string[];
	/** Extra prompt template roots. Defaults: `<agentDir>/prompts`, `<cwd>/.pi/prompts`. */
	promptPaths?: string[];
	/** Replaces pi's default system prompt. */
	systemPrompt?: string;
	/** Appended to the system prompt. */
	appendSystemPrompt?: string[];
	/** Skip AGENTS.md / CLAUDE.md. */
	noContextFiles?: boolean;
}

type LoadExtensionFromFactory = (
	factory: ExtensionFactory,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
	extensionPath?: string,
) => Promise<Extension>;

let loaderModule: Promise<LoadExtensionFromFactory> | undefined;

/**
 * pi's `loadExtensionFromFactory` (what `DefaultResourceLoader` uses for inline factories). It is not
 * among the package's public exports, so it is loaded from the installed package by file path;
 * `DefaultResourceLoader` itself cannot be used because it scans the host disk (settings, packages,
 * `~/.pi/agent`, project `.pi/` directories, context files) on every reload.
 */
function loadExtensionFromFactory(): Promise<LoadExtensionFromFactory> {
	loaderModule ??= (async () => {
		let entry: string;
		try {
			entry = import.meta.resolve("@earendil-works/pi-coding-agent");
		} catch {
			entry = pathToFileURL(createRequire(import.meta.url).resolve("@earendil-works/pi-coding-agent")).href;
		}
		const file = fileURLToPath(entry);
		const url = pathToFileURL(join(dirname(file), "core", "extensions", "loader.js")).href;
		const mod = (await import(url)) as { loadExtensionFromFactory?: LoadExtensionFromFactory };
		if (typeof mod.loadExtensionFromFactory !== "function") {
			throw new Error("The installed @earendil-works/pi-coding-agent has no core/extensions/loader.js loadExtensionFromFactory; the memory resource loader cannot install extensions.");
		}
		return mod.loadExtensionFromFactory;
	})();
	return loaderModule;
}

/**
 * A pi `ResourceLoader` that reads only the virtual filesystem: AGENTS.md / CLAUDE.md (agentDir,
 * then every directory from `/` down to cwd), skills and prompt templates. Extensions are only the
 * in-process factories passed in; file-based extensions and themes are never loaded.
 */
export class MemoryResourceLoader implements ResourceLoader {
	readonly vfs: InMemoryFs;
	readonly cwd: string;
	readonly agentDir: string;
	private readonly options: MemoryResourceLoaderOptions;
	private readonly eventBus = createEventBus();
	private extensionsResult: LoadExtensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
	private skills: Skill[] = [];
	private skillDiagnostics: ResourceDiagnostic[] = [];
	private prompts: PromptTemplate[] = [];
	private promptDiagnostics: ResourceDiagnostic[] = [];
	private agentsFiles: Array<{ path: string; content: string }> = [];
	private readonly extraSkillPaths: string[] = [];
	private readonly extraPromptPaths: string[] = [];

	constructor(options: MemoryResourceLoaderOptions) {
		this.options = options;
		this.vfs = options.vfs;
		this.cwd = normalizeVirtualPath(options.cwd ?? DEFAULT_MEMORY_CWD, "/");
		this.agentDir = normalizeVirtualPath(options.agentDir ?? DEFAULT_MEMORY_AGENT_DIR, "/");
	}

	getExtensions(): LoadExtensionsResult {
		return this.extensionsResult;
	}
	getSkills() {
		return { skills: this.skills, diagnostics: this.skillDiagnostics };
	}
	getPrompts() {
		return { prompts: this.prompts, diagnostics: this.promptDiagnostics };
	}
	getThemes() {
		return { themes: [], diagnostics: [] };
	}
	getAgentsFiles() {
		return { agentsFiles: this.agentsFiles };
	}
	getSystemPrompt(): string | undefined {
		return this.options.systemPrompt;
	}
	getSystemPromptSource(): { path: string } | undefined {
		return undefined;
	}
	getAppendSystemPrompt(): string[] {
		return this.options.appendSystemPrompt ?? [];
	}
	getAppendSystemPromptSources(): Array<{ path: string }> {
		return [];
	}

	extendResources(paths: ResourceExtensionPaths): void {
		this.extraSkillPaths.push(...(paths.skillPaths ?? []).map((e) => e.path));
		this.extraPromptPaths.push(...(paths.promptPaths ?? []).map((e) => e.path));
	}

	async reload(): Promise<void> {
		await this.loadExtensions();
		await this.loadAgentsFiles();
		await this.loadSkills();
		await this.loadPrompts();
	}

	private async loadExtensions(): Promise<void> {
		const runtime = createExtensionRuntime();
		const result: LoadExtensionsResult = { extensions: [], errors: [], runtime };
		const factories = this.options.extensionFactories ?? [];
		if (factories.length > 0) {
			const load = await loadExtensionFromFactory();
			for (const [i, factory] of factories.entries()) {
				const path = `<inline:${i + 1}>`;
				try {
					result.extensions.push(await load(factory, this.cwd, this.eventBus, runtime, path));
				} catch (err) {
					result.errors.push({ path, error: err instanceof Error ? err.message : "failed to load extension" });
				}
			}
		}
		this.extensionsResult = result;
	}

	private async isFile(path: string): Promise<boolean> {
		try {
			return (await this.vfs.stat(path)).isFile;
		} catch {
			return false;
		}
	}

	private async loadAgentsFiles(): Promise<void> {
		if (this.options.noContextFiles) {
			this.agentsFiles = [];
			return;
		}
		const dirs: string[] = [];
		for (let d = this.cwd; ; d = posix.dirname(d)) {
			dirs.unshift(d);
			if (d === "/") break;
		}
		if (!dirs.includes(this.agentDir)) dirs.unshift(this.agentDir);
		const files: Array<{ path: string; content: string }> = [];
		for (const dir of dirs) {
			for (const name of CONTEXT_FILE_NAMES) {
				const path = posix.join(dir, name);
				if (!(await this.isFile(path))) continue;
				files.push({ path, content: stripBom(await this.vfs.readFile(path, "utf8")) });
				break;
			}
		}
		this.agentsFiles = files;
	}

	private roots(defaults: string[], extra: string[], configured: string[] | undefined): string[] {
		return [...new Set([...defaults, ...(configured ?? []), ...extra].map((p) => normalizeVirtualPath(p, this.cwd)))];
	}

	/** Files below `roots`, sorted, skipping dot-directories and node_modules (as pi does). */
	private filesUnder(roots: string[]): string[] {
		return this.vfs
			.getAllPaths()
			.filter((p) => roots.some((r) => p !== r && isWithin(p, r) && !hiddenBelow(p, r)))
			.sort();
	}

	private async loadSkills(): Promise<void> {
		const roots = this.roots(
			[posix.join(this.agentDir, "skills"), posix.join(this.cwd, ".pi", "skills"), posix.join(this.cwd, ".agents", "skills")],
			this.extraSkillPaths,
			this.options.skillPaths,
		);
		const skills: Skill[] = [];
		const diagnostics: ResourceDiagnostic[] = [];
		const seen = new Set<string>();
		// a directory with SKILL.md is one skill (nothing below it is scanned); a root may also hold
		// plain `<name>.md` skills
		const files = this.filesUnder(roots);
		const skillDirs = new Set(files.filter((f) => posix.basename(f) === "SKILL.md").map((f) => posix.dirname(f)));
		const insideOtherSkill = (dir: string, root: string) => {
			for (let d = posix.dirname(dir); d !== root && isWithin(d, root) && d !== "/"; d = posix.dirname(d)) if (skillDirs.has(d)) return true;
			return false;
		};
		for (const filePath of files) {
			const base = posix.basename(filePath);
			const dir = posix.dirname(filePath);
			const root = roots.find((r) => isWithin(filePath, r))!;
			const isSkillFile = base === "SKILL.md" ? !insideOtherSkill(dir, root) : dir === root && base.endsWith(".md");
			if (!isSkillFile || !(await this.isFile(filePath))) continue;
			let parsed: { frontmatter: Record<string, unknown>; body: string };
			try {
				parsed = parseFrontmatter(await this.vfs.readFile(filePath, "utf8"));
			} catch (err) {
				diagnostics.push({ type: "warning", message: err instanceof Error ? err.message : String(err), path: filePath });
				continue;
			}
			const description = typeof parsed.frontmatter.description === "string" ? parsed.frontmatter.description.trim() : "";
			if (!description) {
				diagnostics.push({ type: "warning", message: "Skill has no description", path: filePath });
				continue;
			}
			const fallbackName = base === "SKILL.md" ? posix.basename(dir) : base.slice(0, -3);
			const name = typeof parsed.frontmatter.name === "string" ? parsed.frontmatter.name : fallbackName;
			if (seen.has(name)) {
				diagnostics.push({ type: "warning", message: `Duplicate skill name: ${name}`, path: filePath });
				continue;
			}
			seen.add(name);
			skills.push({
				name,
				description,
				filePath,
				baseDir: dir,
				sourceInfo: createSyntheticSourceInfo(filePath, { source: "memory", scope: isWithin(filePath, this.agentDir) ? "user" : "project", baseDir: dir }),
				disableModelInvocation: parsed.frontmatter["disable-model-invocation"] === true,
			});
		}
		this.skills = skills;
		this.skillDiagnostics = diagnostics;
	}

	private async loadPrompts(): Promise<void> {
		const roots = this.roots([posix.join(this.agentDir, "prompts"), posix.join(this.cwd, ".pi", "prompts")], this.extraPromptPaths, this.options.promptPaths);
		const prompts: PromptTemplate[] = [];
		const diagnostics: ResourceDiagnostic[] = [];
		const seen = new Set<string>();
		for (const filePath of this.filesUnder(roots)) {
			if (!filePath.endsWith(".md") || !(await this.isFile(filePath))) continue;
			let parsed: { frontmatter: Record<string, unknown>; body: string };
			try {
				parsed = parseFrontmatter(await this.vfs.readFile(filePath, "utf8"));
			} catch (err) {
				diagnostics.push({ type: "warning", message: err instanceof Error ? err.message : String(err), path: filePath });
				continue;
			}
			const name = typeof parsed.frontmatter.name === "string" ? parsed.frontmatter.name : posix.basename(filePath, ".md");
			if (seen.has(name)) {
				diagnostics.push({ type: "warning", message: `name "/${name}" collision`, path: filePath });
				continue;
			}
			seen.add(name);
			const baseDir = posix.dirname(filePath);
			prompts.push({
				name,
				description: typeof parsed.frontmatter.description === "string" ? parsed.frontmatter.description : "",
				argumentHint: typeof parsed.frontmatter["argument-hint"] === "string" ? parsed.frontmatter["argument-hint"] : undefined,
				content: parsed.body,
				filePath,
				sourceInfo: createSyntheticSourceInfo(filePath, { source: "memory", scope: isWithin(filePath, this.agentDir) ? "user" : "project", baseDir }),
			});
		}
		this.prompts = prompts;
		this.promptDiagnostics = diagnostics;
	}
}

function stripBom(s: string): string {
	return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** True when a path component between `root` and `path` is a dot-directory or node_modules. */
function hiddenBelow(path: string, root: string): boolean {
	const rel = path.slice(root === "/" ? 1 : root.length + 1).split("/");
	return rel.slice(0, -1).some((c) => c.startsWith(".") || c === "node_modules");
}

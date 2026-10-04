import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Model } from "@mariozechner/pi-ai";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import type { AgentDefinition } from "../shared/types.js";

export type AgentSource = "built-in" | "user" | "project" | "options";

/** Normalized subagent definition used internally by the Task tool. */
export interface SubagentDefinition {
	name: string;
	description: string;
	/** System prompt for the child session. */
	prompt: string;
	/** Tool allowlist; undefined = every tool available to a subagent session. */
	tools?: string[];
	/** undefined = inherit parent model; string = alias ("sonnet"/"opus"/"haiku") or model id. */
	model?: Model<any> | string;
	source: AgentSource;
	/** Markdown file the definition came from (user/project agents). */
	filePath?: string;
}

/** Tools used by the read-only built-in agents (unknown names are simply ignored by pi's allowlist). */
export const READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "Bash", "WebFetch", "WebSearch"];

const GENERAL_PURPOSE_PROMPT = `You are an agent for a coding assistant. Given the user's message, you should use the tools available to complete the task. Do what has been asked; nothing more, nothing less. When you complete the task simply respond with a detailed writeup.

Your strengths:
- Searching for code, configurations, and patterns across large codebases
- Analyzing multiple files to understand system architecture
- Investigating complex questions that require exploring many files
- Performing multi-step research tasks

Guidelines:
- For file searches: Use Grep or Glob when you need to search broadly. Use Read when you know the specific file path.
- For analysis: Start broad and narrow down. Use multiple search strategies if the first doesn't yield results.
- Be thorough: Check multiple locations, consider different naming conventions, look for related files.
- NEVER create files unless they're absolutely necessary for achieving your goal. ALWAYS prefer editing an existing file to creating a new one.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested.
- In your final response always share relevant file names and code snippets. Any file paths you return in your response MUST be absolute. Do NOT use relative paths.
- For clear communication, avoid using emojis.`;

const READ_ONLY_RULES = `=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
This is a READ-ONLY task. You are STRICTLY PROHIBITED from:
- Creating new files (no Write, touch, or file creation of any kind)
- Modifying existing files (no Edit operations)
- Deleting files (no rm or deletion)
- Moving or copying files (no mv or cp)
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

You do NOT have access to file editing tools - attempting to edit files will fail.`;

const EXPLORE_PROMPT = `You are a file search specialist. You excel at thoroughly navigating and exploring codebases.

${READ_ONLY_RULES}

Your role is EXCLUSIVELY to search and analyze existing code.

Your strengths:
- Rapidly finding files using glob patterns
- Searching code and text with powerful regex patterns
- Reading and analyzing file contents

Guidelines:
- Use Glob for broad file pattern matching
- Use Grep for searching file contents with regex
- Use Read when you know the specific file path you need to read
- Use Bash ONLY for read-only operations (ls, git status, git log, git diff, find, cat, head, tail)
- NEVER use Bash for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation/modification
- Adapt your search approach based on the thoroughness level specified by the caller
- Return file paths as absolute paths in your final response
- For clear communication, avoid using emojis
- Communicate your final report directly as a regular message - do NOT attempt to create files

NOTE: You are meant to be a fast agent that returns output as quickly as possible. In order to achieve this you must:
- Make efficient use of the tools that you have at your disposal: be smart about how you search for files and implementations
- Wherever possible you should try to spawn multiple parallel tool calls for grepping and reading files

Complete the user's search request efficiently and report your findings clearly.`;

const PLAN_PROMPT = `You are a software architect and planning specialist. Your role is to explore the codebase and design implementation plans.

${READ_ONLY_RULES}

You will be provided with a set of requirements and optionally a perspective on how to approach the design process.

## Your Process

1. **Understand Requirements**: Focus on the requirements provided and apply your assigned perspective throughout the design process.

2. **Explore Thoroughly**:
   - Read any files provided to you in the initial prompt
   - Find existing patterns and conventions using Glob, Grep, and Read
   - Understand the current architecture
   - Identify similar features as reference
   - Trace through relevant code paths
   - Use Bash ONLY for read-only operations (ls, git status, git log, git diff, find, cat, head, tail)

3. **Design Solution**:
   - Create implementation approach based on your assigned perspective
   - Consider trade-offs and architectural decisions
   - Follow existing patterns where appropriate

4. **Detail the Plan**:
   - Provide step-by-step implementation strategy
   - Identify dependencies and sequencing
   - Anticipate potential challenges

## Required Output

End your response with:

### Critical Files for Implementation
List 3-5 files most critical for implementing this plan:
- path/to/file1 - [Brief reason: e.g., "Core logic to modify"]
- path/to/file2 - [Brief reason: e.g., "Interfaces to implement"]

REMEMBER: You can ONLY explore and plan. You CANNOT and MUST NOT write, edit, or modify any files.`;

export const BUILT_IN_AGENTS: Record<string, SubagentDefinition> = {
	"general-purpose": {
		name: "general-purpose",
		description:
			"General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you.",
		prompt: GENERAL_PURPOSE_PROMPT,
		source: "built-in",
	},
	Explore: {
		name: "Explore",
		description:
			'Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.',
		prompt: EXPLORE_PROMPT,
		tools: READ_ONLY_TOOLS,
		source: "built-in",
	},
	Plan: {
		name: "Plan",
		description:
			"Software architect agent for designing implementation plans. Use this when you need to plan the implementation strategy for a task. Returns step-by-step plans, identifies critical files, and considers architectural trade-offs.",
		prompt: PLAN_PROMPT,
		tools: READ_ONLY_TOOLS,
		source: "built-in",
	},
};

/** Parse a `tools` frontmatter value: "A, B", ["A","B"], "*" (all). */
export function parseToolList(value: unknown): string[] | undefined {
	let items: string[];
	if (Array.isArray(value)) items = value.map((v) => String(v));
	else if (typeof value === "string") items = value.split(",");
	else return undefined;
	items = items.map((s) => s.trim()).filter(Boolean);
	if (items.length === 0 || items.includes("*")) return undefined;
	return items;
}

/** Parse one markdown agent file. Returns undefined when the file is not a usable agent definition. */
export function parseAgentMarkdown(content: string, filePath: string, source: AgentSource): SubagentDefinition | undefined {
	let frontmatter: Record<string, unknown>;
	let body: string;
	try {
		({ frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content));
	} catch {
		return undefined;
	}
	const name = typeof frontmatter.name === "string" && frontmatter.name.trim() ? frontmatter.name.trim() : basename(filePath, ".md");
	const description =
		typeof frontmatter.description === "string" && frontmatter.description.trim()
			? frontmatter.description.trim()
			: `Custom agent "${name}"`;
	const modelRaw = typeof frontmatter.model === "string" ? frontmatter.model.trim() : undefined;
	return {
		name,
		description,
		prompt: body.trim(),
		tools: parseToolList(frontmatter.tools),
		model: modelRaw && modelRaw !== "inherit" ? modelRaw : undefined,
		source,
		filePath,
	};
}

export function loadAgentsFromDir(dir: string, source: AgentSource): SubagentDefinition[] {
	if (!existsSync(dir)) return [];
	let entries: string[];
	try {
		entries = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
	} catch {
		return [];
	}
	const out: SubagentDefinition[] = [];
	for (const file of entries) {
		const p = join(dir, file);
		try {
			if (!statSync(p).isFile()) continue;
			const def = parseAgentMarkdown(readFileSync(p, "utf8"), p, source);
			if (def) out.push(def);
		} catch {
			// unreadable file: skip
		}
	}
	return out;
}

function fromOptions(name: string, def: AgentDefinition): SubagentDefinition {
	return {
		name,
		description: def.description,
		prompt: def.prompt,
		tools: def.tools && def.tools.length > 0 && !def.tools.includes("*") ? [...def.tools] : undefined,
		model: def.model === "inherit" ? undefined : def.model,
		source: "options",
	};
}

export interface LoadAgentsOptions {
	cwd: string;
	agents?: Record<string, AgentDefinition>;
	loadAgentsFromDisk?: boolean;
	/** Override for tests. Default: os.homedir(). */
	homeDir?: string;
}

/**
 * Resolve all agent definitions. Precedence (later wins):
 * built-in < ~/.claude/agents < <cwd>/.claude/agents < options.agents.
 */
export function loadAgentDefinitions(opts: LoadAgentsOptions): Map<string, SubagentDefinition> {
	const map = new Map<string, SubagentDefinition>();
	for (const def of Object.values(BUILT_IN_AGENTS)) map.set(def.name, def);
	if (opts.loadAgentsFromDisk !== false) {
		const home = opts.homeDir ?? homedir();
		const userDir = join(home, ".claude", "agents");
		const projectDir = join(opts.cwd, ".claude", "agents");
		for (const def of loadAgentsFromDir(userDir, "user")) map.set(def.name, def);
		if (projectDir !== userDir) for (const def of loadAgentsFromDir(projectDir, "project")) map.set(def.name, def);
	}
	for (const [name, def] of Object.entries(opts.agents ?? {})) map.set(name, fromOptions(name, def));
	return map;
}

/** "- name: description (Tools: ...)" lines, as in Claude Code's Task tool description. */
export function formatAgentList(defs: Map<string, SubagentDefinition>, knownTools?: ReadonlySet<string>): string {
	const toolsLabel = (d: SubagentDefinition) => {
		if (!d.tools) return "*";
		const shown = knownTools && knownTools.size > 0 ? d.tools.filter((t) => knownTools.has(t)) : d.tools;
		return shown.length > 0 ? shown.join(", ") : "none";
	};
	return [...defs.values()].map((d) => `- ${d.name}: ${d.description} (Tools: ${toolsLabel(d)})`).join("\n");
}

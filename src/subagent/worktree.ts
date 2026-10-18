import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { WorktreeInfo } from "./prompt.js";

/** A temporary git worktree an `isolation: "worktree"` agent works in. */
export interface AgentWorktree {
	gitRoot: string;
	path: string;
	branch: string;
	headCommit: string;
	/** The agent's cwd inside the worktree (same relative location as the parent's cwd). */
	cwd: string;
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Root of the git checkout containing `cwd`, or undefined when it is not inside one. */
export function gitRootOf(cwd: string): string | undefined {
	try {
		return git(cwd, ["rev-parse", "--show-toplevel"]) || undefined;
	} catch {
		return undefined;
	}
}

/** Create `<repo>/.claude/worktrees/agent-<id>` on a new branch `worktree-agent-<id>` at HEAD. */
export function createAgentWorktree(cwd: string, agentId: string): AgentWorktree {
	const gitRoot = gitRootOf(cwd);
	if (!gitRoot) throw new Error(`Cannot create an agent worktree: ${cwd} is not inside a git repository. Omit isolation to run the agent in the current directory.`);
	let headCommit: string;
	try {
		headCommit = git(gitRoot, ["rev-parse", "HEAD"]);
	} catch {
		throw new Error("Cannot create an agent worktree: the repository has no commits yet.");
	}
	const name = `agent-${agentId.replace(/^a/, "").slice(0, 8)}`;
	const dir = join(gitRoot, ".claude", "worktrees");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	const branch = `worktree-${name}`;
	try {
		git(gitRoot, ["worktree", "add", "-b", branch, path, headCommit]);
	} catch (err) {
		const msg = (err as { stderr?: string }).stderr?.toString().trim() || (err as Error).message;
		throw new Error(`Cannot create an agent worktree: ${msg}`);
	}
	const rel = relative(gitRoot, cwd);
	const sub = rel && !rel.startsWith("..") ? join(path, rel) : path;
	return { gitRoot, path, branch, headCommit, cwd: existsSync(sub) ? sub : path };
}

/**
 * Remove the worktree (and its branch) when the agent left it untouched; otherwise keep it and
 * return its path and branch for the result.
 */
export function finishAgentWorktree(w: AgentWorktree): WorktreeInfo | undefined {
	let dirty = true;
	try {
		const status = git(w.path, ["status", "--porcelain"]);
		const head = git(w.path, ["rev-parse", "HEAD"]);
		dirty = status !== "" || head !== w.headCommit;
	} catch {
		dirty = true;
	}
	if (dirty) return { worktreePath: w.path, worktreeBranch: w.branch };
	try {
		git(w.gitRoot, ["worktree", "remove", "--force", w.path]);
		git(w.gitRoot, ["branch", "-D", w.branch]);
	} catch {
		return { worktreePath: w.path, worktreeBranch: w.branch };
	}
	return undefined;
}

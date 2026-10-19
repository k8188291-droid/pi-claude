import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
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

/**
 * Like Claude Code, worktree management never runs repository hooks or fsmonitor daemons: a failing
 * post-checkout hook must not fail (or half-create) the agent's worktree.
 */
const SAFE_GIT_ARGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor="];

function git(cwd: string, args: string[]): string {
	return execFileSync("git", [...SAFE_GIT_ARGS, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tryGit(cwd: string, args: string[]): string | undefined {
	try {
		return git(cwd, args);
	} catch {
		return undefined;
	}
}

/** Root of the git checkout containing `cwd`, or undefined when it is not inside one. */
export function gitRootOf(cwd: string): string | undefined {
	return tryGit(cwd, ["rev-parse", "--show-toplevel"]) || undefined;
}

function branchTip(gitRoot: string, branch: string): string | undefined {
	return tryGit(gitRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]) || undefined;
}

/** Undo a partially created worktree: deregister and delete it, and delete the branch we created. */
function removeWorktreeResidue(gitRoot: string, path: string, branch: string, branchExisted: boolean): void {
	tryGit(gitRoot, ["worktree", "remove", "--force", path]);
	try {
		rmSync(path, { recursive: true, force: true });
	} catch {
		// best effort
	}
	tryGit(gitRoot, ["worktree", "prune"]);
	if (!branchExisted) tryGit(gitRoot, ["branch", "-D", "--", branch]);
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
	const branchExisted = branchTip(gitRoot, branch) !== undefined;
	const pathExisted = existsSync(path);
	try {
		git(gitRoot, ["worktree", "add", "-b", branch, path, headCommit]);
	} catch (err) {
		const msg = (err as { stderr?: string }).stderr?.toString().trim() || (err as Error).message;
		// never leave a half-created worktree or branch behind (but never touch what was already there)
		if (!pathExisted) removeWorktreeResidue(gitRoot, path, branch, branchExisted);
		throw new Error(`Cannot create an agent worktree: ${msg}`);
	}
	const rel = relative(gitRoot, cwd);
	const sub = rel && !rel.startsWith("..") ? join(path, rel) : path;
	return { gitRoot, path, branch, headCommit, cwd: existsSync(sub) ? sub : path };
}

/**
 * Clean up after the agent, never deleting its work (as Claude Code):
 * - worktree with changes (tracked, staged or untracked — whatever `status.showUntrackedFiles`
 *   says) or with HEAD moved: kept, and its path and branch are returned for the result;
 * - otherwise the worktree is removed, and its branch too unless the agent committed to it (its tip
 *   moved, e.g. after committing and checking out a detached HEAD): then the branch is kept.
 */
export function finishAgentWorktree(w: AgentWorktree): WorktreeInfo | undefined {
	let dirty = true;
	try {
		const status = git(w.path, ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=dirty"]);
		const head = git(w.path, ["rev-parse", "HEAD"]);
		dirty = status !== "" || head !== w.headCommit;
	} catch {
		dirty = true;
	}
	if (dirty) return { worktreePath: w.path, worktreeBranch: w.branch };
	try {
		git(w.gitRoot, ["worktree", "remove", "--force", w.path]);
	} catch {
		return { worktreePath: w.path, worktreeBranch: w.branch };
	}
	// the branch holds no work only when it still points at the commit it was created at
	if (branchTip(w.gitRoot, w.branch) === w.headCommit) tryGit(w.gitRoot, ["branch", "-D", "--", w.branch]);
	return undefined;
}

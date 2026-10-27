import { join, relative } from "node:path";
import { HostCommandError, runHostCommand } from "../host/exec.js";
import type { ClaudeCodeHost } from "../host/types.js";
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

/** What the Agent tool reports when the host cannot create git worktrees (`host.supportsWorktrees`). */
export const WORKTREE_UNSUPPORTED =
	'isolation: "worktree" is not available: this session\'s host has no git worktrees, so the agent cannot get an isolated copy of the repository. Omit isolation to run the agent in the current directory.';

/**
 * Like Claude Code, worktree management never runs repository hooks or fsmonitor daemons: a failing
 * post-checkout hook must not fail (or half-create) the agent's worktree.
 */
const SAFE_GIT_ARGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor="];

/** Run git on the host; its trimmed stdout, or a HostCommandError (with `stderr`) when it fails. */
async function git(host: ClaudeCodeHost, cwd: string, args: string[]): Promise<string> {
	return (await runHostCommand(host, ["git", ...SAFE_GIT_ARGS, ...args], { cwd })).stdout.trim();
}

async function tryGit(host: ClaudeCodeHost, cwd: string, args: string[]): Promise<string | undefined> {
	try {
		return await git(host, cwd, args);
	} catch {
		return undefined;
	}
}

async function exists(host: ClaudeCodeHost, path: string): Promise<boolean> {
	try {
		await host.fs.stat(path);
		return true;
	} catch {
		return false;
	}
}

/** Root of the git checkout containing `cwd`, or undefined when it is not inside one. */
export async function gitRootOf(host: ClaudeCodeHost, cwd: string): Promise<string | undefined> {
	return (await tryGit(host, cwd, ["rev-parse", "--show-toplevel"])) || undefined;
}

async function branchTip(host: ClaudeCodeHost, gitRoot: string, branch: string): Promise<string | undefined> {
	return (await tryGit(host, gitRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`])) || undefined;
}

/** Undo a partially created worktree: deregister and delete it, and delete the branch we created. */
async function removeWorktreeResidue(host: ClaudeCodeHost, gitRoot: string, path: string, branch: string, branchExisted: boolean): Promise<void> {
	await tryGit(host, gitRoot, ["worktree", "remove", "--force", path]);
	try {
		await host.fs.rm(path, { recursive: true, force: true });
	} catch {
		// best effort
	}
	await tryGit(host, gitRoot, ["worktree", "prune"]);
	if (!branchExisted) await tryGit(host, gitRoot, ["branch", "-D", "--", branch]);
}

/** Create `<repo>/.claude/worktrees/agent-<id>` on a new branch `worktree-agent-<id>` at HEAD. */
export async function createAgentWorktree(host: ClaudeCodeHost, cwd: string, agentId: string): Promise<AgentWorktree> {
	if (!host.supportsWorktrees) throw new Error(WORKTREE_UNSUPPORTED);
	const gitRoot = await gitRootOf(host, cwd);
	if (!gitRoot) throw new Error(`Cannot create an agent worktree: ${cwd} is not inside a git repository. Omit isolation to run the agent in the current directory.`);
	let headCommit: string;
	try {
		headCommit = await git(host, gitRoot, ["rev-parse", "HEAD"]);
	} catch {
		throw new Error("Cannot create an agent worktree: the repository has no commits yet.");
	}
	const name = `agent-${agentId.replace(/^a/, "").slice(0, 8)}`;
	const dir = join(gitRoot, ".claude", "worktrees");
	await host.fs.mkdir(dir, { recursive: true });
	const path = join(dir, name);
	const branch = `worktree-${name}`;
	const branchExisted = (await branchTip(host, gitRoot, branch)) !== undefined;
	const pathExisted = await exists(host, path);
	try {
		await git(host, gitRoot, ["worktree", "add", "-b", branch, path, headCommit]);
	} catch (err) {
		const msg = (err instanceof HostCommandError ? err.stderr.trim() : "") || (err as Error).message;
		// never leave a half-created worktree or branch behind (but never touch what was already there)
		if (!pathExisted) await removeWorktreeResidue(host, gitRoot, path, branch, branchExisted);
		throw new Error(`Cannot create an agent worktree: ${msg}`);
	}
	const rel = relative(gitRoot, cwd);
	const sub = rel && !rel.startsWith("..") ? join(path, rel) : path;
	return { gitRoot, path, branch, headCommit, cwd: (await exists(host, sub)) ? sub : path };
}

/**
 * Clean up after the agent, never deleting its work (as Claude Code):
 * - worktree with changes (tracked, staged or untracked — whatever `status.showUntrackedFiles`
 *   says) or with HEAD moved: kept, and its path and branch are returned for the result;
 * - otherwise the worktree is removed, and its branch too unless the agent committed to it (its tip
 *   moved, e.g. after committing and checking out a detached HEAD): then the branch is kept.
 */
export async function finishAgentWorktree(host: ClaudeCodeHost, w: AgentWorktree): Promise<WorktreeInfo | undefined> {
	let dirty = true;
	try {
		const status = await git(host, w.path, ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=dirty"]);
		const head = await git(host, w.path, ["rev-parse", "HEAD"]);
		dirty = status !== "" || head !== w.headCommit;
	} catch {
		dirty = true;
	}
	if (dirty) return { worktreePath: w.path, worktreeBranch: w.branch };
	try {
		await git(host, w.gitRoot, ["worktree", "remove", "--force", w.path]);
	} catch {
		return { worktreePath: w.path, worktreeBranch: w.branch };
	}
	// the branch holds no work only when it still points at the commit it was created at
	if ((await branchTip(host, w.gitRoot, w.branch)) === w.headCommit) await tryGit(host, w.gitRoot, ["branch", "-D", "--", w.branch]);
	return undefined;
}

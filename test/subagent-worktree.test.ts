import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentWorktree, finishAgentWorktree } from "../src/subagent/worktree.js";
import { tempDir } from "./helpers.js";

/* Worktree isolation cleanup (docs/review-2026-10-18.md #4a, #4b, #20): never delete the agent's work. */

function repo(setup?: (git: (...args: string[]) => string, dir: string) => void) {
	const dir = tempDir("pi-cc-wt-");
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8", stdio: "pipe" }).trim();
	git("init", "-q");
	writeFileSync(join(dir, "a.txt"), "a\n");
	git("add", ".");
	git("commit", "-qm", "init");
	setup?.(git, dir);
	return { dir, git };
}

const worktrees = (git: (...a: string[]) => string) => git("worktree", "list").split("\n").filter(Boolean).length;
const agentBranches = (git: (...a: string[]) => string) => git("branch", "--list", "worktree-*").split("\n").filter(Boolean).length;

describe("agent worktree cleanup", () => {
	it("removes an untouched worktree and its branch", () => {
		const { dir, git } = repo();
		const w = createAgentWorktree(dir, "a1111111122222222");
		expect(finishAgentWorktree(w)).toBeUndefined();
		expect(existsSync(w.path)).toBe(false);
		expect(worktrees(git)).toBe(1);
		expect(agentBranches(git)).toBe(0);
	});

	it("#4a: keeps a worktree with untracked files even when status.showUntrackedFiles=no", () => {
		const { dir, git } = repo((g) => g("config", "status.showUntrackedFiles", "no"));
		const w = createAgentWorktree(dir, "a1111111122222222");
		writeFileSync(join(w.path, "RESULT.txt"), "result\n");
		expect(finishAgentWorktree(w)).toEqual({ worktreePath: w.path, worktreeBranch: w.branch });
		expect(readFileSync(join(w.path, "RESULT.txt"), "utf8")).toBe("result\n");
		expect(worktrees(git)).toBe(2);
		expect(agentBranches(git)).toBe(1);
	});

	it("#4a: keeps a worktree with untracked files in a new directory", () => {
		const { dir } = repo((g) => g("config", "status.showUntrackedFiles", "no"));
		const w = createAgentWorktree(dir, "a1111111122222222");
		execFileSync("mkdir", ["-p", join(w.path, "out", "deep")]);
		writeFileSync(join(w.path, "out", "deep", "r.txt"), "r\n");
		expect(finishAgentWorktree(w)?.worktreePath).toBe(w.path);
	});

	it("#4b: keeps the branch when the agent committed to it and then detached HEAD back (like Claude Code)", () => {
		const { dir, git } = repo();
		const w = createAgentWorktree(dir, "a1111111122222222");
		const wgit = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: w.path, stdio: "pipe" });
		writeFileSync(join(w.path, "RESULT.txt"), "result\n");
		wgit("add", "RESULT.txt");
		wgit("commit", "-qm", "work");
		const work = git("rev-parse", `refs/heads/${w.branch}`);
		wgit("checkout", "-q", "--detach", "HEAD~1");
		// Claude Code removes the clean worktree, keeps the branch and reports nothing
		expect(finishAgentWorktree(w)).toBeUndefined();
		expect(existsSync(w.path)).toBe(false);
		expect(worktrees(git)).toBe(1);
		expect(git("rev-parse", `refs/heads/${w.branch}`)).toBe(work);
		expect(git("show", `${work}:RESULT.txt`)).toBe("result");
	});

	it("#4b: keeps worktree and branch when HEAD moved to a new commit", () => {
		const { dir, git } = repo();
		const w = createAgentWorktree(dir, "a1111111122222222");
		writeFileSync(join(w.path, "RESULT.txt"), "result\n");
		execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "x", "--allow-empty"], { cwd: w.path, stdio: "pipe" });
		expect(finishAgentWorktree(w)).toEqual({ worktreePath: w.path, worktreeBranch: w.branch });
		expect(agentBranches(git)).toBe(1);
	});

	it("#20: a failing post-checkout hook does not fail the worktree (hooks are not run, like Claude Code)", () => {
		const { dir, git } = repo((_g, d) => {
			const hook = join(d, ".git", "hooks", "post-checkout");
			writeFileSync(hook, "#!/bin/sh\necho hookfail >&2\nexit 1\n");
			chmodSync(hook, 0o755);
		});
		const w = createAgentWorktree(dir, "a1111111122222222");
		expect(readFileSync(join(w.path, "a.txt"), "utf8")).toBe("a\n");
		expect(finishAgentWorktree(w)).toBeUndefined();
		expect(existsSync(w.path)).toBe(false);
		expect(worktrees(git)).toBe(1);
		expect(agentBranches(git)).toBe(0);
	});

	it("#20: a genuine checkout failure leaves no directory, worktree registration or branch behind", () => {
		const { dir, git } = repo((g, d) => {
			// a required smudge filter that fails: `worktree add` registers the worktree, then checkout fails
			writeFileSync(join(d, ".gitattributes"), "*.txt filter=broken\n");
			g("add", ".gitattributes");
			g("commit", "-qm", "attrs");
			g("config", "filter.broken.smudge", "false");
			g("config", "filter.broken.required", "true");
		});
		expect(() => createAgentWorktree(dir, "a1111111122222222")).toThrow(/Cannot create an agent worktree/);
		expect(existsSync(join(dir, ".claude", "worktrees", "agent-11111111"))).toBe(false);
		expect(worktrees(git)).toBe(1);
		expect(agentBranches(git)).toBe(0);
	});

	it("#20: a failure never deletes a pre-existing branch of the same name", () => {
		const { dir, git } = repo((g) => g("branch", "worktree-agent-11111111"));
		expect(() => createAgentWorktree(dir, "a1111111122222222")).toThrow(/already exists/);
		expect(agentBranches(git)).toBe(1);
	});
});

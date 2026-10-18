import { execFileSync } from "node:child_process";
import { existsSync, symlinkSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/** Repository root of this package; relative fixture repos resolve against it. */
const REPO_ROOT = resolve(import.meta.dirname, "..");

export interface GitFixture {
	/** Repository to snapshot (absolute, or relative to this package's root, e.g. "."). */
	repo: string;
	/** Commit (or ref) exported with `git archive`. */
	commit: string;
	/** Symlink <repo>/node_modules into the workspace so tests can run. Default true. */
	linkNodeModules?: boolean;
}

const FIXED_DATE = "2026-01-01T00:00:00Z";

/** Recreate a repository snapshot as a fresh git repo with a deterministic single commit. */
export function materializeFixture(f: GitFixture, cwd: string): void {
	const repo = isAbsolute(f.repo) ? f.repo : resolve(REPO_ROOT, f.repo);
	const archive = execFileSync("git", ["-C", repo, "archive", f.commit], { maxBuffer: 512 * 1024 * 1024 });
	execFileSync("tar", ["-x", "-C", cwd], { input: archive });
	if (f.linkNodeModules !== false && existsSync(join(repo, "node_modules"))) symlinkSync(join(repo, "node_modules"), join(cwd, "node_modules"));
	const env = { ...process.env, GIT_AUTHOR_NAME: "parity", GIT_AUTHOR_EMAIL: "parity@example.com", GIT_COMMITTER_NAME: "parity", GIT_COMMITTER_EMAIL: "parity@example.com", GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE };
	const git = (...args: string[]) => execFileSync("git", args, { cwd, env, stdio: "ignore" });
	git("init", "-q", "-b", "main");
	git("add", "-A");
	git("commit", "-q", "-m", `snapshot of ${f.commit}`);
}

export function resolveCommit(repo: string, ref: string): string {
	return execFileSync("git", ["-C", repo, "rev-parse", ref], { encoding: "utf8" }).trim();
}

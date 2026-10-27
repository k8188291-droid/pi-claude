/**
 * The `ClaudeCodeHost` contract as a reusable suite: `describeHostContract(name, makeHost)` runs the
 * same checks against any host (memory host, local host, ...). Every host method is exercised,
 * including the Node-style error codes the tools branch on.
 *
 * Grep's real argument vectors (`buildRgArgs`) and output parsers are used for `search.ripgrep`, so
 * this also pins what Grep needs from a host's ripgrep.
 */
import { posix } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClaudeCodeHost, HostProcessExit } from "../src/host/types.js";
import { buildRgArgs, type GrepParams, parseRgJson, splitNullOutput } from "../src/tools/grep.js";

export interface HostFixture {
	host: ClaudeCodeHost;
	/** An existing, empty, writable directory on the host (absolute). */
	root: string;
	/** Create a symbolic link on the host (the contract itself has no method for it). */
	symlink(target: string, path: string): Promise<void>;
	cleanup?(): Promise<void>;
}

const text = (b: Uint8Array) => new TextDecoder().decode(b);

async function code(p: Promise<unknown>): Promise<string | undefined> {
	try {
		await p;
	} catch (err) {
		return (err as { code?: string }).code;
	}
	throw new Error("expected a rejection");
}

export interface RunResult {
	stdout: string;
	stderr: string;
	exit: HostProcessExit;
}

export async function runOnHost(host: ClaudeCodeHost, command: string, opts: { cwd: string; env?: Record<string, string>; signal?: AbortSignal }): Promise<RunResult> {
	const proc = host.shell.spawn(command, { cwd: opts.cwd, env: { ...host.env, ...opts.env }, signal: opts.signal });
	let stdout = "";
	let stderr = "";
	proc.onStdout((c) => (stdout += c));
	proc.onStderr((c) => (stderr += c));
	const exit = await proc.exited;
	return { stdout, stderr, exit };
}

export function describeHostContract(name: string, makeHost: () => Promise<HostFixture>): void {
	describe(`ClaudeCodeHost contract: ${name}`, () => {
		let fx: HostFixture;
		let host: ClaudeCodeHost;
		let root: string;
		const p = (...parts: string[]) => posix.join(root, ...parts);

		beforeEach(async () => {
			fx = await makeHost();
			host = fx.host;
			root = fx.root;
		});
		afterEach(async () => {
			await fx.cleanup?.();
		});

		describe("host fields", () => {
			it("tmpDir and homeDir are existing directories; env and supportsWorktrees are set", async () => {
				expect((await host.fs.stat(host.tmpDir)).isDirectory).toBe(true);
				expect((await host.fs.stat(host.homeDir)).isDirectory).toBe(true);
				expect(typeof host.env).toBe("object");
				expect(typeof host.env.PATH).toBe("string");
				expect(typeof host.supportsWorktrees).toBe("boolean");
			});
		});

		describe("fs: files", () => {
			it("writeFile/readFile round-trip text and binary bytes", async () => {
				await host.fs.writeFile(p("t.txt"), "héllo\n");
				expect(text(await host.fs.readFile(p("t.txt")))).toBe("héllo\n");
				const bytes = new Uint8Array([0, 1, 2, 127, 128, 255]);
				await host.fs.writeFile(p("b.bin"), bytes);
				expect([...(await host.fs.readFile(p("b.bin")))]).toEqual([...bytes]);
			});

			it("readFile returns a copy and writeFile keeps none of the caller's buffer", async () => {
				const bytes = new Uint8Array([1, 2, 3]);
				await host.fs.writeFile(p("c.bin"), bytes);
				bytes[0] = 9;
				const read = await host.fs.readFile(p("c.bin"));
				read[1] = 9;
				expect([...(await host.fs.readFile(p("c.bin")))]).toEqual([1, 2, 3]);
			});

			it("writeFile truncates, applies mode only on create; appendFile appends or creates", async () => {
				await host.fs.writeFile(p("m.txt"), "long content", { mode: 0o600 });
				expect((await host.fs.stat(p("m.txt"))).mode).toBe(0o600);
				await host.fs.chmod(p("m.txt"), 0o640);
				await host.fs.writeFile(p("m.txt"), "short", { mode: 0o600 });
				expect(text(await host.fs.readFile(p("m.txt")))).toBe("short");
				expect((await host.fs.stat(p("m.txt"))).mode).toBe(0o640);
				await host.fs.appendFile(p("m.txt"), "+more");
				expect(text(await host.fs.readFile(p("m.txt")))).toBe("short+more");
				expect((await host.fs.stat(p("m.txt"))).mode).toBe(0o640);
				await host.fs.appendFile(p("new.txt"), new TextEncoder().encode("x"), { mode: 0o600 });
				expect(text(await host.fs.readFile(p("new.txt")))).toBe("x");
				expect((await host.fs.stat(p("new.txt"))).mode).toBe(0o600);
			});

			it("readRange returns the range, fewer bytes at EOF, none past it", async () => {
				await host.fs.writeFile(p("r.txt"), "0123456789");
				expect(text(await host.fs.readRange(p("r.txt"), 2, 3))).toBe("234");
				expect(text(await host.fs.readRange(p("r.txt"), 8, 10))).toBe("89");
				expect((await host.fs.readRange(p("r.txt"), 20, 5)).length).toBe(0);
				expect((await host.fs.readRange(p("r.txt"), 0, 0)).length).toBe(0);
			});

			it("file errors: ENOENT, ENOTDIR, EISDIR", async () => {
				await host.fs.writeFile(p("f"), "x");
				await host.fs.mkdir(p("d"));
				expect(await code(host.fs.readFile(p("missing")))).toBe("ENOENT");
				expect(await code(host.fs.readFile(p("f", "x")))).toBe("ENOTDIR");
				expect(await code(host.fs.readFile(p("d")))).toBe("EISDIR");
				expect(await code(host.fs.readRange(p("missing"), 0, 1))).toBe("ENOENT");
				expect(await code(host.fs.readRange(p("d"), 0, 1))).toBe("EISDIR");
				expect(await code(host.fs.writeFile(p("nodir", "a"), "x"))).toBe("ENOENT");
				expect(await code(host.fs.writeFile(p("f", "a"), "x"))).toBe("ENOTDIR");
				expect(await code(host.fs.writeFile(p("d"), "x"))).toBe("EISDIR");
				expect(await code(host.fs.appendFile(p("d"), "x"))).toBe("EISDIR");
				expect(await code(host.fs.appendFile(p("nodir", "a"), "x"))).toBe("ENOENT");
				// nothing was created or replaced by the failed calls
				expect((await host.fs.stat(p("d"))).isDirectory).toBe(true);
				expect(await code(host.fs.stat(p("nodir")))).toBe("ENOENT");
			});

			it("an aborted signal rejects reads", async () => {
				await host.fs.writeFile(p("s.txt"), "x");
				const ac = new AbortController();
				ac.abort();
				await expect(host.fs.readFile(p("s.txt"), { signal: ac.signal })).rejects.toMatchObject({ name: "AbortError" });
				await expect(host.fs.readRange(p("s.txt"), 0, 1, { signal: ac.signal })).rejects.toMatchObject({ name: "AbortError" });
			});
		});

		describe("fs: stat, lstat, realpath, symlinks", () => {
			it("stat reports kind, size, mtime and mode; isSpecial is false for regular entries", async () => {
				await host.fs.writeFile(p("s.txt"), "12345");
				const st = await host.fs.stat(p("s.txt"));
				expect(st).toMatchObject({ isFile: true, isDirectory: false, isSymbolicLink: false, isSpecial: false, size: 5 });
				expect(st.mtimeMs).toBeGreaterThan(0);
				expect(st.mode & ~0o7777).toBe(0);
				const dst = await host.fs.stat(root);
				expect(dst).toMatchObject({ isFile: false, isDirectory: true, isSpecial: false });
			});

			it("stat follows symlinks, lstat does not, realpath resolves them", async () => {
				await host.fs.mkdir(p("real"));
				await host.fs.writeFile(p("real", "f.txt"), "abc");
				await fx.symlink(p("real", "f.txt"), p("link.txt"));
				await fx.symlink("real", p("dirlink"));
				expect(await host.fs.stat(p("link.txt"))).toMatchObject({ isFile: true, isSymbolicLink: false, size: 3 });
				expect(await host.fs.lstat(p("link.txt"))).toMatchObject({ isFile: false, isSymbolicLink: true });
				const realRoot = await host.fs.realpath(root);
				expect(await host.fs.realpath(p("link.txt"))).toBe(posix.join(realRoot, "real", "f.txt"));
				expect(await host.fs.realpath(p("dirlink", "f.txt"))).toBe(posix.join(realRoot, "real", "f.txt"));
				expect(text(await host.fs.readFile(p("dirlink", "f.txt")))).toBe("abc");
				// writing through a symlink writes the target
				await host.fs.writeFile(p("link.txt"), "new");
				expect(text(await host.fs.readFile(p("real", "f.txt")))).toBe("new");
				expect((await host.fs.lstat(p("link.txt"))).isSymbolicLink).toBe(true);
			});

			it("stat errors: ENOENT, ENOTDIR, ELOOP", async () => {
				await host.fs.writeFile(p("f"), "x");
				expect(await code(host.fs.stat(p("missing")))).toBe("ENOENT");
				expect(await code(host.fs.lstat(p("missing")))).toBe("ENOENT");
				expect(await code(host.fs.realpath(p("missing")))).toBe("ENOENT");
				expect(await code(host.fs.stat(p("f", "x")))).toBe("ENOTDIR");
				await fx.symlink(p("loop2"), p("loop1"));
				await fx.symlink(p("loop1"), p("loop2"));
				expect(await code(host.fs.stat(p("loop1")))).toBe("ELOOP");
				expect(await code(host.fs.readFile(p("loop1")))).toBe("ELOOP");
			});
		});

		describe("fs: directories", () => {
			it("mkdir creates, with mode; recursive creates parents and accepts an existing directory", async () => {
				await host.fs.mkdir(p("a"), { mode: 0o700 });
				expect((await host.fs.stat(p("a"))).mode).toBe(0o700);
				await host.fs.mkdir(p("x", "y", "z"), { recursive: true });
				expect((await host.fs.stat(p("x", "y", "z"))).isDirectory).toBe(true);
				await host.fs.mkdir(p("x", "y"), { recursive: true });
			});

			it("mkdir errors: EEXIST, ENOENT, ENOTDIR", async () => {
				await host.fs.mkdir(p("a"));
				await host.fs.writeFile(p("f"), "x");
				expect(await code(host.fs.mkdir(p("a")))).toBe("EEXIST");
				expect(await code(host.fs.mkdir(p("f")))).toBe("EEXIST");
				expect(await code(host.fs.mkdir(p("f"), { recursive: true }))).toBe("EEXIST");
				expect(await code(host.fs.mkdir(p("no", "parent")))).toBe("ENOENT");
				expect(await code(host.fs.mkdir(p("f", "sub"), { recursive: true }))).toBe("ENOTDIR");
				expect((await host.fs.stat(p("f"))).isFile).toBe(true);
			});

			it("readdir lists names with types, symlinks unresolved", async () => {
				await host.fs.mkdir(p("d"));
				await host.fs.writeFile(p("f.txt"), "x");
				await fx.symlink("f.txt", p("l"));
				const entries = (await host.fs.readdir(root)).sort((a, b) => (a.name < b.name ? -1 : 1));
				expect(entries).toEqual([
					{ name: "d", isFile: false, isDirectory: true, isSymbolicLink: false },
					{ name: "f.txt", isFile: true, isDirectory: false, isSymbolicLink: false },
					{ name: "l", isFile: false, isDirectory: false, isSymbolicLink: true },
				]);
				expect(await code(host.fs.readdir(p("missing")))).toBe("ENOENT");
				expect(await code(host.fs.readdir(p("f.txt")))).toBe("ENOTDIR");
			});

			it("rm removes files, links (not targets) and trees; errors ENOENT and EISDIR", async () => {
				await host.fs.writeFile(p("f"), "x");
				await host.fs.rm(p("f"));
				expect(await code(host.fs.stat(p("f")))).toBe("ENOENT");
				expect(await code(host.fs.rm(p("f")))).toBe("ENOENT");
				await host.fs.rm(p("f"), { force: true });
				await host.fs.writeFile(p("t"), "x");
				await fx.symlink("t", p("l"));
				await host.fs.rm(p("l"));
				expect(text(await host.fs.readFile(p("t")))).toBe("x");
				await host.fs.mkdir(p("tree", "sub"), { recursive: true });
				await host.fs.writeFile(p("tree", "sub", "f"), "x");
				expect(await code(host.fs.rm(p("tree")))).toBe("EISDIR");
				await host.fs.rm(p("tree"), { recursive: true });
				expect(await code(host.fs.stat(p("tree")))).toBe("ENOENT");
			});

			it("chmod sets permission bits (through symlinks); ENOENT when missing", async () => {
				await host.fs.writeFile(p("f"), "x");
				await host.fs.chmod(p("f"), 0o751);
				expect((await host.fs.stat(p("f"))).mode).toBe(0o751);
				await fx.symlink("f", p("l"));
				await host.fs.chmod(p("l"), 0o600);
				expect((await host.fs.stat(p("f"))).mode).toBe(0o600);
				expect(await code(host.fs.chmod(p("missing"), 0o600))).toBe("ENOENT");
			});
		});

		describe("shell", () => {
			it("runs a command string with cwd and env, delivering stdout, stderr and the exit code", async () => {
				await host.fs.mkdir(p("sub"));
				const r = await runOnHost(host, 'pwd; echo "v=$FOO"; echo err >&2; exit 3', { cwd: p("sub"), env: { FOO: "bar" } });
				const [pwd, rest] = [r.stdout.slice(0, r.stdout.indexOf("\n")), r.stdout.slice(r.stdout.indexOf("\n") + 1)];
				expect([p("sub"), await host.fs.realpath(p("sub"))]).toContain(pwd);
				expect(rest).toBe("v=bar\n");
				expect(r.stderr).toBe("err\n");
				expect(r.exit).toEqual({ exitCode: 3, signal: null });
			});

			it("shares the filesystem with host.fs", async () => {
				await host.fs.writeFile(p("in.txt"), "from fs\n");
				const r = await runOnHost(host, "cat in.txt; printf 'from shell' > out.txt", { cwd: root });
				expect(r.stdout).toBe("from fs\n");
				expect(text(await host.fs.readFile(p("out.txt")))).toBe("from shell");
			});

			it("delivers all output before exited resolves; late listeners still get it", async () => {
				const proc = host.shell.spawn("echo one; echo two", { cwd: root, env: host.env });
				let out = "";
				proc.onStdout((c) => (out += c));
				await proc.exited;
				expect(out).toBe("one\ntwo\n");
				let late = "";
				proc.onStdout((c) => (late += c));
				expect(late === "" || late === "one\ntwo\n").toBe(true);
			});

			it("kill() ends the command (idempotent) and reports a signal", async () => {
				const proc = host.shell.spawn("sleep 30; echo never", { cwd: root, env: host.env });
				let out = "";
				proc.onStdout((c) => (out += c));
				setTimeout(() => {
					proc.kill();
					proc.kill();
				}, 50);
				const started = Date.now();
				const exit = await proc.exited;
				expect(Date.now() - started).toBeLessThan(10_000);
				expect(exit.exitCode).toBeNull();
				expect(exit.signal).toBeTruthy();
				expect(out).toBe("");
				proc.kill();
			});

			it("an aborted signal ends the command", async () => {
				const ac = new AbortController();
				setTimeout(() => ac.abort(), 50);
				const r = await runOnHost(host, "sleep 30", { cwd: root, signal: ac.signal });
				expect(r.exit.exitCode).toBeNull();
				expect(r.exit.signal).toBeTruthy();
			});

			it("concurrent commands keep their own cwd, env and shell state", async () => {
				await host.fs.mkdir(p("a"));
				await host.fs.mkdir(p("b"));
				const [x, y] = await Promise.all([
					runOnHost(host, 'export V=one; sleep 0.2; cd ../b; echo "$V $(basename "$PWD") $W"', { cwd: p("a"), env: { W: "x" } }),
					runOnHost(host, 'sleep 0.05; export V=two; cd ../a; sleep 0.2; echo "$V $(basename "$PWD") $W"', { cwd: p("b"), env: { W: "y" } }),
				]);
				expect(x.stdout).toBe("one b x\n");
				expect(y.stdout).toBe("two a y\n");
			});
		});

		describe("search.ripgrep (with Grep's argument vectors)", () => {
			const grep = async (params: GrepParams) => {
				const mode = params.output_mode ?? "files_with_matches";
				const r = await host.search.ripgrep(buildRgArgs(params, "."), { cwd: root });
				const lines = r.stdout === "" ? [] : r.stdout.replace(/\n$/, "").split("\n");
				const strip = (s: string) => s.replace(/^\.\//, "");
				const out =
					mode === "content"
						? parseRgJson(lines, { contextBreaks: [params["-C"], params["-A"], params["-B"]].some((v) => (v ?? 0) > 0), onlyMatching: params["-o"] === true }).map(strip)
						: splitNullOutput(lines, mode).map(strip).sort();
				return { out, exitCode: r.exitCode, stderr: r.stderr };
			};

			beforeEach(async () => {
				await host.fs.mkdir(p("src"), { recursive: true });
				await host.fs.mkdir(p(".hidden"));
				await host.fs.mkdir(p(".git"));
				await host.fs.mkdir(p(".jj"));
				await host.fs.writeFile(p("a.ts"), "const Foo = 1;\nfoo bar\n");
				await host.fs.writeFile(p("src", "b.ts"), "import x\nfunction foo() {}\n");
				await host.fs.writeFile(p("src", "c.js"), "one\ntwo\nfoo three\nfour\nfive\nsix\nfoo seven\n");
				await host.fs.writeFile(p(".hidden", "h.txt"), "foo hidden\n");
				await host.fs.writeFile(p(".git", "config"), "foo in git\n");
				await host.fs.writeFile(p(".jj", "repo"), "foo in jj\n");
				await host.fs.writeFile(p("multi.txt"), "start\nmiddle\nend\n");
				await host.fs.writeFile(p("-dash.txt"), "-x marks\n");
			});

			it("files_with_matches: case-sensitive by default, hidden files in, VCS directories out", async () => {
				expect(await grep({ pattern: "foo" })).toEqual({ out: [".hidden/h.txt", "a.ts", "src/b.ts", "src/c.js"], exitCode: 0, stderr: "" });
				expect((await grep({ pattern: "FOO" })).out).toEqual([]);
				expect((await grep({ pattern: "FOO", "-i": true })).out).toEqual([".hidden/h.txt", "a.ts", "src/b.ts", "src/c.js"]);
			});

			it("no match exits 1", async () => {
				expect(await grep({ pattern: "zzz-nothing" })).toEqual({ out: [], exitCode: 1, stderr: "" });
			});

			it("count", async () => {
				expect((await grep({ pattern: "foo", output_mode: "count" })).out).toEqual([".hidden/h.txt:1", "a.ts:1", "src/b.ts:1", "src/c.js:2"]);
			});

			it("content with line numbers, -o, and context (-C, -A/-B)", async () => {
				expect((await grep({ pattern: "foo", output_mode: "content", path: undefined, glob: "*.js" })).out).toEqual(["src/c.js\u00003:foo three", "src/c.js\u00007:foo seven"]);
				expect((await grep({ pattern: "fo+", output_mode: "content", "-o": true, glob: "a.ts" })).out).toEqual(["a.ts\u00002:foo"]);
				expect((await grep({ pattern: "foo", output_mode: "content", glob: "*.js", "-C": 1 })).out).toEqual([
					"src/c.js\u00002-two",
					"src/c.js\u00003:foo three",
					"src/c.js\u00004-four",
					"--",
					"src/c.js\u00006-six",
					"src/c.js\u00007:foo seven",
				]);
				expect((await grep({ pattern: "foo three", output_mode: "content", "-A": 2, "-B": 1 })).out).toEqual([
					"src/c.js\u00002-two",
					"src/c.js\u00003:foo three",
					"src/c.js\u00004-four",
					"src/c.js\u00005-five",
				]);
			});

			it("multiline (-U --multiline-dotall)", async () => {
				expect((await grep({ pattern: "start.middle", output_mode: "content", multiline: true })).out).toEqual(["multi.txt\u00001:start", "multi.txt\u00002:middle"]);
				expect((await grep({ pattern: "start.middle", multiline: true })).out).toEqual(["multi.txt"]);
				expect((await grep({ pattern: "start.middle" })).out).toEqual([]);
			});

			it("--type and --glob (including brace sets and exclusions)", async () => {
				expect((await grep({ pattern: "foo", type: "ts" })).out).toEqual(["a.ts", "src/b.ts"]);
				expect((await grep({ pattern: "foo", glob: "*.{js,txt}" })).out).toEqual([".hidden/h.txt", "src/c.js"]);
				expect((await grep({ pattern: "foo", glob: "!src" })).out).toEqual([".hidden/h.txt", "a.ts"]);
			});

			it("patterns starting with '-' (passed with -e)", async () => {
				expect((await grep({ pattern: "-x", output_mode: "content" })).out).toEqual(["-dash.txt\u00001:-x marks"]);
			});

			it("usage errors exit 2 with ripgrep's wording", async () => {
				const bad = await grep({ pattern: "foo(" });
				expect(bad.exitCode).toBe(2);
				expect(bad.stderr).toMatch(/^rg: regex parse error/m);
				const type = await grep({ pattern: "foo", type: "no-such-type" });
				expect(type.exitCode).toBe(2);
				expect(type.stderr).toMatch(/^rg: unrecognized file type/m);
				const glob = await grep({ pattern: "foo", glob: "[" });
				expect(glob.exitCode).toBe(2);
				expect(glob.stderr).toMatch(/^rg: error parsing glob/m);
			});

			it("searches a single file given by absolute path", async () => {
				const r = await host.search.ripgrep(buildRgArgs({ pattern: "foo", output_mode: "content" }, p("src", "c.js")), { cwd: p("src") });
				const out = parseRgJson(r.stdout.replace(/\n$/, "").split("\n"), { contextBreaks: false, onlyMatching: false });
				expect(out).toEqual([`${p("src", "c.js")}\u00003:foo three`, `${p("src", "c.js")}\u00007:foo seven`]);
			});

			it("rejects when the signal is already aborted", async () => {
				const ac = new AbortController();
				ac.abort();
				await expect(host.search.ripgrep(buildRgArgs({ pattern: "foo" }, "."), { cwd: root, signal: ac.signal })).rejects.toThrow();
			});
		});

		describe("search.glob (rg --files --glob semantics)", () => {
			beforeEach(async () => {
				for (const f of ["a.ts", ".dot.ts", "src/b.ts", "src/sub/c.ts", "src/d.js", "node_modules/m/i.js", ".hid/h.ts", "x/src/e.ts"]) {
					await host.fs.mkdir(posix.dirname(p(f)), { recursive: true });
					await host.fs.writeFile(p(f), "");
				}
				await fx.symlink("a.ts", p("link.ts"));
			});
			const glob = async (pattern: string) => (await host.search.glob(pattern, { cwd: root })).map((m) => posix.relative(root, m.path)).sort();

			it("returns absolute paths of files with their mtimes", async () => {
				const all = await host.search.glob("**/*.ts", { cwd: root });
				for (const m of all) {
					expect(posix.isAbsolute(m.path)).toBe(true);
					expect(m.mtimeMs).toBeGreaterThan(0);
				}
			});

			it("matches like ripgrep: basename patterns at any depth, slash patterns anchored, dotfiles and node_modules in, symlinks and directories out", async () => {
				expect(await glob("*.ts")).toEqual([".dot.ts", ".hid/h.ts", "a.ts", "src/b.ts", "src/sub/c.ts", "x/src/e.ts"]);
				expect(await glob("src/*.ts")).toEqual(["src/b.ts"]);
				expect(await glob("**/src/*.ts")).toEqual(["src/b.ts", "x/src/e.ts"]);
				expect(await glob("/a.ts")).toEqual(["a.ts"]);
				expect(await glob("*.{ts,js}")).toHaveLength(8);
				expect(await glob("**/*.js")).toEqual(["node_modules/m/i.js", "src/d.js"]);
				expect(await glob("src")).toEqual([]);
				expect(await glob("src/**")).toEqual(["src/b.ts", "src/d.js", "src/sub/c.ts"]);
				expect(await glob("!*.ts")).toEqual(["node_modules/m/i.js", "src/d.js"]);
			});

			it("rejects when the signal is already aborted", async () => {
				const ac = new AbortController();
				ac.abort();
				await expect(host.search.glob("*", { cwd: root, signal: ac.signal })).rejects.toThrow();
			});
		});
	});
}

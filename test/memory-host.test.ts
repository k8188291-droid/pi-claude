import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createMemoryHost } from "../src/memory/host.js";
import { adaptGlob, eventsFromPlain, parseRgArgs } from "../src/memory/ripgrep.js";
import { buildRgArgs, parseRgJson } from "../src/tools/grep.js";
import { outsidePackages, recordHostFs } from "./fs-spy.js";
import { describeHostContract, runOnHost } from "./host-contract.js";

describeHostContract("memory host", async () => {
	const host = await createMemoryHost();
	const root = "/workspace/contract";
	await host.fs.mkdir(root, { recursive: true });
	return { host, root, symlink: (target, path) => host.vfs.symlink(target, path) };
});

describe("memory host specifics", () => {
	it("defaults: cwd, tmp and home directories, environment, no worktrees", async () => {
		const host = await createMemoryHost();
		expect(host.cwd).toBe("/workspace");
		expect(host.tmpDir).toBe("/tmp");
		expect(host.homeDir).toBe("/home/agent");
		expect(host.env).toMatchObject({ HOME: "/home/agent", TMPDIR: "/tmp", PATH: "/usr/bin:/bin" });
		expect(host.supportsWorktrees).toBe(false);
		for (const d of ["/workspace", "/tmp", "/home/agent"]) expect((await host.fs.stat(d)).isDirectory).toBe(true);
	});

	it("shares an InMemoryFs passed in and respects the byte cap of one it creates", async () => {
		const host = await createMemoryHost({ maxFileSystemBytes: 64 * 1024 });
		const other = await createMemoryHost({ fs: host.vfs });
		await host.fs.writeFile("/workspace/shared.txt", "x");
		expect(new TextDecoder().decode(await other.fs.readFile("/workspace/shared.txt"))).toBe("x");
		await expect(host.fs.writeFile("/workspace/big", new Uint8Array(128 * 1024))).rejects.toMatchObject({ code: "ENOSPC" });
	});

	it("output is delivered once, when the command ends (just-bash does not stream)", async () => {
		const host = await createMemoryHost();
		const proc = host.shell.spawn("echo a; sleep 0.05; echo b", { cwd: "/workspace", env: host.env });
		const chunks: string[] = [];
		proc.onStdout((c) => chunks.push(c));
		await proc.exited;
		expect(chunks).toEqual(["a\nb\n"]);
	});

	it("a busy loop is ended by the execution limits", async () => {
		const host = await createMemoryHost({ executionLimits: { maxLoopIterations: 1000 } });
		const r = await runOnHost(host, "while :; do :; done; echo unreachable", { cwd: "/workspace" });
		expect(r.exit.exitCode).not.toBe(0);
		expect(r.stdout).toBe("");
	});

	it("network, python and javascript are off by default", async () => {
		const host = await createMemoryHost();
		for (const cmd of ["curl -s http://example.com", "python3 -c 1", "js-exec -c 1"]) {
			const r = await runOnHost(host, cmd, { cwd: "/workspace" });
			expect(r.exit.exitCode).toBe(127);
		}
	});

	it("a host-supplied fetch serves virtual HTTP APIs to curl", async () => {
		const seen: string[] = [];
		const host = await createMemoryHost({
			fetch: async (url) => {
				seen.push(url);
				return { status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: new TextEncoder().encode('{"ok":true}'), url };
			},
		});
		const r = await runOnHost(host, "curl -s https://api.internal/v1/items", { cwd: "/workspace" });
		expect(r.stdout).toBe('{"ok":true}');
		expect(seen).toEqual(["https://api.internal/v1/items"]);
	});

	it("binary command output is decoded as UTF-8 text", async () => {
		const host = await createMemoryHost();
		await host.fs.writeFile("/workspace/u.txt", "héllo ✓\n");
		const r = await runOnHost(host, "cat u.txt", { cwd: "/workspace" });
		expect(r.stdout).toBe("héllo ✓\n");
	});

	it("scripts run as written (heredoc indentation kept)", async () => {
		const host = await createMemoryHost();
		const r = await runOnHost(host, "cat <<'EOF'\n  indented\nEOF", { cwd: "/workspace" });
		expect(r.stdout).toBe("  indented\n");
	});

	it("many concurrent spawns on one filesystem all complete with their own output", async () => {
		const host = await createMemoryHost();
		const runs = await Promise.all(
			Array.from({ length: 20 }, (_, i) => runOnHost(host, `sleep 0.0${i % 5}; echo ${i} >> log.txt; echo "$N"`, { cwd: "/workspace", env: { N: String(i) } })),
		);
		expect(runs.map((r) => r.stdout)).toEqual(Array.from({ length: 20 }, (_, i) => `${i}\n`));
		const lines = new TextDecoder().decode(await host.fs.readFile("/workspace/log.txt")).trim().split("\n");
		expect(lines.sort()).toEqual(Array.from({ length: 20 }, (_, i) => String(i)).sort());
	});

	describe("ripgrep argument adaptation (every flag Grep passes)", () => {
		it("covers each flag of buildRgArgs", () => {
			const args = buildRgArgs(
				{ pattern: "-p", output_mode: "content", "-i": true, "-o": true, "-C": 2, multiline: true, type: "ts", glob: "*.{ts,tsx} !vendor" },
				".",
			);
			const parsed = parseRgArgs(args);
			expect(parsed.args[0]).toBe("--case-sensitive");
			expect(parsed.args).not.toContain("--max-columns");
			expect(parsed.args).not.toContain("500");
			for (const f of ["--hidden", "-U", "--multiline-dotall", "-i", "--json", "-n", "-o", "-C", "--type"]) expect(parsed.args).toContain(f);
			expect(parsed).toMatchObject({ json: true, multiline: true, onlyMatching: true, before: 2, after: 2, types: ["ts"] });
			const globs = parsed.args.flatMap((a, i) => (parsed.args[i - 1] === "--glob" ? [a] : []));
			expect(globs).toEqual(expect.arrayContaining(["!.git", "!.git/**", "!**/.git/**", "*.ts", "*.tsx", "!vendor", "!vendor/**", "!**/vendor/**"]));
			expect(parsed.args.at(-1)).toBe(".");
			// count mode under -U counts matches, not lines
			expect(parseRgArgs(buildRgArgs({ pattern: "a", output_mode: "count", multiline: true }, ".")).args).toContain("--count-matches");
		});

		it("adaptGlob expands braces and gives exclusions directory semantics", () => {
			expect(adaptGlob("*.{a,b}")).toEqual(["*.a", "*.b"]);
			expect(adaptGlob("/src/*.ts")).toEqual(["src/*.ts"]);
			expect(adaptGlob("!dist")).toEqual(["!dist", "!dist/**", "!**/dist/**"]);
			expect(adaptGlob("!a/b")).toEqual(["!a/b", "!a/b/**"]);
		});

		it("rebuilds multiline match events from plain output", () => {
			const events = eventsFromPlain("m.txt:1:start\nmiddle\n--\nm.txt:4:start\nmiddle\n", ["m.txt"], true);
			const lines = events.map((e) => JSON.stringify(e));
			expect(parseRgJson(lines, { contextBreaks: false, onlyMatching: true })).toEqual(["m.txt\u00001:start", "m.txt\u00002:middle", "m.txt\u00004:start", "m.txt\u00005:middle"]);
		});
	});

	describe("known limitations (pinned so a just-bash change is noticed)", () => {
		it("Grep never searches node_modules (and the other directories just-bash always skips)", async () => {
			const host = await createMemoryHost();
			await host.fs.mkdir("/workspace/node_modules/m", { recursive: true });
			await host.fs.writeFile("/workspace/node_modules/m/i.js", "needle\n");
			await host.fs.writeFile("/workspace/a.js", "needle\n");
			const r = await host.search.ripgrep(buildRgArgs({ pattern: "needle" }, "."), { cwd: "/workspace" });
			expect(r.stdout.split("\0").filter(Boolean)).toEqual(["a.js"]);
			// Glob is not affected
			expect((await host.search.glob("**/*.js", { cwd: "/workspace" })).map((m) => m.path)).toContain("/workspace/node_modules/m/i.js");
		});

		it("binary files are skipped without a 'binary file matches' line", async () => {
			const host = await createMemoryHost();
			await host.fs.writeFile("/workspace/b.bin", new Uint8Array([110, 101, 101, 100, 108, 101, 0, 1]));
			const r = await host.search.ripgrep(buildRgArgs({ pattern: "needle", output_mode: "content" }, "/workspace/b.bin"), { cwd: "/workspace" });
			expect(r.exitCode).toBe(1);
		});
	});
});

describe("memory host isolation", () => {
	it("a write/spawn/rg/glob sequence leaves the real filesystem untouched", async () => {
		const marker = `pi-cc-memhost-${process.pid}-${Date.now()}`;
		const roots = [tmpdir(), process.cwd()];
		const before = roots.map((r) => new Set(readdirSync(r)));
		const work = `/${marker}/work`;
		const self = fileURLToPath(import.meta.url);
		const touched = await recordHostFs(async () => {
			const host = await createMemoryHost({ cwd: work, tmpDir: `/tmp/${marker}` });
			await host.fs.writeFile(`${work}/a.txt`, "needle\n");
			await host.fs.mkdir(`${work}/d/e`, { recursive: true });
			await host.fs.appendFile(`${work}/d/e/b.txt`, "needle 2\n");
			const r = await runOnHost(host, `echo spawned > s.txt; mkdir -p ${host.tmpDir}/x && echo t > ${host.tmpDir}/x/t.txt; cat a.txt; ls /`, { cwd: work });
			expect(r.stdout).toContain("needle");
			expect(r.stdout).toContain(marker);
			const rg = await host.search.ripgrep(buildRgArgs({ pattern: "needle", output_mode: "content" }, "."), { cwd: work });
			expect(rg.exitCode).toBe(0);
			expect((await host.search.glob("**/*.txt", { cwd: work })).length).toBe(3);
			// what the agent can see of the host: nothing
			expect((await runOnHost(host, `cat ${self}`, { cwd: work })).exit.exitCode).not.toBe(0);
			await expect(host.fs.readFile(self)).rejects.toMatchObject({ code: "ENOENT" });
		});
		// no call into node:fs except just-bash loading its own command modules
		expect(outsidePackages(touched)).toEqual([]);
		// what the host gained: nothing
		for (const p of [`/${marker}`, join(tmpdir(), marker), join("/tmp", marker), resolve(process.cwd(), marker), join(process.cwd(), "s.txt")]) expect(existsSync(p)).toBe(false);
		roots.forEach((r, i) => {
			const added = readdirSync(r).filter((n) => !before[i].has(n));
			expect(added.filter((n) => n.includes(marker) || n === "s.txt" || n === "a.txt")).toEqual([]);
		});
	});

	it("the root entry point does not import just-bash (static check of src/index.ts's imports)", () => {
		const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
		const seen = new Set<string>();
		const visit = (file: string) => {
			if (seen.has(file)) return;
			seen.add(file);
			const source = readFileSync(file, "utf8");
			for (const m of source.matchAll(/(?:import|export)\s[^;]*?from\s+"([^"]+)"|import\("([^"]+)"\)/g)) {
				const spec = m[1] ?? m[2];
				expect(spec, `${file} imports ${spec}`).not.toMatch(/^just-bash|^minimatch$/);
				if (spec.startsWith(".")) visit(resolve(dirname(file), spec.replace(/\.js$/, ".ts")));
			}
		};
		visit(join(srcDir, "index.ts"));
		expect([...seen].some((f) => f.includes(`${join("src", "memory")}`))).toBe(false);
	});
});

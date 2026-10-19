import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCCContext } from "../src/shared/context.js";
import type { ClaudeCodeToolsOptions } from "../src/shared/types.js";
import { registerGlob } from "../src/tools/glob.js";
import {
	dropPartialTail,
	parseRgJson,
	registerGrep,
	rgPathErrors,
	setRgOutputCapForTests,
	splitNullOutput,
	surfacePathErrors,
} from "../src/tools/grep.js";
import { captureTools, fakeCtx, resultText, tempDir } from "./helpers.js";

function toolsFor(options: ClaudeCodeToolsOptions = {}) {
	const { tools } = captureTools((pi) => {
		const cc = createCCContext(options);
		registerGrep(pi, cc);
		registerGlob(pi, cc);
	});
	const call = async (name: "Grep" | "Glob", params: Record<string, unknown>, cwd: string) => {
		const r = await tools.get(name)!.execute("id", params as any, undefined, undefined, fakeCtx(cwd));
		return { text: resultText(r as any), details: (r as any).details };
	};
	return call;
}

afterEach(() => setRgOutputCapForTests());

const ev = (o: unknown) => JSON.stringify(o);

describe("rg output cut short (#17)", () => {
	it("dropPartialTail keeps whole lines and complete NUL-terminated entries", () => {
		expect(dropPartialTail("")).toBe("");
		expect(dropPartialTail("a\nb\n")).toBe("a\nb\n");
		expect(dropPartialTail("a\nb\npart")).toBe("a\nb\n");
		expect(dropPartialTail("partial only")).toBe("");
		// one huge --null "line": keep every entry up to the last NUL (Claude Code's jse)
		expect(dropPartialTail("./a\0./b\0./c-cut")).toBe("./a\0./b\0");
		expect(dropPartialTail("x\n./a\0./b\0./c")).toBe("x\n./a\0./b\0");
		// count mode: a cut "path\0N" loses only the cut entry
		const kept = dropPartialTail("./a\x002\n./b\x001");
		expect(splitNullOutput(kept.replace(/\n$/, "").split("\n"), "count")).toEqual(["./a:2"]);
	});

	it("parseRgJson keeps the lines of a file cut short, after the complete files (#17a)", () => {
		const lines = [
			ev({ type: "begin", data: { path: { text: "./b_small.txt" } } }),
			ev({ type: "match", data: { path: { text: "./b_small.txt" }, lines: { text: "match small\n" }, line_number: 1, submatches: [] } }),
			ev({ type: "end", data: { path: { text: "./b_small.txt" }, binary_offset: null } }),
			ev({ type: "begin", data: { path: { text: "./a_big.txt" } } }),
			ev({ type: "match", data: { path: { text: "./a_big.txt" }, lines: { text: "match 1\n" }, line_number: 1, submatches: [] } }),
			ev({ type: "match", data: { path: { text: "./a_big.txt" }, lines: { text: "match 2\n" }, line_number: 2, submatches: [] } }),
			// output cut here: no "end" for a_big
		];
		expect(parseRgJson(lines, { contextBreaks: false, onlyMatching: false })).toEqual([
			"./b_small.txt\x001:match small",
			"./a_big.txt\x001:match 1",
			"./a_big.txt\x002:match 2",
		]);
	});

	it("Grep content mode returns head_limit lines when one file's output passes the cap (#17a)", async () => {
		const dir = tempDir("pi-cc-grep-cap-");
		writeFileSync(join(dir, "a_big.txt"), `match line ${"y".repeat(60)}\n`.repeat(20_000));
		writeFileSync(join(dir, "b_small.txt"), "match small\n");
		setRgOutputCapForTests(300_000);
		const { text } = await toolsFor()("Grep", { pattern: "match", output_mode: "content", head_limit: 5 }, dir);
		const [body, note] = text.split("\n\n");
		const lines = body.split("\n");
		expect(lines).toHaveLength(5);
		expect(note).toBe("[Showing results with pagination = limit: 5]");
		// b_small (complete) comes before the cut a_big when rg printed it; a_big lines start at 1
		const big = lines.filter((l) => l.startsWith("a_big.txt:"));
		expect(big.length).toBeGreaterThanOrEqual(4);
		expect(big[0]).toBe(`a_big.txt:1:match line ${"y".repeat(60)}`);
		if (lines.length - big.length === 1) expect(lines[0]).toBe("b_small.txt:1:match small");
	});

	it("Glob and Grep return results when a NUL-separated file list passes the cap (#17b)", async () => {
		const dir = tempDir("pi-cc-glob-cap-");
		mkdirSync(join(dir, "d"));
		for (let i = 0; i < 400; i++) writeFileSync(join(dir, "d", `${String(i).padStart(4, "0")}_${"n".repeat(200)}.txt`), "x");
		setRgOutputCapForTests(30_000); // ~140 of the ~84KB of names fit
		const call = toolsFor();

		const glob = await call("Glob", { pattern: "**/*.txt" }, dir);
		const globLines = glob.text.split("\n");
		expect(globLines).toHaveLength(101);
		expect(globLines[0]).toMatch(/^d\/\d{4}_n{200}\.txt$/);
		expect(globLines[100]).toMatch(/^\(Showing 100 of \d+ matching files; \d+ more are not listed\./);
		expect(glob.details.totalMatches).toBeGreaterThan(100);
		expect(glob.details.totalMatches).toBeLessThan(400);

		const grep = await call("Grep", { pattern: "x", output_mode: "files_with_matches", head_limit: 3 }, dir);
		expect(grep.text).toMatch(/^Found 3 files limit: 3\nd\/\d{4}_n{200}\.txt\n/);
		expect(grep.details.totalFiles).toBeGreaterThan(3);
	});

	it("still errors when nothing complete was read before the cap", async () => {
		const dir = tempDir("pi-cc-grep-cap-");
		writeFileSync(join(dir, "f.txt"), "match " + "z".repeat(400) + "\n");
		setRgOutputCapForTests(30); // shorter than the first JSON line
		await expect(toolsFor()("Grep", { pattern: "match", output_mode: "content" }, dir)).rejects.toThrow(
			/passed the 20MB limit before a single complete line was read/,
		);
	});
});

describe("searchPermissionErrors quirk (#16)", () => {
	const stderr =
		"rg: ./locked.txt: Permission denied (os error 13)\nrg: ./lockdir: IO error for operation on ./lockdir: Permission denied (os error 13)\nrg: some other warning\n";

	it("rgPathErrors picks rg's per-path OS errors only", () => {
		expect(rgPathErrors(stderr)).toEqual([
			{ path: "./locked.txt", message: "Permission denied (os error 13)" },
			{ path: "./lockdir", message: "Permission denied (os error 13)" },
		]);
		expect(rgPathErrors("rg: regex parse error:\n    (\n")).toEqual([]);
	});

	it("surfacePathErrors throws when nothing was found and warns on partial results", () => {
		const display = (p: string) => p.replace(/^\.\//, "");
		expect(() => surfacePathErrors("No matches found", true, stderr, display)).toThrow(
			'Search incomplete: ripgrep could not read 2 paths, so this is not a "no matches" result:\n- locked.txt: Permission denied (os error 13)\n- lockdir: Permission denied (os error 13)',
		);
		expect(surfacePathErrors("Found 1 file\nopen.txt", false, stderr, display)).toBe(
			"Found 1 file\nopen.txt\n\nWarning: ripgrep could not read 2 paths; results may be incomplete:\n- locked.txt: Permission denied (os error 13)\n- lockdir: Permission denied (os error 13)",
		);
		expect(surfacePathErrors("No matches found", true, "", display)).toBe("No matches found");
	});

	// chmod 000 does not stop root: run as a regular user (e.g. setpriv --reuid=65534) to exercise it.
	const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
	it.skipIf(isRoot)("default: unreadable files/dirs look like no matches; fixed: they are reported", async () => {
		const dir = tempDir("pi-cc-perm-");
		writeFileSync(join(dir, "locked.txt"), "secret needle\n");
		chmodSync(join(dir, "locked.txt"), 0o000);
		mkdirSync(join(dir, "lockdir"));
		writeFileSync(join(dir, "lockdir", "in.txt"), "x\n");
		chmodSync(join(dir, "lockdir"), 0o000);
		writeFileSync(join(dir, "open.txt"), "hi\n");
		try {
			const cc = toolsFor();
			expect((await cc("Grep", { pattern: "needle" }, dir)).text).toBe("No files found");
			expect((await cc("Grep", { pattern: "needle", output_mode: "content" }, dir)).text).toBe("No matches found");
			expect((await cc("Glob", { pattern: "lockdir/*.txt" }, dir)).text).toBe("No files found");

			for (const options of [{ compat: "fixed" as const }, { quirks: { searchPermissionErrors: "fixed" as const } }]) {
				const fixed = toolsFor(options);
				await expect(fixed("Grep", { pattern: "needle" }, dir)).rejects.toThrow(/could not read 2 paths[\s\S]*- locked\.txt: Permission denied/);
				await expect(fixed("Grep", { pattern: "needle", output_mode: "content" }, dir)).rejects.toThrow(/not a "no matches" result/);
				await expect(fixed("Glob", { pattern: "lockdir/*.txt" }, dir)).rejects.toThrow(/- lockdir: Permission denied/);
				const partial = await fixed("Grep", { pattern: "hi" }, dir);
				expect(partial.text).toMatch(/^Found 1 file\nopen\.txt\n\nWarning: ripgrep could not read 2 paths; results may be incomplete:/);
			}
		} finally {
			chmodSync(join(dir, "lockdir"), 0o755);
		}
	});
});

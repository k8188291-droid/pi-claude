import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Every tool reaches the machine through the ClaudeCodeHost (src/host/types.ts). Only the local host
// (src/host/local.ts) may touch the filesystem, processes, the OS or the glob package directly.

const SRC = join(import.meta.dirname, "..", "src");
/** Modules allowed to import the machine directly: the local host (and modules only it imports). */
const ALLOWED = new Set(["host/local.ts"]);
const FORBIDDEN = new Set(["fs", "fs/promises", "child_process", "os", "glob"]);

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = join(dir, e.name);
		if (e.isDirectory()) return sourceFiles(p);
		return /\.[cm]?[jt]sx?$/.test(e.name) ? [p] : [];
	});
}

/** Module specifiers a file imports: static imports/re-exports, dynamic `import()` and `require()`. */
function importedModules(source: string): string[] {
	const out: string[] = [];
	const patterns = [/\b(?:import|export)\s[^"'`;]*?\bfrom\s*["']([^"']+)["']/g, /\bimport\s*["']([^"']+)["']/g, /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g];
	for (const re of patterns) for (const m of source.matchAll(re)) out.push(m[1]);
	return out;
}

const isForbidden = (spec: string) => FORBIDDEN.has(spec.replace(/^node:/, ""));

describe("host boundary", () => {
	it("recognises the import forms it scans for", () => {
		const sample = [
			'import { readFile } from "node:fs/promises";',
			"import * as cp from 'child_process';",
			'export { tmpdir } from "node:os";',
			'const g = await import("glob");',
			'const fs = require("fs");',
			'import type { Stats } from "node:fs";',
			'import "node:os";',
			'import { join } from "node:path";',
		].join("\n");
		expect(importedModules(sample).filter(isForbidden).sort()).toEqual(["child_process", "fs", "glob", "node:fs", "node:fs/promises", "node:os", "node:os"].sort());
	});

	it("no module under src/ but the local host imports node:fs, node:child_process, node:os or glob", () => {
		const offenders: string[] = [];
		for (const file of sourceFiles(SRC)) {
			const rel = relative(SRC, file).split("\\").join("/");
			if (ALLOWED.has(rel)) continue;
			for (const spec of importedModules(readFileSync(file, "utf8"))) if (isForbidden(spec)) offenders.push(`${rel}: ${spec}`);
		}
		expect(offenders).toEqual([]);
	});
});

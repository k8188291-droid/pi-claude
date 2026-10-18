import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { Scenario } from "./types.js";

export async function createWorkspace(s: Scenario, harness: string): Promise<string> {
	const cwd = mkdtempSync(join(tmpdir(), `parity-${s.name}-${harness}-`));
	for (const [p, content] of Object.entries(s.files ?? {})) {
		const abs = join(cwd, p);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, content);
	}
	await s.setup?.(cwd);
	return cwd;
}

/** Snapshot text files in the workspace (skips .git and binaries). */
export function snapshot(cwd: string, only?: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			if (name === ".git" || name === "node_modules") continue;
			const abs = join(dir, name);
			const st = statSync(abs);
			if (st.isDirectory()) walk(abs);
			else {
				const rel = relative(cwd, abs);
				if (only && !only.includes(rel)) continue;
				const buf = readFileSync(abs);
				out[rel] = buf.includes(0) ? `<binary ${buf.length} bytes>` : buf.toString("utf8");
			}
		}
	};
	walk(cwd);
	return out;
}

import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, type Stats, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
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

const errCode = (e: unknown) => (e as NodeJS.ErrnoException)?.code ?? (e as Error)?.message ?? String(e);

function special(st: Stats): string | undefined {
	if (st.isFIFO()) return "<fifo>";
	if (st.isSocket()) return "<socket>";
	if (st.isCharacterDevice()) return "<char device>";
	if (st.isBlockDevice()) return "<block device>";
	return undefined;
}

/**
 * Snapshot the workspace: text files by content, binaries by size + sha256, symlinks as
 * `<symlink -> target>` (never followed), special files by kind, unreadable entries as
 * `<unreadable CODE>`. Skips .git and node_modules. `only` limits the snapshot to those
 * relative paths (and only descends into directories leading to them); `[]` reads nothing.
 */
export function snapshot(cwd: string, only?: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	if (only && only.length === 0) return out;
	const wanted = only?.map((p) => p.split(/[\\/]/).filter((x) => x && x !== ".").join(sep));
	const cwds = [cwd];
	try {
		const real = realpathSync(cwd);
		if (real !== cwd) cwds.push(real);
	} catch {}
	const portable = (target: string) => {
		for (const c of cwds) if (target === c || target.startsWith(c + sep)) return "<CWD>" + target.slice(c.length);
		return target;
	};
	const walk = (dir: string) => {
		let names: string[];
		try {
			names = readdirSync(dir).sort();
		} catch (e) {
			const rel = relative(cwd, dir);
			if (!wanted || wanted.includes(rel)) out[rel || "."] = `<unreadable directory ${errCode(e)}>`;
			return;
		}
		for (const name of names) {
			if (name === ".git" || name === "node_modules") continue;
			const abs = join(dir, name);
			const rel = relative(cwd, abs);
			let st: Stats;
			try {
				st = lstatSync(abs);
			} catch (e) {
				if (!wanted || wanted.includes(rel)) out[rel] = `<unreadable ${errCode(e)}>`;
				continue;
			}
			if (st.isDirectory()) {
				if (!wanted || wanted.some((w) => w === rel || w.startsWith(rel + sep))) walk(abs);
				continue;
			}
			if (wanted && !wanted.includes(rel)) continue;
			if (st.isSymbolicLink()) {
				try {
					out[rel] = `<symlink -> ${portable(readlinkSync(abs))}>`;
				} catch (e) {
					out[rel] = `<unreadable symlink ${errCode(e)}>`;
				}
				continue;
			}
			const kind = special(st);
			if (kind) {
				out[rel] = kind;
				continue;
			}
			try {
				const buf = readFileSync(abs);
				out[rel] = buf.includes(0) ? `<binary ${buf.length} bytes sha256:${createHash("sha256").update(buf).digest("hex")}>` : buf.toString("utf8");
			} catch (e) {
				out[rel] = `<unreadable ${errCode(e)}>`;
			}
		}
	};
	walk(cwd);
	return out;
}

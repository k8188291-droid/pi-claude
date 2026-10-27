import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

const SYNC = ["existsSync", "statSync", "lstatSync", "readFileSync", "readdirSync", "mkdirSync", "writeFileSync", "appendFileSync", "openSync", "realpathSync", "accessSync", "mkdtempSync", "rmSync", "unlinkSync", "renameSync", "createReadStream", "createWriteStream"];
const ASYNC = ["stat", "lstat", "readFile", "writeFile", "appendFile", "mkdir", "readdir", "open", "access", "realpath", "mkdtemp", "rm", "unlink", "rename"];

/**
 * Run `fn` while recording every call into node:fs / node:fs/promises (as "fs.existsSync /path").
 * Works for code importing either the default export or named exports (`syncBuiltinESMExports`).
 */
export async function recordHostFs(fn: () => Promise<void>): Promise<string[]> {
	const touched: string[] = [];
	const restore: Array<() => void> = [];
	const wrap = (obj: Record<string, unknown>, names: string[], label: string) => {
		for (const name of names) {
			const orig = obj[name];
			if (typeof orig !== "function") continue;
			obj[name] = function (this: unknown, ...args: unknown[]) {
				touched.push(`${label}.${name} ${String(args[0])}`);
				return (orig as (...a: unknown[]) => unknown).apply(this, args);
			};
			restore.push(() => (obj[name] = orig));
		}
	};
	wrap(fs as unknown as Record<string, unknown>, SYNC, "fs");
	wrap(fsp as unknown as Record<string, unknown>, ASYNC, "fs/promises");
	syncBuiltinESMExports();
	try {
		await fn();
	} finally {
		for (const r of restore) r();
		syncBuiltinESMExports();
	}
	return touched;
}

const NODE_MODULES = new URL("../node_modules/", import.meta.url);

/**
 * The recorded calls that are not module loading from the installed packages (just-bash loads its
 * command implementations lazily, pi reads its own package.json), nor in `allowed`.
 */
export function outsidePackages(touched: string[], allowed: string[] = []): string[] {
	return touched.filter((t) => {
		const path = t.slice(t.indexOf(" ") + 1);
		return !path.startsWith(NODE_MODULES.pathname) && !path.startsWith(NODE_MODULES.href) && !allowed.includes(path);
	});
}

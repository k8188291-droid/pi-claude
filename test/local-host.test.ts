import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalHost } from "../src/host/local.js";
import { describeHostContract } from "./host-contract.js";

describeHostContract("local host", async () => {
	const base = await mkdtemp(join(tmpdir(), "pi-cc-contract-"));
	const host = createLocalHost({ tmpBase: join(base, "tmp") });
	const root = join(base, "root");
	await host.fs.mkdir(root, { recursive: true });
	return {
		host,
		root,
		symlink: (target, path) => symlink(target, path),
		cleanup: () => rm(base, { recursive: true, force: true }),
	};
});

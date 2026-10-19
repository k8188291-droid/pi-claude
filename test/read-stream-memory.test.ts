import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { captureTools, fakeCtx, resultText, tempDir } from "./helpers.js";

// #6a: a ranged Read of a huge file must not load the whole file just to record its state.
// Count whole-file reads by spying on fs/promises.readFile (and the sync variant).
const reads = vi.hoisted(() => [] as string[]);
vi.mock("node:fs/promises", async (importOriginal) => {
	const orig = await importOriginal<typeof import("node:fs/promises")>();
	return { ...orig, readFile: (p: any, ...rest: any[]) => (reads.push(String(p)), (orig.readFile as any)(p, ...rest)) };
});
vi.mock("node:fs", async (importOriginal) => {
	const orig = await importOriginal<typeof import("node:fs")>();
	return { ...orig, readFileSync: (p: any, ...rest: any[]) => (reads.push(String(p)), (orig.readFileSync as any)(p, ...rest)) };
});

it("#6a: Read with limit streams a >10MiB file and never reads it whole", async () => {
	const { createCCContext } = await import("../src/shared/context.js");
	const { registerRead } = await import("../src/tools/read.js");
	let tools!: Map<string, ToolDefinition>;
	let cc!: ReturnType<typeof createCCContext>;
	({ tools } = captureTools((pi: ExtensionAPI) => {
		cc = createCCContext({});
		registerRead(pi, cc);
	}));
	const dir = tempDir("pi-cc-read-mem-");
	const p = join(dir, "big.log");
	writeFileSync(p, `first\n${"y".repeat(63)}\n`.repeat(170_000)); // ~12MB
	const r = await tools.get("Read")!.execute("id", { file_path: p, limit: 1 }, undefined, undefined, fakeCtx(dir));
	expect(resultText(r as any)).toBe("1\tfirst");
	expect(reads.filter((x) => x === p)).toEqual([]);
	expect(cc.fileState.get(p)).toMatchObject({ partial: true, offset: 1, limit: 1 });
	expect(cc.fileState.get(p)!.hash).toMatch(/^[0-9a-f]{64}$/);
});

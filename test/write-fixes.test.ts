import { execFileSync } from "node:child_process";
import { closeSync, constants, openSync, readFileSync, readSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalHost } from "../src/host/local.js";
import { createCCContext } from "../src/shared/context.js";
import type { Quirk } from "../src/shared/quirks.js";
import { registerRead } from "../src/tools/read.js";
import { NOT_A_REGULAR_FILE, readExistingText, registerWrite, writeRegularFile } from "../src/tools/write.js";
import { captureTools, fakeCtx, resultText, tempDir } from "./helpers.js";

// Regression tests for docs/review-2026-10-18.md on Write: #7b (never write into a FIFO) and the
// quirks #5 and #8 in both modes.

let dir: string;
let tools: Map<string, ToolDefinition>;
const fds: number[] = [];

function setup(fixed: Quirk[] = []): void {
	({ tools } = captureTools((pi: ExtensionAPI) => {
		const cc = createCCContext({ quirks: Object.fromEntries(fixed.map((q) => [q, "fixed"])) });
		registerRead(pi, cc);
		registerWrite(pi, cc);
	}));
}
const call = (name: string, params: any) => tools.get(name)!.execute("id", params, undefined, undefined, fakeCtx(dir)) as Promise<any>;
const file = (name: string, content: string) => {
	const p = join(dir, name);
	writeFileSync(p, content);
	return p;
};
function rewriteKeepingMtime(p: string, content: string): void {
	const { atimeMs, mtimeMs } = statSync(p);
	writeFileSync(p, content);
	utimesSync(p, atimeMs / 1000, (Math.floor(mtimeMs) + 0.5) / 1000);
	expect(Math.floor(statSync(p).mtimeMs)).toBe(Math.floor(mtimeMs));
}
/** A FIFO with a non-blocking reader attached (so a careless writer would not block, it would write). */
function fifoWithReader(name: string): { path: string; reader: number } {
	const path = join(dir, name);
	execFileSync("mkfifo", [path]);
	const reader = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
	fds.push(reader);
	return { path, reader };
}
function pending(fd: number): string {
	const buf = Buffer.alloc(64);
	try {
		return buf.toString("utf8", 0, readSync(fd, buf, 0, 64, null));
	} catch (err: any) {
		if (err?.code === "EAGAIN") return "";
		throw err;
	}
}

beforeEach(() => {
	dir = tempDir("pi-cc-write-fix-");
	setup();
});
afterEach(() => {
	for (const fd of fds.splice(0)) closeSync(fd);
});

describe("#7b: no writes into FIFOs", () => {
	it("writeRegularFile refuses a FIFO, with or without a reader, and writes nothing", async () => {
		const { path, reader } = fifoWithReader("f.txt");
		const { fs } = createLocalHost();
		await expect(writeRegularFile(fs, path, "bye")).rejects.toThrow(NOT_A_REGULAR_FILE);
		expect(pending(reader)).toBe("");
		closeSync(fds.pop()!);
		await expect(writeRegularFile(fs, path, "bye")).rejects.toThrow(NOT_A_REGULAR_FILE); // ENXIO: no reader
	});

	it("readExistingText refuses a FIFO without blocking", async () => {
		const path = join(dir, "r.txt");
		execFileSync("mkfifo", [path]);
		await expect(readExistingText(createLocalHost().fs, path)).rejects.toThrow(NOT_A_REGULAR_FILE);
	});

	it("writeRegularFile creates and truncates regular files", async () => {
		const p = join(dir, "new.txt");
		const { fs } = createLocalHost();
		await writeRegularFile(fs, p, "a long first version\n");
		await writeRegularFile(fs, p, "short\n");
		expect(readFileSync(p, "utf8")).toBe("short\n");
	});

	it("Write refuses a FIFO up front", async () => {
		const { path, reader } = fifoWithReader("w.txt");
		await expect(call("Write", { file_path: path, content: "bye" })).rejects.toThrow(/exists but is not a regular file/);
		expect(pending(reader)).toBe("");
	});
});

describe("#5 mtimeOnlyChangeDetection (Write)", () => {
	it("default: overwrites a file rewritten behind its back with the mtime restored, like Claude Code", async () => {
		const p = file("a.txt", "one\n");
		await call("Read", { file_path: p });
		rewriteKeepingMtime(p, "two\n");
		await call("Write", { file_path: p, content: "three\n" });
		expect(readFileSync(p, "utf8")).toBe("three\n");
	});

	it("fixed: the content changed, so the write is refused", async () => {
		setup(["mtimeOnlyChangeDetection"]);
		const p = file("a.txt", "one\n");
		await call("Read", { file_path: p });
		rewriteKeepingMtime(p, "two\n");
		await expect(call("Write", { file_path: p, content: "three\n" })).rejects.toThrow(/^File has been modified since read/);
		expect(readFileSync(p, "utf8")).toBe("two\n");
	});

	it("fixed: an mtime bump that left the content alone is not a change", async () => {
		setup(["mtimeOnlyChangeDetection"]);
		const p = file("a.txt", "one\n");
		await call("Read", { file_path: p });
		utimesSync(p, new Date(), new Date(Date.now() + 5000));
		await call("Write", { file_path: p, content: "three\n" });
		expect(readFileSync(p, "utf8")).toBe("three\n");
	});
});

describe("#8 pathTrim (Write)", () => {
	it("default: 'space ' writes 'space', like Claude Code", async () => {
		const res = await call("Write", { file_path: join(dir, "space "), content: "NEW\n" });
		expect(resultText(res)).toContain("File created successfully");
		expect(readFileSync(join(dir, "space"), "utf8")).toBe("NEW\n");
	});

	it("fixed: 'space ' writes 'space '; an empty path is rejected", async () => {
		setup(["pathTrim"]);
		await call("Write", { file_path: join(dir, "space "), content: "NEW\n" });
		expect(readFileSync(join(dir, "space "), "utf8")).toBe("NEW\n");
		expect(() => statSync(join(dir, "space"))).toThrow();
		await expect(call("Write", { file_path: "", content: "x" })).rejects.toThrow("file_path must not be empty.");
	});
});

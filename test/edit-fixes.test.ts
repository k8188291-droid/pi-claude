import { execFileSync } from "node:child_process";
import { closeSync, constants, openSync, readFileSync, readSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { createCCContext } from "../src/shared/context.js";
import type { Quirk } from "../src/shared/quirks.js";
import { applyEdit, registerEdit } from "../src/tools/edit.js";
import { registerRead } from "../src/tools/read.js";
import { captureTools, fakeCtx, resultText, tempDir } from "./helpers.js";

// Regression tests for docs/review-2026-10-18.md on Edit: #7b (FIFOs) and the quirks #5, #8 and
// #19 in both modes.

const CURRENT = " (file state is current in your context — no need to Read it back)";
const STALE_NOTE =
	" (note: the file had been modified on disk since you last read it — the edit applied cleanly, but the file contains other changes not in your context. Read it before edits that depend on surrounding content.)";

let dir: string;
let tools: Map<string, ToolDefinition>;

function setup(fixed: Quirk[] = []): void {
	({ tools } = captureTools((pi: ExtensionAPI) => {
		const cc = createCCContext({ quirks: Object.fromEntries(fixed.map((q) => [q, "fixed"])) });
		registerRead(pi, cc);
		registerEdit(pi, cc);
	}));
}
const call = (name: string, params: any) => tools.get(name)!.execute("id", params, undefined, undefined, fakeCtx(dir)) as Promise<any>;
const edit = (params: any) => call("Edit", params);
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

beforeEach(() => {
	dir = tempDir("pi-cc-edit-fix-");
	setup();
});

describe("#7b: Edit on a FIFO", () => {
	it("is refused with Claude Code's message before anything is read or written", async () => {
		const p = join(dir, "f.txt");
		execFileSync("mkfifo", [p]);
		// Without a writer, reading would block; with a reader attached, a write would go through.
		const reader = openSync(p, constants.O_RDONLY | constants.O_NONBLOCK);
		try {
			await expect(edit({ file_path: p, old_string: "hello", new_string: "bye" })).rejects.toThrow(/^Not a regular file \(device, FIFO, or socket\)$/);
			const buf = Buffer.alloc(16);
			let got = 0;
			try {
				got = readSync(reader, buf, 0, 16, null); // 0: no writer ever opened it
			} catch (err: any) {
				expect(err?.code).toBe("EAGAIN");
			}
			expect(got).toBe(0);
		} finally {
			closeSync(reader);
		}
	});

	it("keeps Claude Code's error for a directory", async () => {
		await expect(edit({ file_path: dir, old_string: "a", new_string: "b" })).rejects.toThrow(
			"Error calling tool (Edit): EISDIR: illegal operation on a directory, read",
		);
	});
});

describe("#5 mtimeOnlyChangeDetection (Edit)", () => {
	it("default: a rewrite with the mtime restored goes unnoticed, like Claude Code", async () => {
		const p = file("a.txt", "one\ntwo\n");
		await call("Read", { file_path: p });
		rewriteKeepingMtime(p, "one\nTWO\n");
		await expect(edit({ file_path: p, old_string: "two", new_string: "2" })).rejects.toThrow(/^String to replace not found in file/);
		const r = await edit({ file_path: p, old_string: "one", new_string: "1" });
		expect(resultText(r)).toBe(`The file ${p} has been updated successfully.`);
	});

	it("fixed: the content change is detected (stale error, or the stale-recovered note)", async () => {
		setup(["mtimeOnlyChangeDetection"]);
		const p = file("a.txt", "one\ntwo\n");
		await call("Read", { file_path: p });
		rewriteKeepingMtime(p, "one\nTWO\n");
		await expect(edit({ file_path: p, old_string: "two", new_string: "2" })).rejects.toThrow(/^File has been modified since read/);
		const r = await edit({ file_path: p, old_string: "one", new_string: "1" });
		expect(resultText(r)).toBe(`The file ${p} has been updated successfully.${STALE_NOTE}`);
		expect(readFileSync(p, "utf8")).toBe("1\nTWO\n");
	});

	it("fixed: an mtime bump alone keeps the file current", async () => {
		setup(["mtimeOnlyChangeDetection"]);
		const p = file("a.txt", "one\n");
		await call("Read", { file_path: p });
		utimesSync(p, new Date(), new Date(Date.now() + 5000));
		expect(resultText(await edit({ file_path: p, old_string: "one", new_string: "1" }))).toBe(`The file ${p} has been updated successfully.${CURRENT}`);
	});
});

describe("#19 replaceAllTrailingMatch", () => {
	it("default: a final match without a newline survives a replace_all deletion, like Claude Code", async () => {
		expect(applyEdit("foo\nfoo", "foo", "", true)).toBe("foo");
		const p = file("a.txt", "foo\nfoo");
		await call("Read", { file_path: p });
		expect(resultText(await edit({ file_path: p, old_string: "foo", new_string: "", replace_all: true }))).toMatch(/All occurrences were successfully replaced/);
		expect(readFileSync(p, "utf8")).toBe("foo");
	});

	it("fixed: every occurrence goes, each with the newline after it, in one pass", async () => {
		const opts = { deleteAllMatches: true };
		expect(applyEdit("foo\nfoo", "foo", "", true, opts)).toBe("");
		expect(applyEdit("a foo b\nfoo\nc", "foo", "", true, opts)).toBe("a  b\nc");
		// one pass over the original: the "foo" formed by joining "fo" + "o" is not a match
		expect(applyEdit("fofoo\no", "foo", "", true, opts)).toBe("foo");
		// single replacement and non-deletions are unchanged
		expect(applyEdit("x\nfoo", "foo", "", false, opts)).toBe("x\n");
		expect(applyEdit("foo\nfoo", "foo", "bar", true, opts)).toBe("bar\nbar");

		setup(["replaceAllTrailingMatch"]);
		const p = file("a.txt", "foo\nfoo");
		await call("Read", { file_path: p });
		await edit({ file_path: p, old_string: "foo", new_string: "", replace_all: true });
		expect(readFileSync(p, "utf8")).toBe("");
	});
});

describe("#8 pathTrim (Edit)", () => {
	it("default: 'space ' edits 'space', like Claude Code", async () => {
		file("space", "plain\n");
		file("space ", "plain\n");
		await edit({ file_path: join(dir, "space "), old_string: "plain", new_string: "NEW" });
		expect(readFileSync(join(dir, "space"), "utf8")).toBe("NEW\n");
		expect(readFileSync(join(dir, "space "), "utf8")).toBe("plain\n");
	});

	it("fixed: 'space ' edits 'space '; an empty path is rejected", async () => {
		setup(["pathTrim"]);
		file("space", "plain\n");
		file("space ", "plain\n");
		await edit({ file_path: join(dir, "space "), old_string: "plain", new_string: "NEW" });
		expect(readFileSync(join(dir, "space "), "utf8")).toBe("NEW\n");
		expect(readFileSync(join(dir, "space"), "utf8")).toBe("plain\n");
		await expect(edit({ file_path: " ", old_string: "a", new_string: "b" })).rejects.toThrow("file_path must not be empty.");
	});
});

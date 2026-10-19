import { execFileSync, spawn } from "node:child_process";
import { readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { createCCContext, type CCContext } from "../src/shared/context.js";
import { hashFileText, hashFileTextAsync, textHash, TextHasher } from "../src/shared/file-state.js";
import type { Quirk } from "../src/shared/quirks.js";
import { abortable, registerRead, WASTED_CALL_MESSAGE } from "../src/tools/read.js";
import { captureTools, fakeCtx, resultText, tempDir } from "./helpers.js";

// Regression tests for docs/review-2026-10-18.md items on Read: #6a, #26 (pi-only bugs) and the
// quirks #5, #7a/#7c, #8, #18 in both modes (Claude Code's default and "fixed").

let dir: string;
let cc: CCContext;
let tools: Map<string, ToolDefinition>;

function setup(fixed: Quirk[] = []): void {
	({ tools } = captureTools((pi: ExtensionAPI) => {
		cc = createCCContext({ quirks: Object.fromEntries(fixed.map((q) => [q, "fixed"])) });
		registerRead(pi, cc);
	}));
}
const read = (params: any, signal?: AbortSignal) => tools.get("Read")!.execute("id", params, signal, undefined, fakeCtx(dir)) as Promise<any>;
const file = (name: string, content: string | Buffer) => {
	const p = join(dir, name);
	writeFileSync(p, content);
	return p;
};
/** Rewrite a file behind the tools' back and restore its mtime (the #5 scenario). */
function rewriteKeepingMtime(p: string, content: string): void {
	const { atimeMs, mtimeMs } = statSync(p);
	writeFileSync(p, content);
	// seconds as a float; +0.5ms keeps Math.floor(mtimeMs) despite float rounding
	utimesSync(p, atimeMs / 1000, (Math.floor(mtimeMs) + 0.5) / 1000);
	expect(Math.floor(statSync(p).mtimeMs)).toBe(Math.floor(mtimeMs));
}

beforeEach(() => {
	dir = tempDir("pi-cc-read-fix-");
	setup();
});

describe("streamed text files (>= 10MiB)", () => {
	const filler = `${"x".repeat(99)}\n`.repeat(110_000); // ~11MB

	it("#26: decodes a UTF-16LE file behind its BOM, like Claude Code", async () => {
		const p = file("u16.txt", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`hello\r\n${filler}`, "utf16le")]));
		expect(statSync(p).size).toBeGreaterThan(10 * 1024 * 1024);
		const r = await read({ file_path: p, limit: 2 });
		expect(resultText(r)).toBe(`1\thello\n2\t${"x".repeat(99)}`);
		expect(r.details.totalLines).toBe(110_002);
	});

	it("#6a: records the whole file's text hash computed while streaming", async () => {
		const p = file("big.txt", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`a\r\nb\r${filler}é`)]));
		await read({ file_path: p, offset: 2, limit: 1 });
		const rec = cc.fileState.get(p)!;
		expect(rec.partial).toBe(true);
		expect(rec.hash).toBe(textHash(readFileSync(p)));
		const u16 = file("u16.txt", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`hi\r\n${filler}`, "utf16le")]));
		await read({ file_path: u16, limit: 1 });
		expect(cc.fileState.get(u16)!.hash).toBe(textHash(readFileSync(u16)));
	});
});

describe("streaming text hash", () => {
	it("matches textHash for any split of the text (BOM, CRLF across pieces)", () => {
		const text = "﻿a\r\nb\r\r\nc\rd\r\n";
		for (let i = 0; i <= text.length; i++) {
			for (let j = i; j <= text.length; j++) {
				const h = new TextHasher();
				h.update(text.slice(0, i));
				h.update(text.slice(i, j));
				h.update(text.slice(j));
				expect(h.digest()).toBe(textHash(text));
			}
		}
	});

	it("hashFileText(Async) equal textHash of the file (UTF-8, UTF-16LE, invalid bytes)", async () => {
		for (const buf of [
			Buffer.from("plain\r\ntext\n"),
			Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("wide\r\ntext", "utf16le")]),
			Buffer.concat([Buffer.from("bad "), Buffer.from([0xc3, 0x28, 0xff]), Buffer.from(" bytes\r")]),
			Buffer.alloc(0),
		]) {
			const p = file("h.txt", buf);
			expect(hashFileText(p)).toBe(textHash(buf));
			expect(await hashFileTextAsync(p)).toBe(textHash(buf));
		}
	});
});

describe("#5 mtimeOnlyChangeDetection (Read dedupe)", () => {
	it("default: a rewrite that restored the mtime is a 'Wasted call', like Claude Code", async () => {
		const p = file("a.txt", "one\n");
		await read({ file_path: p });
		rewriteKeepingMtime(p, "two\n");
		expect(resultText(await read({ file_path: p }))).toBe(WASTED_CALL_MESSAGE);
	});

	it("fixed: the content is compared too, so the new content is returned", async () => {
		setup(["mtimeOnlyChangeDetection"]);
		const p = file("a.txt", "one\n");
		await read({ file_path: p });
		expect(resultText(await read({ file_path: p }))).toBe(WASTED_CALL_MESSAGE);
		rewriteKeepingMtime(p, "two\n");
		expect(resultText(await read({ file_path: p }))).toBe("1\ttwo\n2\t");
	});
});

describe("#7a/#7c specialFileReads", () => {
	const mkfifo = (name: string) => {
		const p = join(dir, name);
		execFileSync("mkfifo", [p]);
		return p;
	};

	it("default: a FIFO named like an image is read (blocking until a writer shows up), like Claude Code", async () => {
		const p = mkfifo("f.png");
		const writer = spawn("sh", ["-c", `sleep 0.2; echo hello > '${p}'`]);
		await expect(read({ file_path: p })).rejects.toThrow(/not a valid PNG\/JPEG\/GIF\/WebP. Detected: unrecognized bytes \(hex: 68 65 6c 6c 6f 0a\)/);
		writer.kill();
	});

	it("fixed: FIFOs are refused before dispatch, whatever the extension", async () => {
		setup(["specialFileReads"]);
		for (const name of ["f.png", "f.pdf", "f.txt"]) {
			const p = mkfifo(name);
			await expect(read({ file_path: p })).rejects.toThrow(`${p} is not a regular file.`);
		}
		await expect(read({ file_path: mkfifo("n.ipynb") })).rejects.toThrow("Notebook path is not a regular file (device, FIFO, or socket).");
	});

	it("fixed: reads settle when aborted even if the underlying read never does", async () => {
		const ac = new AbortController();
		const stuck = abortable(new Promise<never>(() => {}), ac.signal);
		setTimeout(() => ac.abort(), 10);
		await expect(stuck).rejects.toThrow("Operation aborted");
		await expect(abortable(Promise.resolve(1), new AbortController().signal)).resolves.toBe(1);
	});
});

describe("#8 pathTrim", () => {
	it("default: the path is trimmed, so 'name ' reads 'name', like Claude Code", async () => {
		file("space", "plain\n");
		file("space ", "trailing\n");
		expect(resultText(await read({ file_path: join(dir, "space ") }))).toBe("1\tplain\n2\t");
	});

	it("fixed: the path is used verbatim; an empty path is rejected", async () => {
		setup(["pathTrim"]);
		file("space", "plain\n");
		file("space ", "trailing\n");
		expect(resultText(await read({ file_path: join(dir, "space ") }))).toBe("1\ttrailing\n2\t");
		await expect(read({ file_path: "  " })).rejects.toThrow("file_path must not be empty.");
	});
});

describe("#18 readTokenCountLineNumbers", () => {
	// 45,000 lines "a": 22,500 tokens of content, but ~85,000 with the "N\t" prefixes.
	const content = "a\n".repeat(45_000);

	it("default: the line-number prefixes do not count toward the token cap, like Claude Code", async () => {
		const p = file("lines.txt", content);
		const text = resultText(await read({ file_path: p }));
		expect(text).not.toMatch(/Truncated: PARTIAL view/);
		expect(text.endsWith("45000\ta\n45001\t")).toBe(true);
	});

	it("fixed: they count, so the result is paged down to fit", async () => {
		setup(["readTokenCountLineNumbers"]);
		const p = file("lines.txt", content);
		const r = await read({ file_path: p });
		expect(resultText(r)).toMatch(/\[Truncated: PARTIAL view — .*showing lines 1-\d+ of 45001 total/);
		expect(r.details.truncated).toBe(true);
		expect(resultText(r).length).toBeLessThan(25000 * 4 + 2000);
	});
});

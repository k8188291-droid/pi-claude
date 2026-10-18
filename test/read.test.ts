import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { createCCContext, type CCContext } from "../src/shared/context.js";
import { registerEdit } from "../src/tools/edit.js";
import { addLineNumbers, coerceReadInput, formatBytes, formatNumberedLine, parsePageRange, registerRead, selectLines, validatePages, WASTED_CALL_MESSAGE } from "../src/tools/read.js";
import { registerWrite } from "../src/tools/write.js";
import { captureTools, fakeCtx, resultText, tempDir } from "./helpers.js";

const PNG_1x1 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** Build a minimal valid PDF; null entries produce blank pages. */
export function makePdf(pageTexts: Array<string | null>): Buffer {
	const objs: string[] = [];
	const n = pageTexts.length;
	const pageIds = pageTexts.map((_, i) => 4 + i * 2);
	objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
	objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${n} >>`;
	objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
	pageTexts.forEach((t, i) => {
		const pid = 4 + i * 2;
		const cid = pid + 1;
		const stream = t ? `BT /F1 24 Tf 72 700 Td (${t}) Tj ET` : "";
		objs[pid] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${cid} 0 R >>`;
		objs[cid] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
	});
	let out = "%PDF-1.4\n";
	const offsets: number[] = [];
	for (let id = 1; id < objs.length; id++) {
		offsets[id] = out.length;
		out += `${id} 0 obj\n${objs[id]}\nendobj\n`;
	}
	const xref = out.length;
	out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
	for (let id = 1; id < objs.length; id++) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
	out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(out, "latin1");
}

let dir: string;
let cc: CCContext;
let tools: Map<string, ToolDefinition>;

function call(name: string, params: any, opts: { signal?: AbortSignal; cwd?: string } = {}) {
	return tools.get(name)!.execute("id", params, opts.signal, undefined, fakeCtx(opts.cwd ?? dir)) as Promise<any>;
}
const read = (params: any, opts?: { signal?: AbortSignal; cwd?: string }) => call("Read", params, opts);

beforeEach(() => {
	dir = tempDir("pi-cc-read-");
	({ tools } = captureTools((pi: ExtensionAPI) => {
		cc = createCCContext({});
		registerRead(pi, cc);
		registerWrite(pi, cc);
		registerEdit(pi, cc);
	}));
});

const withUsage = (tokens: number | null, contextWindow: number) => fakeCtx(dir, { getContextUsage: () => ({ tokens, contextWindow, percent: null }) } as any);
const readCtx = (params: any, ctx: any) => tools.get("Read")!.execute("id", params, undefined, undefined, ctx) as Promise<any>;
const lines = (n: number, f = (i: number) => `line ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1)).join("\n") + "\n";

describe("Read schema", () => {
	it("has Claude Code name, params and description", () => {
		const t = tools.get("Read")!;
		expect(t.name).toBe("Read");
		const props = (t.parameters as any).properties;
		expect(Object.keys(props).sort()).toEqual(["allow_large", "file_path", "limit", "offset", "pages"]);
		expect((t.parameters as any).required).toEqual(["file_path"]);
		expect((t.parameters as any).additionalProperties).toBe(false);
		expect(t.description).toContain("To list files in a directory, use the registered shell tool.");
		expect(t.description).toContain("Do NOT re-read a file you just edited to verify");
	});

	it("coerces input like Claude Code", () => {
		expect(coerceReadInput({ file_path: "a", offset: [3], limit: [2] })).toEqual({ file_path: "a", offset: 3, limit: 2 });
		expect(coerceReadInput({ file_path: "a", offset: -1, limit: 0 })).toEqual({ file_path: "a" });
		expect(coerceReadInput({ file_path: "a", length: 5, description: "x" })).toEqual({ file_path: "a", limit: 5 });
		expect(coerceReadInput({ file_path: "a", offset: "4", allow_large: "true" })).toEqual({ file_path: "a", offset: 4, allow_large: true });
	});
});

describe("helpers", () => {
	it("formats numbered lines without padding", () => {
		expect(formatNumberedLine(1, "x")).toBe("1\tx");
		expect(formatNumberedLine(123456, "y\r")).toBe("123456\ty");
		expect(addLineNumbers("a\nb\n", 1)).toBe("1\ta\n2\tb\n3\t");
		expect(addLineNumbers("", 1)).toBe("");
	});
	it("selects lines like Claude Code", () => {
		expect(selectLines("a\r\nb\r\n", 0, undefined)).toEqual({ content: "a\nb\n", lineCount: 3, totalLines: 3 });
		expect(selectLines("﻿a", 0, undefined)).toEqual({ content: "a", lineCount: 1, totalLines: 1 });
		expect(selectLines("a\nb\nc\n", 1, 1)).toEqual({ content: "b", lineCount: 1, totalLines: 4 });
		expect(selectLines("", 4, undefined)).toEqual({ content: "", lineCount: 0, totalLines: 1 });
	});
	it("formats byte sizes", () => {
		expect(formatBytes(500)).toBe("500 bytes");
		expect(formatBytes(262144)).toBe("256KB");
		expect(formatBytes(262145)).toBe("256KB");
		expect(formatBytes(420045)).toBe("410.2KB");
		expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5MB");
	});
	it("parses and validates page ranges", () => {
		expect(parsePageRange("3")).toEqual({ firstPage: 3, lastPage: 3 });
		expect(parsePageRange(" 1 - 5 ")).toEqual({ firstPage: 1, lastPage: 5 });
		expect(parsePageRange("4-")).toEqual({ firstPage: 4, lastPage: Infinity });
		expect(parsePageRange("0")).toBeNull();
		expect(parsePageRange("5-2")).toBeNull();
		expect(parsePageRange("1,3")).toBeNull();
		expect(validatePages("1,3")).toMatch(/^Invalid pages parameter: "1,3"\. Give one page/);
		expect(validatePages("1-25")).toBe('Page range "1-25" exceeds maximum of 20 pages per request. Please use a smaller range.');
		expect(validatePages("4-")).toMatch(/exceeds maximum of 20 pages/);
		expect(validatePages("2-21")).toBeUndefined();
	});
});

describe("Read text", () => {
	it("numbers lines like Claude Code (trailing newline = extra numbered line) and records the read", async () => {
		const p = join(dir, "a.txt");
		writeFileSync(p, "alpha\n\tbeta\ngamma\n");
		const r = await read({ file_path: p });
		expect(resultText(r)).toBe("1\talpha\n2\t\tbeta\n3\tgamma\n4\t");
		expect(r.details).toMatchObject({ kind: "text", startLine: 1, numLines: 4, totalLines: 4, truncated: false });
		expect(cc.fileState.get(p)).toMatchObject({ source: "read", offset: 1, limit: undefined, partial: false, truncated: false });
	});

	it("strips CR and a BOM, keeps files without trailing newline", async () => {
		writeFileSync(join(dir, "crlf.txt"), "﻿one\r\ntwo\r\n");
		expect(resultText(await read({ file_path: join(dir, "crlf.txt") }))).toBe("1\tone\n2\ttwo\n3\t");
		writeFileSync(join(dir, "b.txt"), "x\n\ny");
		expect(resultText(await read({ file_path: join(dir, "b.txt") }))).toBe("1\tx\n2\t\n3\ty");
	});

	it("does not cap lines or line length", async () => {
		const p = join(dir, "big.txt");
		writeFileSync(p, lines(2500));
		const text = resultText(await read({ file_path: p }));
		expect(text.split("\n")).toHaveLength(2501);
		expect(text).toContain("2500\tline 2500");
		const q = join(dir, "long.txt");
		writeFileSync(q, `${"x".repeat(5000)}\n`);
		expect(resultText(await read({ file_path: q }))).toBe(`1\t${"x".repeat(5000)}\n2\t`);
	});

	it("resolves relative paths against ctx.cwd", async () => {
		mkdirSync(join(dir, "sub"));
		writeFileSync(join(dir, "sub", "rel.txt"), "hi\n");
		expect(resultText(await read({ file_path: "sub/rel.txt" }))).toBe("1\thi\n2\t");
	});

	it("honors offset and limit without any notice; offset 0 numbers from 0", async () => {
		const p = join(dir, "n.txt");
		writeFileSync(p, lines(10));
		const r = await read({ file_path: p, offset: 3, limit: 2 });
		expect(resultText(r)).toBe("3\tline 3\n4\tline 4");
		expect(r.details).toMatchObject({ startLine: 3, numLines: 2, totalLines: 11 });
		expect(cc.fileState.get(p)).toMatchObject({ offset: 3, limit: 2, partial: true });
		expect(resultText(await read({ file_path: p, offset: 0, limit: 2 }))).toBe("0\tline 1\n1\tline 2");
		expect(resultText(await read({ file_path: p, offset: 11 }))).toBe("11\t");
		expect(resultText(await read({ file_path: p, limit: 50 }))).toContain("10\tline 10\n11\t");
		expect(cc.fileState.get(p)?.partial).toBe(false);
	});

	it("warns on empty files and offsets past EOF (single-line reminders)", async () => {
		const p = join(dir, "empty.txt");
		writeFileSync(p, "");
		expect(resultText(await read({ file_path: p }))).toBe("<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>");
		expect(resultText(await read({ file_path: p, offset: 5 }))).toBe(
			"<system-reminder>Warning: the file exists but is shorter than the provided offset (5). The file has 1 lines.</system-reminder>",
		);
		const q = join(dir, "short.txt");
		writeFileSync(q, "a\nb\n");
		expect(resultText(await read({ file_path: q, offset: 10 }))).toBe(
			"<system-reminder>Warning: the file exists but is shorter than the provided offset (10). The file has 3 lines.</system-reminder>",
		);
	});

	it("notes NUL bytes and invalid UTF-8, decodes UTF-16LE", async () => {
		writeFileSync(join(dir, "nul.txt"), Buffer.from("ab\u0000c\n", "latin1"));
		expect(resultText(await read({ file_path: join(dir, "nul.txt") }))).toMatch(/^1\tab\u0000c\n2\t\n\n\[This file has NUL bytes in its first 8 KB/);
		writeFileSync(join(dir, "l1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
		expect(resultText(await read({ file_path: join(dir, "l1.txt") }))).toContain("Its undecodable bytes show above as U+FFFD.");
		writeFileSync(join(dir, "u16.txt"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hi\n", "utf16le")]));
		expect(resultText(await read({ file_path: join(dir, "u16.txt") }))).toBe("1\thi\n2\t");
	});

	it("refuses files over 256KB without a limit, with the allow_large hint when there is room", async () => {
		const p = join(dir, "big.txt");
		writeFileSync(p, "z".repeat(262145));
		await expect(read({ file_path: p })).rejects.toThrow(
			/^File content \(256KB\) exceeds maximum allowed size \(256KB\)\. Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file\.$/,
		);
		await expect(readCtx({ file_path: p }, withUsage(10000, 200000))).rejects.toThrow(/To read it anyway, up to what still fits in your context, call Read again with allow_large: true/);
		await expect(readCtx({ file_path: p }, withUsage(150000, 200000))).rejects.toThrow(/Even with allow_large, this is more than fits/);
		await expect(read({ file_path: p, allow_large: true })).rejects.toThrow(/allow_large is not available where this read runs/);
		// a limit lifts the byte cap, but the token cap still applies (a 256KB line ≈ 65k tokens)
		await expect(read({ file_path: p, limit: 1 })).rejects.toThrow(/^File content \(65536 tokens\) exceeds maximum allowed tokens \(25000\)\./);
	});

	it("reads large files with allow_large when the context has room", async () => {
		const p = join(dir, "big.txt");
		writeFileSync(p, lines(30000, (i) => `row ${i}`));
		await expect(read({ file_path: p })).rejects.toThrow(/exceeds maximum allowed size/);
		const r = await readCtx({ file_path: p, offset: 29999, allow_large: true }, withUsage(10000, 200000));
		expect(resultText(r)).toBe("29999\trow 29999\n30000\trow 30000\n30001\t");
	});

	it("streams files over 10MB (the size reported is what was read before giving up)", async () => {
		const p = join(dir, "huge.txt");
		writeFileSync(p, `${"h".repeat(11 * 1024 * 1024)}\ntail\n`);
		await expect(read({ file_path: p })).rejects.toThrow(/^File content \(512KB\) exceeds maximum allowed size \(256KB\)/);
		await expect(read({ file_path: p, offset: 2, limit: 1 })).resolves.toMatchObject({ content: [{ text: "2\ttail" }] });
	});

	it("pages whole-file reads over the token cap and marks the record as truncated", async () => {
		const p = join(dir, "tokens.txt");
		writeFileSync(p, lines(4000, (i) => `${"w".repeat(40)} ${i}`)); // ~180k chars ≈ 45k tokens
		const r = await read({ file_path: p });
		const text = resultText(r);
		expect(text.startsWith("1\t")).toBe(true);
		expect(text).toMatch(/<system-reminder>\n\[Truncated: PARTIAL view — .*tokens\.txt: showing lines 1-\d+ of 4001 total \(\d+ tokens, cap 25000\)\. Call Read with offset=\d+ limit=\d+ for the next page, or Grep to find a specific section\. Do NOT answer/);
		expect(r.details.truncated).toBe(true);
		expect(cc.fileState.get(p)).toMatchObject({ truncated: true, partial: true });
		// partial reads over the cap are an error instead
		await expect(read({ file_path: p, offset: 2 })).rejects.toThrow(/^File content \(\d+ tokens\) exceeds maximum allowed tokens \(25000\)/);
	});

	it("errors on directories and missing files like Claude Code", async () => {
		await expect(read({ file_path: dir })).rejects.toThrow(`EISDIR: illegal operation on a directory, read '${dir}'`);
		writeFileSync(join(dir, "config.json"), "{}");
		await expect(read({ file_path: join(dir, "config.txt") })).rejects.toThrow(
			`File does not exist. Note: your current working directory is ${dir}. Did you mean config.json?`,
		);
		await expect(read({ file_path: join(dir, "nothing-like-it.md") })).rejects.toThrow(/^File does not exist\. Note: your current working directory is .*\.$/);
		mkdirSync(join(dir, "proj", "src"), { recursive: true });
		writeFileSync(join(dir, "proj", "src", "x.ts"), "x");
		await expect(read({ file_path: join(dir, "src", "x.ts") }, { cwd: join(dir, "proj") })).rejects.toThrow(`Did you mean ${join(dir, "proj", "src", "x.ts")}?`);
	});

	it("refuses binary extensions (even missing files) and blocking devices", async () => {
		await expect(read({ file_path: join(dir, "x.zip") })).rejects.toThrow(
			"This tool cannot read binary files. The file appears to be a binary .zip file. Use a skill for this file type if one is available, or a shell command or script that can read the format.",
		);
		await expect(read({ file_path: "/dev/zero" })).rejects.toThrow("Cannot read '/dev/zero': this device file would block or produce infinite output.");
		// binary content with a text extension is read, with a note
		writeFileSync(join(dir, "blob.txt"), Buffer.from([1, 2, 0, 3]));
		expect(resultText(await read({ file_path: join(dir, "blob.txt") }))).toContain("[This file has NUL bytes");
	});

	it("validates pages even for text files and otherwise ignores it", async () => {
		const p = join(dir, "t.txt");
		writeFileSync(p, "data\n");
		await expect(read({ file_path: p, pages: "1,3" })).rejects.toThrow(/Invalid pages parameter/);
		expect(resultText(await read({ file_path: p, pages: "2" }))).toBe("1\tdata\n2\t");
	});

	it("finds macOS screenshot names with a narrow no-break space", async () => {
		const real = join(dir, "Screenshot 2024-01-01 at 10.00.00 AM.png");
		writeFileSync(real, Buffer.from(PNG_1x1, "base64"));
		const r = await read({ file_path: join(dir, "Screenshot 2024-01-01 at 10.00.00 AM.png") });
		expect(r.content.some((c: any) => c.type === "image")).toBe(true);
	});

	it("rejects when aborted", async () => {
		const p = join(dir, "a.txt");
		writeFileSync(p, "a");
		const ac = new AbortController();
		ac.abort();
		await expect(read({ file_path: p }, { signal: ac.signal })).rejects.toThrow(/aborted/);
	});
});

describe("Read unchanged-file detection", () => {
	it("answers a repeated read of the same range with the wasted-call note", async () => {
		const p = join(dir, "f.txt");
		writeFileSync(p, lines(6));
		await read({ file_path: p });
		expect(resultText(await read({ file_path: p }))).toBe(WASTED_CALL_MESSAGE);
		expect(resultText(await read({ file_path: p, offset: 1 }))).toBe(WASTED_CALL_MESSAGE);
		expect(resultText(await read({ file_path: p, limit: 2 }))).toBe("1\tline 1\n2\tline 2");
		expect(resultText(await read({ file_path: p, limit: 2 }))).toBe(WASTED_CALL_MESSAGE);
		expect(resultText(await read({ file_path: p }))).toContain("6\tline 6");
	});

	it("reads again after the mtime changes or after Edit", async () => {
		const p = join(dir, "g.txt");
		writeFileSync(p, lines(3));
		await read({ file_path: p });
		utimesSync(p, new Date("2020-01-01"), new Date("2020-01-01"));
		expect(resultText(await read({ file_path: p }))).toContain("1\tline 1");
		await call("Edit", { file_path: p, old_string: "line 2", new_string: "LINE 2" });
		expect(resultText(await read({ file_path: p }))).toContain("2\tLINE 2");
		expect(resultText(await read({ file_path: p }))).toBe(WASTED_CALL_MESSAGE);
	});

	it("does not dedup images; dedups notebooks regardless of offset", async () => {
		const img = join(dir, "p.png");
		writeFileSync(img, Buffer.from(PNG_1x1, "base64"));
		await read({ file_path: img });
		expect((await read({ file_path: img })).content[0].type).toBe("image");
		const nb = join(dir, "n.ipynb");
		writeFileSync(nb, JSON.stringify({ cells: [{ cell_type: "markdown", source: "x" }] }));
		await read({ file_path: nb });
		expect(resultText(await read({ file_path: nb, offset: 5 }))).toBe(WASTED_CALL_MESSAGE);
	});
});

describe("Read images", () => {
	it("returns only the image", async () => {
		const p = join(dir, "pixel.png");
		writeFileSync(p, Buffer.from(PNG_1x1, "base64"));
		const r = await read({ file_path: p });
		expect(r.content).toHaveLength(1);
		expect(r.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
		expect(r.details.kind).toBe("image");
		expect(cc.fileState.has(p)).toBe(false);
	});

	it("detects extensionless images by content; other extensions are text", async () => {
		writeFileSync(join(dir, "pixel"), Buffer.from(PNG_1x1, "base64"));
		expect((await read({ file_path: join(dir, "pixel") })).content[0].type).toBe("image");
		writeFileSync(join(dir, "pixel.txt"), Buffer.from(PNG_1x1, "base64"));
		expect((await read({ file_path: join(dir, "pixel.txt") })).content[0].type).toBe("text");
	});

	it("errors on empty or invalid image files", async () => {
		writeFileSync(join(dir, "e.png"), "");
		await expect(read({ file_path: join(dir, "e.png") })).rejects.toThrow(`Image file is empty: ${join(dir, "e.png")}`);
		writeFileSync(join(dir, "f.png"), "not an image\n");
		await expect(read({ file_path: join(dir, "f.png") })).rejects.toThrow(
			`File has an image extension but its content is not a valid PNG/JPEG/GIF/WebP. Detected: unrecognized bytes (hex: 6e 6f 74 20 61 6e 20 69). This usually means a download saved an error/login page instead of the image. Use \`file "${join(dir, "f.png")}"\` to confirm, or read it as text with Bash (e.g. \`head -c 500\`).`,
		);
	});
});

describe("Read PDF", () => {
	it("reads whole PDFs (header text + rendered pages)", async () => {
		const p = join(dir, "doc.pdf");
		writeFileSync(p, makePdf(["Hello page one", "Second page here"]));
		const r = await read({ file_path: p });
		expect(r.content[0]).toEqual({ type: "text", text: expect.stringMatching(new RegExp(`^PDF file read: ${p} \\(\\d+ bytes\\)$`)) });
		expect(r.content.filter((c: any) => c.type === "image")).toHaveLength(2);
		expect(r.details).toMatchObject({ kind: "pdf", totalPages: 2 });
	});

	it("extracts page ranges as images", async () => {
		const p = join(dir, "doc.pdf");
		writeFileSync(p, makePdf(Array.from({ length: 15 }, (_, i) => `Content of page ${i + 1}`)));
		const r = await read({ file_path: p, pages: "3-4" });
		expect(resultText(r)).toMatch(new RegExp(`^PDF pages extracted: 2 page\\(s\\) from ${p} \\(`));
		expect(r.content.filter((c: any) => c.type === "image")).toHaveLength(2);
		expect(r.details.pages).toEqual([3, 4]);
	});

	it("requires pages for PDFs over 10 pages and rejects out-of-range pages", async () => {
		const p = join(dir, "long.pdf");
		writeFileSync(p, makePdf(Array.from({ length: 11 }, (_, i) => `P${i + 1}`)));
		await expect(read({ file_path: p })).rejects.toThrow(
			'This PDF has 11 pages, which is too many to read at once. Use the pages parameter to read specific page ranges (e.g., pages: "1-5"). Maximum 20 pages per request.',
		);
		await expect(read({ file_path: p, pages: "15" })).rejects.toThrow(
			'Requested page 15 is outside the document (PDF has 11 pages). Use a range within 1-11, maximum 20 pages per request (e.g. pages: "1-11").',
		);
		await expect(read({ file_path: p, pages: "10-" })).rejects.toThrow(/exceeds maximum of 20 pages/);
	});

	it("errors on files without a PDF header", async () => {
		const p = join(dir, "bad.pdf");
		writeFileSync(p, "garbage");
		await expect(read({ file_path: p })).rejects.toThrow(`File is not a valid PDF (missing %PDF- header): ${p}`);
	});
});

describe("Read notebooks", () => {
	const nb = {
		metadata: { language_info: { name: "python" } },
		nbformat: 4,
		nbformat_minor: 5,
		cells: [
			{ cell_type: "markdown", id: "md1", metadata: {}, source: ["# Title\n", "Some text"] },
			{
				cell_type: "code",
				id: "c1",
				metadata: {},
				execution_count: 1,
				source: "print('hi')\n1+1",
				outputs: [
					{ output_type: "stream", name: "stdout", text: ["hi\n"] },
					{ output_type: "execute_result", execution_count: 1, data: { "text/plain": ["2"] }, metadata: {} },
				],
			},
			{
				cell_type: "code",
				metadata: {},
				source: "plot()",
				outputs: [{ output_type: "display_data", data: { "image/png": PNG_1x1, "text/plain": "<Figure>" }, metadata: {} }],
			},
			{
				cell_type: "code",
				id: "err",
				metadata: {},
				source: "1/0",
				outputs: [{ output_type: "error", ename: "ZeroDivisionError", evalue: "division by zero", traceback: ["\u001b[31mTraceback\u001b[0m", "line 1"] }],
			},
		],
	};

	it("renders cells and outputs like Claude Code", async () => {
		const p = join(dir, "nb.ipynb");
		writeFileSync(p, JSON.stringify(nb, null, 1));
		const r = await read({ file_path: p });
		expect(r.content.map((c: any) => c.type)).toEqual(["text", "image", "text"]);
		expect(r.content[0].text).toBe(
			'<cell id="md1"><cell_type>markdown</cell_type># Title\nSome text</cell id="md1">\n' +
				"<cell id=\"c1\">print('hi')\n1+1</cell id=\"c1\">\n\nhi\n\n\n2\n" +
				'<cell id="cell-2">plot()</cell id="cell-2">\n\n<Figure>',
		);
		expect(r.content[2].text).toBe('<cell id="err">1/0</cell id="err">\n\nZeroDivisionError: division by zero\n\u001b[31mTraceback\u001b[0m\nline 1');
		expect(r.details).toMatchObject({ kind: "notebook", cells: 4 });
		expect(cc.fileState.get(p)).toMatchObject({ source: "read", offset: 1 });
	});

	it("marks non-python code cells with language_info.name only", async () => {
		const p = join(dir, "r.ipynb");
		writeFileSync(p, JSON.stringify({ metadata: { language_info: { name: "R" } }, cells: [{ cell_type: "code", source: "x <- 1", outputs: [] }] }));
		expect(resultText(await read({ file_path: p }))).toBe('<cell id="cell-0"><language>R</language>x <- 1</cell id="cell-0">');
		const q = join(dir, "k.ipynb");
		writeFileSync(q, JSON.stringify({ metadata: { kernelspec: { language: "R" } }, cells: [{ cell_type: "code", source: "y", outputs: [] }] }));
		expect(resultText(await read({ file_path: q }))).toBe('<cell id="cell-0">y</cell id="cell-0">');
	});

	it("replaces too-large outputs with a jq hint", async () => {
		const p = join(dir, "big.ipynb");
		writeFileSync(p, JSON.stringify({ cells: [{ cell_type: "code", source: "s", outputs: [{ output_type: "stream", text: "x".repeat(12000) }] }] }));
		expect(resultText(await read({ file_path: p }))).toBe(
			"<cell id=\"cell-0\">s</cell id=\"cell-0\">\n\nOutputs are too large to include. Use Bash with: cat <notebook_path> | jq '.cells[0].outputs'",
		);
	});

	it("refuses Edit on a notebook after reading it (NotebookEdit's job)", async () => {
		const p = join(dir, "nb.ipynb");
		writeFileSync(p, JSON.stringify(nb, null, 1));
		await read({ file_path: p });
		await expect(call("Edit", { file_path: p, old_string: "print('hi')", new_string: "print('bye')" })).rejects.toThrow(/NotebookEdit/);
	});

	it("errors on invalid notebooks; empty notebooks have no output", async () => {
		const bad = join(dir, "bad.ipynb");
		writeFileSync(bad, "{not json");
		await expect(read({ file_path: bad })).rejects.toThrow(
			"Notebook file is not valid JSON (it may be truncated, corrupted, or still being written): JSON Parse error: Expected '}'",
		);
		const nocells = join(dir, "nocells.ipynb");
		writeFileSync(nocells, "{}");
		await expect(read({ file_path: nocells })).rejects.toThrow(/top-level "cells" must be an array/);
		const empty = join(dir, "empty.ipynb");
		writeFileSync(empty, JSON.stringify({ cells: [] }));
		expect(resultText(await read({ file_path: empty }))).toBe("(Read completed with no output)");
	});
});

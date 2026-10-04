import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { createCCContext, type CCContext } from "../src/shared/context.js";
import { registerEdit } from "../src/tools/edit.js";
import { formatNumberedLine, parsePageRange, registerRead, splitLines } from "../src/tools/read.js";
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

describe("Read schema", () => {
	it("has Claude Code name and params", () => {
		const t = tools.get("Read")!;
		expect(t.name).toBe("Read");
		const props = (t.parameters as any).properties;
		expect(Object.keys(props).sort()).toEqual(["file_path", "limit", "offset", "pages"]);
		expect((t.parameters as any).required).toEqual(["file_path"]);
		expect(t.description).toContain("cat -n");
	});
});

describe("helpers", () => {
	it("formats cat -n lines", () => {
		expect(formatNumberedLine(1, "x")).toBe("     1\tx");
		expect(formatNumberedLine(123456, "y")).toBe("123456\ty");
		expect(formatNumberedLine(1234567, "z")).toBe("1234567\tz");
	});
	it("splits lines", () => {
		expect(splitLines("")).toEqual([]);
		expect(splitLines("a")).toEqual(["a"]);
		expect(splitLines("a\n")).toEqual(["a"]);
		expect(splitLines("a\r\nb\r\n")).toEqual(["a", "b"]);
		expect(splitLines("a\n\n")).toEqual(["a", ""]);
		expect(splitLines("\n")).toEqual([""]);
	});
	it("parses page ranges", () => {
		expect(parsePageRange("3")).toEqual({ first: 3, last: 3 });
		expect(parsePageRange(" 1 - 5 ")).toEqual({ first: 1, last: 5 });
		expect(parsePageRange("4-")).toEqual({ first: 4, last: undefined });
		expect(() => parsePageRange("0")).toThrow(/start at 1/);
		expect(() => parsePageRange("5-2")).toThrow(/end page/);
		expect(() => parsePageRange("abc")).toThrow(/Invalid pages/);
		expect(() => parsePageRange("1,3")).toThrow(/Invalid pages/);
	});
});

describe("Read text", () => {
	it("returns cat -n formatted content and records the read", async () => {
		const p = join(dir, "a.txt");
		writeFileSync(p, "alpha\n\tbeta\ngamma\n");
		const r = await read({ file_path: p });
		expect(resultText(r)).toBe("     1\talpha\n     2\t\tbeta\n     3\tgamma");
		expect(r.details).toMatchObject({ kind: "text", startLine: 1, numLines: 3, totalLines: 3, truncated: false });
		expect(cc.fileState.has(p)).toBe(true);
		expect(cc.fileState.checkCanModify(p)).toBeUndefined();
	});

	it("strips CR from CRLF files and a BOM", async () => {
		const p = join(dir, "crlf.txt");
		writeFileSync(p, "﻿one\r\ntwo\r\n");
		expect(resultText(await read({ file_path: p }))).toBe("     1\tone\n     2\ttwo");
	});

	it("keeps a file without trailing newline and preserves blank lines", async () => {
		const p = join(dir, "b.txt");
		writeFileSync(p, "x\n\ny");
		expect(resultText(await read({ file_path: p }))).toBe("     1\tx\n     2\t\n     3\ty");
	});

	it("resolves relative paths against ctx.cwd", async () => {
		mkdirSync(join(dir, "sub"));
		writeFileSync(join(dir, "sub", "rel.txt"), "hi\n");
		expect(resultText(await read({ file_path: "sub/rel.txt" }))).toBe("     1\thi");
	});

	it("honors offset and limit and reports remaining lines", async () => {
		const p = join(dir, "n.txt");
		writeFileSync(p, Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n") + "\n");
		const r = await read({ file_path: p, offset: 3, limit: 2 });
		const text = resultText(r);
		expect(text.startsWith("     3\tline3\n     4\tline4")).toBe(true);
		expect(text).toContain("Showing lines 3-4 of 10. Use offset=5");
		expect(r.details).toMatchObject({ startLine: 3, numLines: 2, totalLines: 10, truncated: true });
		// partial reads still allow modification
		expect(cc.fileState.checkCanModify(p)).toBeUndefined();
	});

	it("treats offset 0 and 1 as the beginning", async () => {
		const p = join(dir, "o.txt");
		writeFileSync(p, "a\nb\n");
		expect(resultText(await read({ file_path: p, offset: 0 }))).toBe("     1\ta\n     2\tb");
		expect(resultText(await read({ file_path: p, offset: 1 }))).toBe("     1\ta\n     2\tb");
	});

	it("reads at most 2000 lines by default", async () => {
		const p = join(dir, "big.txt");
		writeFileSync(p, Array.from({ length: 2500 }, (_, i) => `L${i + 1}`).join("\n"));
		const r = await read({ file_path: p });
		const text = resultText(r);
		expect(text).toContain("  2000\tL2000");
		expect(text).not.toContain("L2001\n");
		expect(text).toContain("Showing lines 1-2000 of 2500. Use offset=2001");
		const r2 = await read({ file_path: p, offset: 2001 });
		expect(resultText(r2)).toContain("  2500\tL2500");
		expect(r2.details.numLines).toBe(500);
	});

	it("truncates lines longer than 2000 characters", async () => {
		const p = join(dir, "long.txt");
		writeFileSync(p, "x".repeat(5000) + "\nshort\n");
		const text = resultText(await read({ file_path: p }));
		const first = text.split("\n")[0];
		expect(first.startsWith("     1\t" + "x".repeat(2000))).toBe(true);
		expect(first).not.toContain("x".repeat(2001));
		expect(first).toContain("line truncated, 5000 chars total");
		expect(text).toContain("     2\tshort");
	});

	it("caps total output size", async () => {
		const p = join(dir, "wide.txt");
		writeFileSync(p, Array.from({ length: 1500 }, () => "y".repeat(1500)).join("\n"));
		const r = await read({ file_path: p });
		const text = resultText(r);
		expect(text.length).toBeLessThan(101_000);
		expect(text).toMatch(/Output truncated at line \d+ of 1500/);
		expect(r.details.truncated).toBe(true);
	});

	it("warns on empty files", async () => {
		const p = join(dir, "empty.txt");
		writeFileSync(p, "");
		const r = await read({ file_path: p });
		expect(resultText(r)).toContain("<system-reminder>");
		expect(resultText(r)).toContain("the file exists but the contents are empty");
		expect(cc.fileState.has(p)).toBe(true);
	});

	it("warns when offset is beyond EOF", async () => {
		const p = join(dir, "short.txt");
		writeFileSync(p, "a\nb\n");
		const r = await read({ file_path: p, offset: 10 });
		expect(resultText(r)).toContain("shorter than the provided offset (10). The file has 2 lines.");
	});

	it("errors on directories", async () => {
		await expect(read({ file_path: dir })).rejects.toThrow(/directory.*ls command via the Bash tool/s);
	});

	it("errors on missing files and suggests similar names", async () => {
		writeFileSync(join(dir, "config.json"), "{}");
		await expect(read({ file_path: join(dir, "config.jsn") })).rejects.toThrow(/does not exist[\s\S]*Did you mean .*config\.json/);
		await expect(read({ file_path: join(dir, "Config.json") })).rejects.toThrow(/Did you mean .*config\.json/);
		await expect(read({ file_path: join(dir, "nothing-like-it.md") })).rejects.toThrow(/does not exist/);
		await expect(read({ file_path: join(dir, "nope", "x.txt") })).rejects.toThrow(/does not exist/);
	});

	it("finds macOS screenshot names with a narrow no-break space", async () => {
		const real = join(dir, "Screenshot 2024-01-01 at 10.00.00 AM.png");
		writeFileSync(real, Buffer.from(PNG_1x1, "base64"));
		const r = await read({ file_path: join(dir, "Screenshot 2024-01-01 at 10.00.00 AM.png") });
		expect(r.content.some((c: any) => c.type === "image")).toBe(true);
	});

	it("refuses binary files", async () => {
		const p = join(dir, "blob.bin");
		writeFileSync(p, Buffer.from([1, 2, 0, 3, 4]));
		await expect(read({ file_path: p })).rejects.toThrow(/cannot read binary files/);
	});

	it("rejects when aborted", async () => {
		const p = join(dir, "a.txt");
		writeFileSync(p, "a");
		const ac = new AbortController();
		ac.abort();
		await expect(read({ file_path: p }, { signal: ac.signal })).rejects.toThrow(/aborted/);
	});
});

describe("Read images", () => {
	it("returns image content for PNG", async () => {
		const p = join(dir, "pixel.png");
		writeFileSync(p, Buffer.from(PNG_1x1, "base64"));
		const r = await read({ file_path: p });
		const img = r.content.find((c: any) => c.type === "image");
		expect(img).toBeDefined();
		expect(img.mimeType).toBe("image/png");
		expect(typeof img.data).toBe("string");
		expect(Buffer.from(img.data, "base64").subarray(1, 4).toString()).toBe("PNG");
		expect(resultText(r)).toContain("Read image file");
		expect(r.details.kind).toBe("image");
	});

	it("detects images by content, not extension", async () => {
		const p = join(dir, "pixel.dat");
		writeFileSync(p, Buffer.from(PNG_1x1, "base64"));
		const r = await read({ file_path: p });
		expect(r.content.find((c: any) => c.type === "image")?.mimeType).toBe("image/png");
	});
});

describe("Read PDF", () => {
	it("extracts text per page", async () => {
		const p = join(dir, "doc.pdf");
		writeFileSync(p, makePdf(["Hello page one", "Second page here"]));
		const r = await read({ file_path: p });
		const text = resultText(r);
		expect(text).toContain("2 pages total");
		expect(text).toMatch(/<page number="1">\s*Hello page one\s*<\/page>/);
		expect(text).toMatch(/<page number="2">\s*Second page here\s*<\/page>/);
		expect(r.details).toMatchObject({ kind: "pdf", totalPages: 2, pages: [1, 2] });
	});

	it("supports page ranges", async () => {
		const p = join(dir, "doc.pdf");
		writeFileSync(p, makePdf(Array.from({ length: 15 }, (_, i) => `Content of page ${i + 1}`)));
		const r = await read({ file_path: p, pages: "3-4" });
		const text = resultText(r);
		expect(text).toContain("Content of page 3");
		expect(text).toContain("Content of page 4");
		expect(text).not.toContain("Content of page 5");
		expect(text).toContain('<page number="3">');
		const single = resultText(await read({ file_path: p, pages: "15" }));
		expect(single).toContain("Content of page 15");
		expect(single).toContain("Showing page 15.");
		const open = await read({ file_path: p, pages: "12-" });
		expect(open.details.pages).toEqual([12, 15]);
	});

	it("requires pages for PDFs over 10 pages", async () => {
		const p = join(dir, "long.pdf");
		writeFileSync(p, makePdf(Array.from({ length: 11 }, (_, i) => `P${i + 1}`)));
		await expect(read({ file_path: p })).rejects.toThrow(/11 pages.*pages parameter/s);
	});

	it("validates page ranges", async () => {
		const p = join(dir, "doc.pdf");
		writeFileSync(p, makePdf(Array.from({ length: 30 }, (_, i) => `P${i + 1}`)));
		await expect(read({ file_path: p, pages: "1-25" })).rejects.toThrow(/at most 20 pages/);
		await expect(read({ file_path: p, pages: "40" })).rejects.toThrow(/only has 30 pages/);
		await expect(read({ file_path: p, pages: "x" })).rejects.toThrow(/Invalid pages/);
		const ok = await read({ file_path: p, pages: "25-40" });
		expect(ok.details.pages).toEqual([25, 30]);
	});

	it("renders pages without text as images", async () => {
		const p = join(dir, "scan.pdf");
		writeFileSync(p, makePdf(["Real text on page one", null]));
		const r = await read({ file_path: p });
		const text = resultText(r);
		expect(text).toContain("Real text on page one");
		expect(text).toContain('<page number="2">');
		const img = r.content.find((c: any) => c.type === "image");
		expect(img?.mimeType).toMatch(/^image\//);
	});

	it("errors clearly on corrupt PDFs", async () => {
		const p = join(dir, "bad.pdf");
		writeFileSync(p, "%PDF-1.4\ngarbage");
		await expect(read({ file_path: p })).rejects.toThrow(/PDF/);
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

	it("renders cells, outputs and images", async () => {
		const p = join(dir, "nb.ipynb");
		writeFileSync(p, JSON.stringify(nb, null, 1));
		const r = await read({ file_path: p });
		const text = resultText(r);
		expect(text).toContain('<cell id="md1"><cell_type>markdown</cell_type># Title\nSome text</cell id="md1">');
		expect(text).toContain("<cell id=\"c1\">print('hi')\n1+1</cell id=\"c1\">");
		expect(text).toMatch(/<outputs cell_id="c1">\nhi\n2\n<\/outputs>/);
		expect(text).toContain('<cell id="cell-2">plot()</cell id="cell-2">');
		expect(text).toContain("<Figure>");
		expect(text).toContain("ZeroDivisionError: division by zero\nTraceback\nline 1");
		expect(text).not.toContain("\u001b");
		const imgIdx = r.content.findIndex((c: any) => c.type === "image");
		expect(imgIdx).toBeGreaterThan(0);
		expect(r.details).toMatchObject({ kind: "notebook", cells: 4 });
		expect(cc.fileState.has(p)).toBe(true);
	});

	it("marks non-python code cells with language", async () => {
		const p = join(dir, "r.ipynb");
		writeFileSync(p, JSON.stringify({ metadata: { kernelspec: { language: "R" } }, cells: [{ cell_type: "code", source: "x <- 1", outputs: [] }] }));
		expect(resultText(await read({ file_path: p }))).toContain("<language>R</language>x <- 1");
	});

	it("allows Edit after reading a notebook", async () => {
		const p = join(dir, "nb.ipynb");
		writeFileSync(p, JSON.stringify(nb, null, 1));
		await read({ file_path: p });
		const r = await call("Edit", { file_path: p, old_string: "print('hi')", new_string: "print('bye')" });
		expect(resultText(r)).toContain("has been updated");
	});

	it("errors on invalid JSON and warns on empty notebooks", async () => {
		const bad = join(dir, "bad.ipynb");
		writeFileSync(bad, "{not json");
		await expect(read({ file_path: bad })).rejects.toThrow(/Failed to parse Jupyter notebook/);
		const empty = join(dir, "empty.ipynb");
		writeFileSync(empty, JSON.stringify({ cells: [] }));
		expect(resultText(await read({ file_path: empty }))).toContain("contains no cells");
	});
});

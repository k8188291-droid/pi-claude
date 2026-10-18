import type { Scenario } from "../types.js";

const lines = (n: number, f = (i: number) => `line ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1)).join("\n") + "\n";

// 1x1 transparent PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const notebook = JSON.stringify({
	cells: [
		{ cell_type: "markdown", id: "intro", metadata: {}, source: ["# Title\n", "Some text"] },
		{ cell_type: "code", id: "c1", metadata: {}, execution_count: 1, source: ["print('hi')"], outputs: [{ output_type: "stream", name: "stdout", text: ["hi\n"] }] },
	],
	metadata: { kernelspec: { name: "python3", language: "python", display_name: "Python 3" } },
	nbformat: 4,
	nbformat_minor: 5,
});

const notebook2 = JSON.stringify({
	cells: [
		{ cell_type: "code", execution_count: 3, metadata: {}, source: "1+1", outputs: [{ output_type: "execute_result", execution_count: 3, data: { "text/plain": ["2"], "text/html": ["<b>2</b>"] }, metadata: {} }] },
		{
			cell_type: "code",
			metadata: {},
			execution_count: null,
			source: ["raise ValueError('bad')"],
			outputs: [{ output_type: "error", ename: "ValueError", evalue: "bad", traceback: ["\u001b[0;31mValueError\u001b[0m: bad", "line two"] }],
		},
		{ cell_type: "code", metadata: {}, source: ["plot()"], outputs: [{ output_type: "display_data", data: { "image/png": PNG.toString("base64"), "text/plain": ["<Figure>"] }, metadata: {} }] },
		{ cell_type: "raw", metadata: {}, source: "raw text" },
		{ cell_type: "code", metadata: {}, source: [], outputs: [] },
	],
	metadata: { language_info: { name: "julia" } },
	nbformat: 4,
	nbformat_minor: 4,
});

const bigOutputNotebook = JSON.stringify({
	cells: [{ cell_type: "code", id: "big", metadata: {}, source: "spam()", outputs: [{ output_type: "stream", name: "stdout", text: "x".repeat(12000) }] }],
	metadata: {},
	nbformat: 4,
	nbformat_minor: 5,
});

/** Minimal valid PDF with one text line per page. */
function makePdf(pages: string[]): Buffer {
	const objs: string[] = [];
	const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
	objs.push("<< /Type /Catalog /Pages 2 0 R >>");
	objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
	objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
	pages.forEach((text, i) => {
		const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
		objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
		objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
	});
	let out = "%PDF-1.4\n";
	const offsets: number[] = [];
	objs.forEach((o, i) => {
		offsets.push(out.length);
		out += `${i + 1} 0 obj\n${o}\nendobj\n`;
	});
	const xref = out.length;
	out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
	for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
	out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(out, "latin1");
}

const R = (label: string, input: Record<string, unknown>) => ({ label, tool: "Read", input });

export const readScenarios: Scenario[] = [
	{
		name: "read-basic",
		description: "Read: offset/limit, long file, empty file, full file, unchanged re-read, missing file, directory, relative path, offset past EOF.",
		files: { "hello.txt": lines(5), "long.txt": lines(2500), "empty.txt": "", "dir/a.txt": "a\n" },
		prompt: "Read some files.",
		turns: [
			{
				calls: [
					{ label: "offset+limit", tool: "Read", input: { file_path: "{{cwd}}/hello.txt", offset: 2, limit: 2 } },
					{ label: "2500-line file", tool: "Read", input: { file_path: "{{cwd}}/long.txt" } },
					{ label: "empty file", tool: "Read", input: { file_path: "{{cwd}}/empty.txt" } },
				],
			},
			{ calls: [{ label: "full file", tool: "Read", input: { file_path: "{{cwd}}/hello.txt" } }] },
			{ calls: [{ label: "same file again (unchanged)", tool: "Read", input: { file_path: "{{cwd}}/hello.txt" } }] },
			{
				calls: [
					{ label: "missing file", tool: "Read", input: { file_path: "{{cwd}}/nope.txt" } },
					{ label: "directory", tool: "Read", input: { file_path: "{{cwd}}/dir" } },
					{ label: "relative path", tool: "Read", input: { file_path: "long.txt", limit: 3 } },
					{ label: "offset past EOF", tool: "Read", input: { file_path: "{{cwd}}/hello.txt", offset: 50 } },
				],
			},
			{ text: "done" },
		],
	},
	{
		name: "read-format",
		description: "Read line formatting: CRLF, no trailing newline, BOM, offset 0, limit only, very long line, tabs, last empty line, NUL bytes, invalid UTF-8, UTF-16LE.",
		files: {
			"crlf.txt": "one\r\ntwo\r\nthree\r\n",
			"nonl.txt": "alpha\nbeta",
			"bom.txt": "﻿bom line\nsecond\n",
			"ten.txt": lines(10),
			"longline.txt": `${"x".repeat(5000)}\nshort\n`,
			"tabs.txt": "\tindented\n  spaces\n",
			"nul.txt": Buffer.from("ab\u0000cd\nline2\n", "latin1"),
			"latin1.txt": Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]),
			"utf16.txt": Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hi\nthere\n", "utf16le")]),
			"blanks.txt": "a\n\n\nb\n",
		},
		prompt: "Read files in various formats.",
		turns: [
			{
				calls: [
					R("crlf", { file_path: "{{cwd}}/crlf.txt" }),
					R("no trailing newline", { file_path: "{{cwd}}/nonl.txt" }),
					R("bom", { file_path: "{{cwd}}/bom.txt" }),
					R("offset 0", { file_path: "{{cwd}}/ten.txt", offset: 0, limit: 2 }),
				],
			},
			{
				calls: [
					R("limit only", { file_path: "{{cwd}}/ten.txt", limit: 3 }),
					R("offset only", { file_path: "{{cwd}}/ten.txt", offset: 9 }),
					R("offset = last (empty) line", { file_path: "{{cwd}}/ten.txt", offset: 11 }),
					R("offset = totalLines+1", { file_path: "{{cwd}}/ten.txt", offset: 12 }),
				],
			},
			{
				calls: [
					R("5000-char line", { file_path: "{{cwd}}/longline.txt" }),
					R("tabs", { file_path: "{{cwd}}/tabs.txt" }),
					R("NUL bytes", { file_path: "{{cwd}}/nul.txt" }),
					R("invalid utf-8", { file_path: "{{cwd}}/latin1.txt" }),
				],
			},
			{
				calls: [
					R("utf-16le bom", { file_path: "{{cwd}}/utf16.txt" }),
					R("blank line slice", { file_path: "{{cwd}}/blanks.txt", offset: 2, limit: 1 }),
					R("blank lines slice", { file_path: "{{cwd}}/blanks.txt", offset: 2, limit: 2 }),
					R("crlf slice", { file_path: "{{cwd}}/crlf.txt", offset: 2, limit: 1 }),
				],
			},
			{ text: "done" },
		],
	},
	{
		name: "read-large",
		description: "Read size caps: >256KB text without limit, with limit, offset only; exactly 256KB vs one byte more.",
		files: {
			"big.txt": lines(30000, (i) => `row ${String(i).padStart(5, "0")} yyy`),
			"edge.txt": "z".repeat(262144),
			"edge2.txt": "z".repeat(262145),
		},
		prompt: "Read large files.",
		turns: [
			{
				calls: [
					R("big full", { file_path: "{{cwd}}/big.txt" }),
					R("big with limit", { file_path: "{{cwd}}/big.txt", offset: 100, limit: 3 }),
					R("big offset only", { file_path: "{{cwd}}/big.txt", offset: 29999 }),
				],
			},
			{
				calls: [
					R("exactly 256KB", { file_path: "{{cwd}}/edge.txt", limit: 1, offset: 2 }),
					R("256KB + 1 byte", { file_path: "{{cwd}}/edge2.txt" }),
				],
			},
			{ text: "done" },
		],
	},
	{
		name: "read-more",
		description: "Read: allow_large, MB-sized files, streaming (>10MB) files, parent-dir suggestion, empty-file slices, odd notebooks.",
		files: {
			"big.txt": lines(30000, (i) => `row ${String(i).padStart(5, "0")} yyy`),
			// over allow_large's room both with Claude Code's 200k window and pi's 1M window for this model
			"mb.txt": "q".repeat(9 * 1024 * 1024 + 300 * 1024),
			"huge.txt": "h".repeat(11 * 1024 * 1024),
			"sub/inner.txt": "inner\n",
			"empty.txt": "",
			"emptynb.ipynb": JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }),
			"badjson.ipynb": "{not json",
			"nocells.ipynb": JSON.stringify({ metadata: {} }),
		},
		prompt: "Read more files.",
		turns: [
			{
				calls: [
					R("allow_large big", { file_path: "{{cwd}}/big.txt", allow_large: true, offset: 29998 }),
					R("9.3MB, no room even with allow_large", { file_path: "{{cwd}}/mb.txt" }),
					R("11MB", { file_path: "{{cwd}}/huge.txt" }),
					R("parent-dir path", { file_path: "{{cwd}}/../sub/inner.txt" }),
				],
			},
			{
				calls: [
					R("empty offset 5", { file_path: "{{cwd}}/empty.txt", offset: 5 }),
					R("empty notebook", { file_path: "{{cwd}}/emptynb.ipynb" }),
					R("bad json notebook", { file_path: "{{cwd}}/badjson.ipynb" }),
					R("notebook without cells", { file_path: "{{cwd}}/nocells.ipynb" }),
				],
			},
			// one read of a file per turn: parallel reads of the same file race for the read state
			{ calls: [R("empty limit 1", { file_path: "{{cwd}}/empty.txt", limit: 1 })] },
			{ calls: [R("empty limit 1 again", { file_path: "{{cwd}}/empty.txt", limit: 1 })] },
			{ text: "done" },
		],
	},
	{
		name: "read-dedup",
		description: "Unchanged re-read detection: full/partial/same-range/different-range re-reads, after touch, after Edit, notebook and image re-reads.",
		files: { "f.txt": lines(6), "g.txt": lines(4), "nb.ipynb": notebook, "pixel.png": PNG },
		prompt: "Read files repeatedly.",
		turns: [
			{ calls: [R("full", { file_path: "{{cwd}}/f.txt" })] },
			{ calls: [R("full again", { file_path: "{{cwd}}/f.txt" })] },
			{ calls: [R("offset 1 explicit", { file_path: "{{cwd}}/f.txt", offset: 1 })] },
			{ calls: [R("limit 2", { file_path: "{{cwd}}/f.txt", limit: 2 })] },
			{ calls: [R("limit 2 again", { file_path: "{{cwd}}/f.txt", limit: 2 })] },
			{ calls: [R("full after partial", { file_path: "{{cwd}}/f.txt" })] },
			{ calls: [R("offset 2 limit 2", { file_path: "{{cwd}}/f.txt", offset: 2, limit: 2 })] },
			{ calls: [R("offset 2 limit 3", { file_path: "{{cwd}}/f.txt", offset: 2, limit: 3 })] },
			{ calls: [R("offset 2 limit 3 again", { file_path: "{{cwd}}/f.txt", offset: 2, limit: 3 })] },
			{ calls: [{ label: "touch (mtime only)", tool: "Bash", input: { command: "touch -d '2020-01-01 00:00:00' f.txt" } }] },
			{ calls: [R("after touch", { file_path: "{{cwd}}/f.txt", offset: 2, limit: 3 })] },
			{ calls: [R("g full", { file_path: "{{cwd}}/g.txt" })] },
			{ calls: [{ label: "Edit g", tool: "Edit", input: { file_path: "{{cwd}}/g.txt", old_string: "line 2", new_string: "LINE 2" } }] },
			{ calls: [R("g after Edit", { file_path: "{{cwd}}/g.txt" })] },
			{ calls: [R("g after Edit again", { file_path: "{{cwd}}/g.txt" })] },
			{ calls: [R("notebook", { file_path: "{{cwd}}/nb.ipynb" })] },
			{ calls: [R("notebook again", { file_path: "{{cwd}}/nb.ipynb" })] },
			{ calls: [R("notebook with offset", { file_path: "{{cwd}}/nb.ipynb", offset: 3 })] },
			{ calls: [R("image", { file_path: "{{cwd}}/pixel.png" })] },
			{ calls: [R("image again", { file_path: "{{cwd}}/pixel.png" })] },
			{ text: "done" },
		],
	},
	{
		name: "read-errors",
		description: "Read errors: similar-name suggestions, missing dir, binary extensions, bad image, empty image, device file, invalid pages.",
		files: { "notes.md": "notes\n", "archive.zip": Buffer.from("PK\u0003\u0004junk", "latin1"), "fake.png": "not an image\n", "empty.png": "", "data.txt": "data\n" },
		prompt: "Trigger read errors.",
		turns: [
			{
				calls: [
					R("missing, similar name", { file_path: "{{cwd}}/notes.txt" }),
					R("missing dir", { file_path: "{{cwd}}/nodir/file.txt" }),
					R("binary ext existing", { file_path: "{{cwd}}/archive.zip" }),
					R("binary ext missing", { file_path: "{{cwd}}/missing.exe" }),
				],
			},
			{
				calls: [
					R("fake png", { file_path: "{{cwd}}/fake.png" }),
					R("empty png", { file_path: "{{cwd}}/empty.png" }),
					R("device", { file_path: "/dev/zero" }),
					R("invalid pages", { file_path: "{{cwd}}/data.txt", pages: "1,3" }),
				],
			},
			{
				calls: [
					R("too many pages", { file_path: "{{cwd}}/data.txt", pages: "1-25" }),
					R("pages on text file", { file_path: "{{cwd}}/data.txt", pages: "2" }),
					R("missing, no suggestion", { file_path: "{{cwd}}/zzz.txt" }),
				],
			},
			{ text: "done" },
		],
	},
	{
		name: "read-media",
		description: "Read: PNG image, extensionless PNG, Jupyter notebooks, PDFs.",
		files: {
			"pixel.png": PNG,
			pixel: PNG,
			"nb.ipynb": notebook,
			"nb2.ipynb": notebook2,
			"bignb.ipynb": bigOutputNotebook,
			"doc.pdf": makePdf(["Hello PDF page one", "Second page text", "Third page"]),
			"many.pdf": makePdf(Array.from({ length: 12 }, (_, i) => `Page ${i + 1}`)),
		},
		prompt: "Look at the image and notebook.",
		turns: [
			{
				calls: [
					{ label: "png", tool: "Read", input: { file_path: "{{cwd}}/pixel.png" } },
					{ label: "ipynb", tool: "Read", input: { file_path: "{{cwd}}/nb.ipynb" } },
					R("extensionless png", { file_path: "{{cwd}}/pixel" }),
					R("notebook variety", { file_path: "{{cwd}}/nb2.ipynb" }),
				],
			},
			{
				calls: [
					R("notebook big outputs", { file_path: "{{cwd}}/bignb.ipynb" }),
					R("pdf whole", { file_path: "{{cwd}}/doc.pdf" }),
					R("pdf page 2", { file_path: "{{cwd}}/doc.pdf", pages: "2" }),
					R("pdf pages 2-3", { file_path: "{{cwd}}/doc.pdf", pages: "2-3" }),
				],
			},
			{
				calls: [
					R("pdf page past end", { file_path: "{{cwd}}/doc.pdf", pages: "5" }),
					R("pdf >10 pages whole", { file_path: "{{cwd}}/many.pdf" }),
					R("pdf open range", { file_path: "{{cwd}}/many.pdf", pages: "11-" }),
				],
			},
			{ text: "done" },
		],
	},
];

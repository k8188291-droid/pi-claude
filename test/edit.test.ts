import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { createCCContext, type CCContext } from "../src/shared/context.js";
import { applyEdit, editOutcome, findActualString, normalizeQuotes, preserveEscapeStyle, preserveQuoteStyle, registerEdit } from "../src/tools/edit.js";
import { registerRead } from "../src/tools/read.js";
import { registerWrite } from "../src/tools/write.js";
import { captureTools, createTestSession, fakeCtx, fauxAssistantMessage, fauxToolCall, resultText, tempDir } from "./helpers.js";

const CURRENT = " (file state is current in your context — no need to Read it back)";
const STALE_NOTE =
	" (note: the file had been modified on disk since you last read it — the edit applied cleanly, but the file contains other changes not in your context. Read it before edits that depend on surrounding content.)";

let dir: string;
let cc: CCContext;
let tools: Map<string, ToolDefinition>;
const call = (name: string, params: any, signal?: AbortSignal) =>
	tools.get(name)!.execute("id", params, signal, undefined, fakeCtx(dir)) as Promise<any>;
const edit = (params: any) => call("Edit", params);

function file(name: string, content: string | Buffer): string {
	const p = join(dir, name);
	writeFileSync(p, content);
	return p;
}

async function fileRead(name: string, content: string | Buffer): Promise<string> {
	const p = file(name, content);
	await call("Read", { file_path: p });
	return p;
}

/** Change a file behind the tools' back, with an mtime clearly after the recorded one. */
function externalWrite(p: string, content: string): void {
	writeFileSync(p, content);
	utimesSync(p, new Date(), new Date(Date.now() + 5000));
}

beforeEach(() => {
	dir = tempDir("pi-cc-edit-");
	({ tools } = captureTools((pi: ExtensionAPI) => {
		cc = createCCContext({});
		registerRead(pi, cc);
		registerWrite(pi, cc);
		registerEdit(pi, cc);
	}));
});

describe("Edit schema", () => {
	it("matches Claude Code's schema", () => {
		const params = tools.get("Edit")!.parameters as any;
		expect(Object.keys(params.properties)).toEqual(["file_path", "old_string", "new_string", "replace_all"]);
		expect(params.required).toEqual(["file_path", "old_string", "new_string"]);
		expect(params.properties.replace_all).toMatchObject({ default: false, description: "Replace all occurrences of old_string (default false)" });
		expect(tools.get("Edit")!.description).toMatch(/^Performs exact string replacements in files\.\n\nUsage:/);
	});
});

describe("pure helpers", () => {
	it("normalizes quotes", () => {
		expect(normalizeQuotes("“hi” ‘x’")).toBe(`"hi" 'x'`);
	});
	it("finds the file's spelling of old_string", () => {
		expect(findActualString("a “b” c", 'a "b"')).toBe("a “b”");
		expect(findActualString('x = "caf\\u00e9"', "café")).toBe("caf\\u00e9");
		expect(findActualString("x = café", "caf\\u00e9")).toBe("café");
		expect(findActualString("abc", "zzz")).toBeNull();
	});
	it("preserves curly quote style", () => {
		expect(preserveQuoteStyle(`"a"`, "“a”", `"b" it's`)).toBe("“b” it's");
		expect(preserveQuoteStyle(`'a'`, "‘a’", `'b' it's`)).toBe("‘b’ it’s");
		expect(preserveQuoteStyle("same", "same", `"x"`)).toBe(`"x"`);
	});
	it("preserves \\u escape style", () => {
		expect(preserveEscapeStyle("café", "caf\\u00e9", "naïve")).toBe("na\\u00efve");
		expect(preserveEscapeStyle("caf\\u00e9", "café", "na\\u00efve")).toBe("naïve");
	});
	it("classifies outcomes", () => {
		expect(editOutcome("a a", "a", false)).toBe("ambiguous");
		expect(editOutcome("a a", "a", true)).toBe("applies");
		expect(editOutcome("a", "", false)).toBe("no_match");
	});
	it("does not interpret $ patterns", () => {
		expect(applyEdit("a b a", "b", "$&$1$$")).toBe("a $&$1$$ a");
		expect(applyEdit("a b a", "a", "$'", true)).toBe("$' b $'");
	});
	it("removes the newline of a deleted line", () => {
		expect(applyEdit("keep\ndrop\nend\n", "drop", "")).toBe("keep\nend\n");
		expect(applyEdit("first\nlast", "last", "")).toBe("first\n");
	});
});

describe("Edit", () => {
	it("replaces a unique string; no snippet, file-state note after a full read", async () => {
		const p = await fileRead("a.ts", "const a = 1;\nconst b = 2;\n");
		const r = await edit({ file_path: p, old_string: "const b = 2;", new_string: "const b = 42;" });
		expect(readFileSync(p, "utf8")).toBe("const a = 1;\nconst b = 42;\n");
		expect(resultText(r)).toBe(`The file ${p} has been updated successfully.${CURRENT}`);
		expect(r.details).toMatchObject({ created: false, replaceAll: false, originalFile: "const a = 1;\nconst b = 2;\n" });
	});

	it("edits a never-read file, without the file-state note (also on the next edit)", async () => {
		const p = file("u.txt", "abc");
		expect(resultText(await edit({ file_path: p, old_string: "b", new_string: "x" }))).toBe(`The file ${p} has been updated successfully.`);
		expect(resultText(await edit({ file_path: p, old_string: "x", new_string: "y" }))).toBe(`The file ${p} has been updated successfully.`);
		expect(readFileSync(p, "utf8")).toBe("ayc");
	});

	it("keeps the note across consecutive edits after a read", async () => {
		const p = await fileRead("c.txt", "abc");
		await edit({ file_path: p, old_string: "b", new_string: "x" });
		const r = await edit({ file_path: p, old_string: "x", new_string: "y" });
		expect(resultText(r)).toBe(`The file ${p} has been updated successfully.${CURRENT}`);
	});

	it("omits the note after a partial read", async () => {
		const p = await fileRead("p.txt", "one\ntwo\nthree\n");
		await cc.fileState.recordRead(p, readFileSync(p), { partial: true, limit: 1 });
		expect(resultText(await edit({ file_path: p, old_string: "three", new_string: "3" }))).toBe(`The file ${p} has been updated successfully.`);
	});

	it("rejects a stale file when the edit does not apply", async () => {
		const p = await fileRead("s.txt", "abc");
		externalWrite(p, "abcd");
		await expect(edit({ file_path: p, old_string: "zzz", new_string: "x" })).rejects.toThrow(
			"File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.",
		);
		await expect(edit({ file_path: p, old_string: "x", new_string: "y" })).rejects.toThrow(/modified since read/);
	});

	it("applies to a stale file when the edit applies, with a note", async () => {
		const p = await fileRead("s.txt", "abc\n");
		externalWrite(p, "abc\nmore\n");
		const r = await edit({ file_path: p, old_string: "abc", new_string: "xyz" });
		expect(resultText(r)).toBe(`The file ${p} has been updated successfully.${STALE_NOTE}`);
		expect(readFileSync(p, "utf8")).toBe("xyz\nmore\n");
		// the model has not seen the rest of the file: no file-state note afterwards
		expect(resultText(await edit({ file_path: p, old_string: "more", new_string: "less" }))).toBe(`The file ${p} has been updated successfully.`);
	});

	it("ignores an mtime change that left the content the same", async () => {
		const p = await fileRead("t.txt", "abc");
		externalWrite(p, "abc");
		expect(resultText(await edit({ file_path: p, old_string: "b", new_string: "x" }))).toBe(`The file ${p} has been updated successfully.${CURRENT}`);
	});

	it("errors when old_string is not found", async () => {
		const p = file("n.txt", "abc");
		await expect(edit({ file_path: p, old_string: "zzz", new_string: "x" })).rejects.toThrow(/^String to replace not found in file.\nString: zzz$/);
		await expect(edit({ file_path: p, old_string: "zzé", new_string: "x" })).rejects.toThrow(/String: zzé\n\(note: Edit also tried swapping \\uXXXX escapes/);
	});

	it("errors on multiple matches without replace_all, replaces all with it", async () => {
		const p = file("m.txt", "foo\nfoo\nfoo\n");
		await expect(edit({ file_path: p, old_string: "foo", new_string: "bar" })).rejects.toThrow(
			"Found 3 matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: foo",
		);
		expect(readFileSync(p, "utf8")).toBe("foo\nfoo\nfoo\n");
		const r = await edit({ file_path: p, old_string: "foo", new_string: "bar", replace_all: true });
		expect(readFileSync(p, "utf8")).toBe("bar\nbar\nbar\n");
		expect(resultText(r)).toBe(`The file ${p} has been updated. All occurrences were successfully replaced.`);
	});

	it("errors when old_string equals new_string (even for a missing file)", async () => {
		await expect(edit({ file_path: join(dir, "nope.txt"), old_string: "b", new_string: "b" })).rejects.toThrow(
			"No changes to make: old_string and new_string are exactly the same.",
		);
	});

	it("creates a new file (and parents) with an empty old_string", async () => {
		const p = join(dir, "new", "dir", "f.txt");
		const r = await edit({ file_path: p, old_string: "", new_string: "fresh\n" });
		expect(resultText(r)).toBe(`The file ${p} has been updated successfully.${CURRENT}`);
		expect(readFileSync(p, "utf8")).toBe("fresh\n");
		expect(r.details.created).toBe(true);
		expect(resultText(await edit({ file_path: p, old_string: "fresh", new_string: "stale" }))).toBe(`The file ${p} has been updated successfully.${CURRENT}`);
	});

	it("refuses empty old_string on an existing non-blank file, fills a blank one", async () => {
		const p = file("x.txt", "content");
		await expect(edit({ file_path: p, old_string: "", new_string: "y" })).rejects.toThrow("Cannot create new file - file already exists.");
		const b = file("blank.txt", "  \n");
		expect(resultText(await edit({ file_path: b, old_string: "", new_string: "now full" }))).toBe(`The file ${b} has been updated successfully.`);
		expect(readFileSync(b, "utf8")).toBe("now full");
	});

	it("reports a missing file with the cwd and a similar name", async () => {
		await expect(edit({ file_path: join(dir, "missing.txt"), old_string: "a", new_string: "b" })).rejects.toThrow(
			`File does not exist. Note: your current working directory is ${dir}.`,
		);
		expect(existsSync(join(dir, "missing.txt"))).toBe(false);
		file("nf.txt", "x");
		await expect(edit({ file_path: join(dir, "nf.md"), old_string: "a", new_string: "b" })).rejects.toThrow(/ Did you mean nf\.txt\?$/);
	});

	it("refuses notebooks, binary and non-UTF-8 files", async () => {
		const nb = file("n.ipynb", '{"cells":[]}');
		await expect(edit({ file_path: nb, old_string: "cells", new_string: "x" })).rejects.toThrow("File is a Jupyter Notebook. Use the NotebookEdit to edit this file.");
		const bin = file("b.dat", Buffer.from([0x61, 0, 0x62]));
		await expect(edit({ file_path: bin, old_string: "a", new_string: "x" })).rejects.toThrow(/^File has NUL bytes in its first 8 KB/);
		const latin = file("l.txt", Buffer.from([0x63, 0xe9, 0x0a]));
		await expect(edit({ file_path: latin, old_string: "c", new_string: "x" })).rejects.toThrow(/^File is not valid UTF-8/);
	});

	it("errors on directories like Claude Code", async () => {
		mkdirSync(join(dir, "d"));
		await expect(edit({ file_path: join(dir, "d"), old_string: "a", new_string: "b" })).rejects.toThrow(
			"Error calling tool (Edit): EISDIR: illegal operation on a directory, read",
		);
	});

	it("echoes the file_path as given", async () => {
		file("rel.txt", "abc");
		expect(resultText(await edit({ file_path: "rel.txt", old_string: "b", new_string: "x" }))).toBe("The file rel.txt has been updated successfully.");
	});

	it("converts edits on CRLF files back to CRLF (also normalizing mixed files)", async () => {
		const p = await fileRead("crlf.txt", "one\r\ntwo\r\nthree\r\n");
		await edit({ file_path: p, old_string: "one\ntwo", new_string: "uno\ndos\nextra" });
		expect(readFileSync(p, "utf8")).toBe("uno\r\ndos\r\nextra\r\nthree\r\n");
		await expect(edit({ file_path: p, old_string: "dos\r\nextra", new_string: "DOS" })).rejects.toThrow(/String to replace not found/);
		const m = file("mixed.txt", "a\r\nb\r\nc\nd\r\n");
		await edit({ file_path: m, old_string: "c", new_string: "C" });
		expect(readFileSync(m, "utf8")).toBe("a\r\nb\r\nC\r\nd\r\n");
	});

	it("preserves a UTF-8 BOM and UTF-16LE encoding", async () => {
		const p = file("bom.txt", "﻿hello world\n");
		await edit({ file_path: p, old_string: "world", new_string: "there" });
		expect(readFileSync(p, "utf8")).toBe("﻿hello there\n");
		const u = file("u16.txt", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hi\r\nthere\r\n", "utf16le")]));
		await edit({ file_path: u, old_string: "there", new_string: "you" });
		expect(readFileSync(u).toString("utf16le")).toBe("﻿hi\r\nyou\r\n");
	});

	it("falls back to curly-quote normalization and keeps the file's quote style", async () => {
		const p = file("q.md", "He said “hello” and it’s fine.\n");
		await edit({ file_path: p, old_string: `said "hello" and it's`, new_string: `said "goodbye" and it's` });
		expect(readFileSync(p, "utf8")).toBe("He said “goodbye” and it’s fine.\n");
		await expect(edit({ file_path: p, old_string: `"goodbye"`, new_string: "“goodbye”" })).rejects.toThrow("String not found in file. Failed to apply edit.");
	});

	it("serializes concurrent edits on the same file", async () => {
		const p = await fileRead("conc.txt", "a b c d");
		await Promise.all([
			edit({ file_path: p, old_string: "a", new_string: "A" }),
			edit({ file_path: p, old_string: "b", new_string: "B" }),
			edit({ file_path: p, old_string: "c", new_string: "C" }),
		]);
		expect(readFileSync(p, "utf8")).toBe("A B C d");
	});
});

describe("end-to-end via faux model", () => {
	it("Edit (never read), Read, Edit, Write in a session", async () => {
		const cwd = tempDir("pi-cc-edit-e2e-");
		const p = join(cwd, "file.txt");
		writeFileSync(p, "hello world\n");
		const t = await createTestSession({
			cwd,
			responses: [
				fauxAssistantMessage(fauxToolCall("Edit", { file_path: p, old_string: "world", new_string: "pi" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("Read", { file_path: p }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("Edit", { file_path: p, old_string: "pi", new_string: "there" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("Write", { file_path: join(cwd, "new.txt"), content: "x" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			],
		});
		await t.session.prompt("go");
		const results = t.toolResults();
		expect(results.map((r) => [r.toolName, r.isError])).toEqual([
			["Edit", false],
			["Read", false],
			["Edit", false],
			["Write", false],
		]);
		expect(results[0].text).toBe(`The file ${p} has been updated successfully.`);
		expect(results[2].text).toBe(`The file ${p} has been updated successfully.${CURRENT}`);
		expect(results[3].text).toBe(`File created successfully at: ${join(cwd, "new.txt")}${CURRENT}`);
		expect(readFileSync(p, "utf8")).toBe("hello there\n");
		expect(readFileSync(join(cwd, "new.txt"), "utf8")).toBe("x");
		t.dispose();
	});
});

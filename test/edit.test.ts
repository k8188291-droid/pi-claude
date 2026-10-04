import { readFileSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { createCCContext, type CCContext } from "../src/shared/context.js";
import { applyEdits, buildSnippet, normalizeQuotes, preserveQuoteStyle, registerEdit } from "../src/tools/edit.js";
import { registerRead } from "../src/tools/read.js";
import { registerWrite } from "../src/tools/write.js";
import { captureTools, createTestSession, fakeCtx, fauxAssistantMessage, fauxToolCall, resultText, tempDir } from "./helpers.js";

let dir: string;
let cc: CCContext;
let tools: Map<string, ToolDefinition>;
const call = (name: string, params: any, signal?: AbortSignal) =>
	tools.get(name)!.execute("id", params, signal, undefined, fakeCtx(dir)) as Promise<any>;
const edit = (params: any) => call("Edit", params);

async function fileRead(name: string, content: string | Buffer): Promise<string> {
	const p = join(dir, name);
	writeFileSync(p, content);
	await call("Read", { file_path: p });
	return p;
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
	it("has Claude Code params plus edits", () => {
		const params = tools.get("Edit")!.parameters as any;
		expect(Object.keys(params.properties).sort()).toEqual(["edits", "file_path", "new_string", "old_string", "replace_all"]);
		expect(params.required).toEqual(["file_path"]);
		expect(params.properties.replace_all.default).toBe(false);
	});
});

describe("pure helpers", () => {
	it("normalizes quotes", () => {
		expect(normalizeQuotes("“hi” ‘x’")).toBe(`"hi" 'x'`);
	});
	it("preserves curly quote style", () => {
		expect(preserveQuoteStyle(`"a"`, "“a”", `"b" it's`)).toBe("“b” it's");
		expect(preserveQuoteStyle(`'a'`, "‘a’", `'b' it's`)).toBe("‘b’ it’s");
		expect(preserveQuoteStyle("same", "same", `"x"`)).toBe(`"x"`);
	});
	it("does not interpret $ patterns", () => {
		expect(applyEdits("a b a", [{ old_string: "b", new_string: "$&$1$$" }], true).content).toBe("a $&$1$$ a");
		expect(applyEdits("a b a", [{ old_string: "a", new_string: "$'", replace_all: true }], true).content).toBe("$' b $'");
	});
	it("builds snippets around the change", () => {
		const before = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
		const after = before.replace("l10\n", "CHANGED\n");
		const { snippet, firstChangedLine } = buildSnippet(before, after);
		expect(firstChangedLine).toBe(10);
		expect(snippet.split("\n")[0]).toBe("     6\tl6");
		expect(snippet).toContain("    10\tCHANGED");
		expect(snippet.split("\n").at(-1)).toBe("    14\tl14");
		expect(buildSnippet("x", "").snippet).toBe("");
	});
});

describe("Edit", () => {
	it("replaces a unique string and returns a numbered snippet", async () => {
		const p = await fileRead("a.ts", "const a = 1;\nconst b = 2;\nconst c = 3;\n");
		const r = await edit({ file_path: p, old_string: "const b = 2;", new_string: "const b = 42;" });
		expect(readFileSync(p, "utf8")).toBe("const a = 1;\nconst b = 42;\nconst c = 3;\n");
		const text = resultText(r);
		expect(text).toContain(`The file ${p} has been updated.`);
		expect(text).toContain("cat -n");
		expect(text).toContain("     2\tconst b = 42;");
		expect(text).toContain("     1\tconst a = 1;");
		expect(r.details).toMatchObject({ created: false, replacements: 1, firstChangedLine: 2 });
	});

	it("requires a prior read", async () => {
		const p = join(dir, "u.txt");
		writeFileSync(p, "abc");
		await expect(edit({ file_path: p, old_string: "b", new_string: "x" })).rejects.toThrow(/has not been read yet/);
	});

	it("refuses when the file changed since read", async () => {
		const p = await fileRead("c.txt", "abc");
		writeFileSync(p, "abcd");
		utimesSync(p, new Date(), new Date(Date.now() + 5000));
		await expect(edit({ file_path: p, old_string: "b", new_string: "x" })).rejects.toThrow(/modified since read/);
	});

	it("allows consecutive edits without re-reading", async () => {
		const p = await fileRead("c.txt", "abc");
		await edit({ file_path: p, old_string: "b", new_string: "x" });
		await edit({ file_path: p, old_string: "x", new_string: "y" });
		expect(readFileSync(p, "utf8")).toBe("ayc");
	});

	it("errors when old_string is not found", async () => {
		const p = await fileRead("n.txt", "abc");
		await expect(edit({ file_path: p, old_string: "zzz", new_string: "x" })).rejects.toThrow(/String to replace not found in file.\nString: zzz/);
	});

	it("errors on multiple matches without replace_all", async () => {
		const p = await fileRead("m.txt", "foo\nfoo\nfoo\n");
		await expect(edit({ file_path: p, old_string: "foo", new_string: "bar" })).rejects.toThrow(/Found 3 matches.*replace_all/s);
		expect(readFileSync(p, "utf8")).toBe("foo\nfoo\nfoo\n");
		const r = await edit({ file_path: p, old_string: "foo", new_string: "bar", replace_all: true });
		expect(readFileSync(p, "utf8")).toBe("bar\nbar\nbar\n");
		expect(resultText(r)).toContain("All 3 occurrences");
		expect(r.details.replacements).toBe(3);
	});

	it("errors when old_string equals new_string", async () => {
		const p = await fileRead("s.txt", "abc");
		await expect(edit({ file_path: p, old_string: "b", new_string: "b" })).rejects.toThrow(/No changes to make/);
	});

	it("creates a new file with an empty old_string", async () => {
		const p = join(dir, "new", "dir", "f.txt");
		const r = await edit({ file_path: p, old_string: "", new_string: "fresh\n" });
		expect(resultText(r)).toBe(`File created successfully at: ${p}`);
		expect(readFileSync(p, "utf8")).toBe("fresh\n");
		expect(r.details.created).toBe(true);
		// and can be edited again immediately
		await edit({ file_path: p, old_string: "fresh", new_string: "stale" });
		expect(readFileSync(p, "utf8")).toBe("stale\n");
	});

	it("refuses empty old_string on an existing non-empty file", async () => {
		const p = await fileRead("x.txt", "content");
		await expect(edit({ file_path: p, old_string: "", new_string: "y" })).rejects.toThrow(/file already exists/);
	});

	it("fills an existing empty file with an empty old_string", async () => {
		const p = await fileRead("empty.txt", "");
		await edit({ file_path: p, old_string: "", new_string: "now full" });
		expect(readFileSync(p, "utf8")).toBe("now full");
	});

	it("errors on a missing file with non-empty old_string", async () => {
		await expect(edit({ file_path: join(dir, "missing.txt"), old_string: "a", new_string: "b" })).rejects.toThrow(/does not exist/);
		expect(existsSync(join(dir, "missing.txt"))).toBe(false);
	});

	it("preserves CRLF line endings", async () => {
		const p = await fileRead("crlf.txt", "one\r\ntwo\r\nthree\r\n");
		await edit({ file_path: p, old_string: "one\ntwo", new_string: "uno\ndos\nextra" });
		expect(readFileSync(p, "utf8")).toBe("uno\r\ndos\r\nextra\r\nthree\r\n");
		// model passing CRLF strings also works
		await edit({ file_path: p, old_string: "dos\r\nextra", new_string: "DOS" });
		expect(readFileSync(p, "utf8")).toBe("uno\r\nDOS\r\nthree\r\n");
	});

	it("accepts CRLF strings on an LF file", async () => {
		const p = await fileRead("lf.txt", "a\nb\nc\n");
		await edit({ file_path: p, old_string: "a\r\nb", new_string: "x\r\ny" });
		expect(readFileSync(p, "utf8")).toBe("x\ny\nc\n");
	});

	it("matches mixed line-ending files exactly", async () => {
		const p = await fileRead("mixed.txt", "a\r\nb\nc\r\n");
		await edit({ file_path: p, old_string: "b\nc", new_string: "B\nC" });
		expect(readFileSync(p, "utf8")).toBe("a\r\nB\nC\r\n");
	});

	it("preserves a UTF-8 BOM", async () => {
		const p = await fileRead("bom.txt", "﻿hello world\n");
		await edit({ file_path: p, old_string: "world", new_string: "there" });
		const buf = readFileSync(p);
		expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
		expect(buf.toString("utf8")).toBe("﻿hello there\n");
	});

	it("falls back to curly-quote normalization and keeps the file's quote style", async () => {
		const p = await fileRead("q.md", "He said “hello” and it’s fine.\n");
		await edit({ file_path: p, old_string: `said "hello" and it's`, new_string: `said "goodbye" and it's` });
		expect(readFileSync(p, "utf8")).toBe("He said “goodbye” and it’s fine.\n");
	});

	it("applies multiple edits sequentially", async () => {
		const p = await fileRead("multi.txt", "alpha\nbeta\ngamma\n");
		const r = await edit({
			file_path: p,
			edits: [
				{ old_string: "alpha", new_string: "ALPHA" },
				{ old_string: "gamma", new_string: "delta" },
			],
		});
		expect(readFileSync(p, "utf8")).toBe("ALPHA\nbeta\ndelta\n");
		expect(resultText(r)).toContain("Applied 2 edits");
		expect(r.details.replacements).toBe(2);
	});

	it("is atomic: a failing edit leaves the file unchanged", async () => {
		const p = await fileRead("atomic.txt", "one two three");
		await expect(
			edit({ file_path: p, edits: [{ old_string: "one", new_string: "1" }, { old_string: "missing", new_string: "x" }] }),
		).rejects.toThrow(/Edit 2 of 2: String to replace not found/);
		expect(readFileSync(p, "utf8")).toBe("one two three");
	});

	it("rejects an old_string that is a substring of a previous new_string", async () => {
		const p = await fileRead("sub.txt", "a b c");
		await expect(
			edit({ file_path: p, edits: [{ old_string: "a", new_string: "xyz" }, { old_string: "y", new_string: "Y" }] }),
		).rejects.toThrow(/substring of a new_string from a previous edit/);
	});

	it("combines top-level old/new with edits", async () => {
		const p = await fileRead("combo.txt", "a b c");
		await edit({ file_path: p, old_string: "a", new_string: "A", edits: [{ old_string: "c", new_string: "C" }] });
		expect(readFileSync(p, "utf8")).toBe("A b C");
	});

	it("validates missing params", async () => {
		const p = await fileRead("v.txt", "abc");
		await expect(edit({ file_path: p })).rejects.toThrow(/Missing old_string/);
		await expect(edit({ file_path: p, old_string: "a" })).rejects.toThrow(/Both old_string and new_string/);
		await expect(edit({ file_path: p, edits: [{ old_string: "a" }] })).rejects.toThrow(/edits\[0\]/);
	});

	it("handles deleting text and emptying a file", async () => {
		const p = await fileRead("del.txt", "keep\nremove me\nkeep2\n");
		await edit({ file_path: p, old_string: "remove me\n", new_string: "" });
		expect(readFileSync(p, "utf8")).toBe("keep\nkeep2\n");
		const r = await edit({ file_path: p, old_string: "keep\nkeep2\n", new_string: "" });
		expect(readFileSync(p, "utf8")).toBe("");
		expect(resultText(r)).toContain("now empty");
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

	it("errors on directories", async () => {
		await expect(edit({ file_path: dir, old_string: "a", new_string: "b" })).rejects.toThrow(/is a directory/);
	});
});

describe("end-to-end via faux model", () => {
	it("Read then Edit then Write in a session", async () => {
		const cwd = tempDir("pi-cc-edit-e2e-");
		const p = join(cwd, "file.txt");
		writeFileSync(p, "hello world\n");
		const t = await createTestSession({
			cwd,
			responses: [
				fauxAssistantMessage(fauxToolCall("Edit", { file_path: p, old_string: "world", new_string: "pi" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("Read", { file_path: p }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("Edit", { file_path: p, old_string: "world", new_string: "pi" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("Write", { file_path: join(cwd, "new.txt"), content: "x" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			],
		});
		await t.session.prompt("go");
		const results = t.toolResults();
		expect(results.map((r) => [r.toolName, r.isError])).toEqual([
			["Edit", true],
			["Read", false],
			["Edit", false],
			["Write", false],
		]);
		expect(results[0].text).toMatch(/has not been read yet/);
		expect(results[1].text).toBe("     1\thello world");
		expect(readFileSync(p, "utf8")).toBe("hello pi\n");
		expect(readFileSync(join(cwd, "new.txt"), "utf8")).toBe("x");
		t.dispose();
	});
});

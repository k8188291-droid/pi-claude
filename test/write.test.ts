import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { createCCContext, type CCContext } from "../src/shared/context.js";
import { registerRead } from "../src/tools/read.js";
import { registerWrite } from "../src/tools/write.js";
import { captureTools, fakeCtx, resultText, tempDir } from "./helpers.js";

const CURRENT = " (file state is current in your context — no need to Read it back)";

let dir: string;
let cc: CCContext;
let tools: Map<string, ToolDefinition>;
const call = (name: string, params: any, signal?: AbortSignal) =>
	tools.get(name)!.execute("id", params, signal, undefined, fakeCtx(dir)) as Promise<any>;

beforeEach(() => {
	dir = tempDir("pi-cc-write-");
	({ tools } = captureTools((pi: ExtensionAPI) => {
		cc = createCCContext({});
		registerRead(pi, cc);
		registerWrite(pi, cc);
	}));
});

describe("Write", () => {
	it("has Claude Code schema and description", () => {
		const t = tools.get("Write")!;
		expect(Object.keys((t.parameters as any).properties)).toEqual(["file_path", "content"]);
		expect((t.parameters as any).required).toEqual(["file_path", "content"]);
		expect(t.description).toContain("- Prefer the Edit tool for modifying existing files — it only sends the diff.");
	});

	it("creates a new file with parent directories", async () => {
		const p = join(dir, "a", "b", "c.txt");
		const r = await call("Write", { file_path: p, content: "hello\n" });
		expect(resultText(r)).toBe(`File created successfully at: ${p}${CURRENT}`);
		expect(readFileSync(p, "utf8")).toBe("hello\n");
		expect(r.details).toMatchObject({ type: "create", bytes: 6, originalFile: null });
		expect(cc.fileState.has(p)).toBe(true);
	});

	it("resolves relative paths against cwd and echoes them as given", async () => {
		const r = await call("Write", { file_path: "rel.txt", content: "x" });
		expect(readFileSync(join(dir, "rel.txt"), "utf8")).toBe("x");
		expect(resultText(r)).toBe(`File created successfully at: rel.txt${CURRENT}`);
	});

	it("overwrites a never-read existing file", async () => {
		const p = join(dir, "e.txt");
		writeFileSync(p, "old");
		const r = await call("Write", { file_path: p, content: "new" });
		expect(resultText(r)).toBe(`The file ${p} has been updated successfully.${CURRENT}`);
		expect(readFileSync(p, "utf8")).toBe("new");
		expect(r.details).toMatchObject({ type: "update", originalFile: "old" });
	});

	it("refuses a never-read existing notebook", async () => {
		const p = join(dir, "n.ipynb");
		writeFileSync(p, "{}");
		await expect(call("Write", { file_path: p, content: "{ }" })).rejects.toThrow("File has not been read yet. Read it first before writing to it.");
	});

	it("refuses a file whose last read was a truncated view", async () => {
		const p = join(dir, "t.txt");
		writeFileSync(p, "old");
		cc.fileState.recordRead(p, "old", { truncated: true });
		await expect(call("Write", { file_path: p, content: "new" })).rejects.toThrow(/has not been read yet/);
	});

	it("allows a write after an offset/limit read", async () => {
		const p = join(dir, "o.txt");
		writeFileSync(p, "a\nb\nc\n");
		await call("Read", { file_path: p, offset: 2 });
		expect(resultText(await call("Write", { file_path: p, content: "new" }))).toBe(`The file ${p} has been updated successfully.${CURRENT}`);
	});

	it("refuses when the file changed since read", async () => {
		const p = join(dir, "e.txt");
		writeFileSync(p, "old");
		await call("Read", { file_path: p });
		writeFileSync(p, "changed externally");
		utimesSync(p, new Date(), new Date(Date.now() + 5000));
		await expect(call("Write", { file_path: p, content: "new" })).rejects.toThrow(
			"File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.",
		);
	});

	it("accepts an mtime change that left the content the same", async () => {
		const p = join(dir, "e.txt");
		writeFileSync(p, "same\r\n");
		await call("Read", { file_path: p });
		writeFileSync(p, "same\n");
		utimesSync(p, new Date(), new Date(Date.now() + 5000));
		await call("Write", { file_path: p, content: "new" });
		expect(readFileSync(p, "utf8")).toBe("new");
	});

	it("allows consecutive writes without re-reading", async () => {
		const p = join(dir, "w.txt");
		await call("Write", { file_path: p, content: "1" });
		await call("Write", { file_path: p, content: "2" });
		expect(readFileSync(p, "utf8")).toBe("2");
	});

	it("serializes concurrent writes to the same file", async () => {
		const p = join(dir, "c.txt");
		const results = await Promise.all(Array.from({ length: 5 }, (_, i) => call("Write", { file_path: p, content: `v${i}` })));
		expect(results.filter((r) => resultText(r).startsWith("File created")).length).toBe(1);
		expect(readFileSync(p, "utf8")).toMatch(/^v\d$/);
	});

	it("writes content as given (LF stays LF on a CRLF file, CRLF is kept)", async () => {
		const p = join(dir, "u.txt");
		writeFileSync(p, "a\r\nb\r\n");
		await call("Write", { file_path: p, content: "x\ny\n" });
		expect(readFileSync(p, "utf8")).toBe("x\ny\n");
		await call("Write", { file_path: p, content: "héllo — 世界\r\n" });
		expect(readFileSync(p, "utf8")).toBe("héllo — 世界\r\n");
		await call("Write", { file_path: p, content: "" });
		expect(readFileSync(p, "utf8")).toBe("");
	});

	it("keeps a UTF-8 BOM unless the new content is empty", async () => {
		const p = join(dir, "bom.txt");
		writeFileSync(p, "﻿old\n");
		await call("Write", { file_path: p, content: "new\n" });
		expect(readFileSync(p, "utf8")).toBe("﻿new\n");
		await call("Write", { file_path: p, content: "" });
		expect(readFileSync(p, "utf8")).toBe("");
	});

	it("refuses to overwrite a non-UTF-8 file", async () => {
		const p = join(dir, "l.txt");
		writeFileSync(p, Buffer.from([0x63, 0xe9, 0x0a]));
		await expect(call("Write", { file_path: p, content: "x" })).rejects.toThrow(/^File is not valid UTF-8/);
	});

	it("errors on directories", async () => {
		mkdirSync(join(dir, "d"));
		await expect(call("Write", { file_path: join(dir, "d"), content: "x" })).rejects.toThrow(
			`${join(dir, "d")} is a directory, not a file. To create a file inside it, include the file name in file_path.`,
		);
	});

	it("rejects when aborted", async () => {
		const ac = new AbortController();
		ac.abort();
		await expect(call("Write", { file_path: join(dir, "x"), content: "x" }, ac.signal)).rejects.toThrow(/aborted/);
	});
});

describe("Write in a subagent", () => {
	beforeEach(() => {
		dir = tempDir("pi-cc-write-");
		({ tools } = captureTools((pi: ExtensionAPI) => {
			cc = createCCContext({ isSubagent: true });
			registerWrite(pi, cc);
		}));
	});

	it("refuses report files", async () => {
		await expect(call("Write", { file_path: join(dir, "SUMMARY_notes.md"), content: "x" })).rejects.toThrow(
			"Subagents should return findings as text, not write report files. Include this content in your final response instead.",
		);
		await call("Write", { file_path: join(dir, "notes.md"), content: "x" });
	});
});

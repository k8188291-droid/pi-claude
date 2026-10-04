import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { createCCContext, type CCContext } from "../src/shared/context.js";
import { registerRead } from "../src/tools/read.js";
import { registerWrite } from "../src/tools/write.js";
import { captureTools, fakeCtx, resultText, tempDir } from "./helpers.js";

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
	it("has Claude Code schema", () => {
		const t = tools.get("Write")!;
		expect(Object.keys((t.parameters as any).properties).sort()).toEqual(["content", "file_path"]);
		expect((t.parameters as any).required.sort()).toEqual(["content", "file_path"]);
	});

	it("creates a new file with parent directories", async () => {
		const p = join(dir, "a", "b", "c.txt");
		const r = await call("Write", { file_path: p, content: "hello\n" });
		expect(resultText(r)).toBe(`File created successfully at: ${p}`);
		expect(readFileSync(p, "utf8")).toBe("hello\n");
		expect(r.details).toMatchObject({ type: "create", bytes: 6 });
		expect(cc.fileState.has(p)).toBe(true);
	});

	it("resolves relative paths against cwd", async () => {
		await call("Write", { file_path: "rel.txt", content: "x" });
		expect(readFileSync(join(dir, "rel.txt"), "utf8")).toBe("x");
	});

	it("refuses to overwrite an unread existing file", async () => {
		const p = join(dir, "e.txt");
		writeFileSync(p, "old");
		await expect(call("Write", { file_path: p, content: "new" })).rejects.toThrow(/has not been read yet/);
		expect(readFileSync(p, "utf8")).toBe("old");
	});

	it("overwrites after reading", async () => {
		const p = join(dir, "e.txt");
		writeFileSync(p, "old");
		await call("Read", { file_path: p });
		const r = await call("Write", { file_path: p, content: "new" });
		expect(resultText(r)).toBe(`The file ${p} has been updated successfully.`);
		expect(readFileSync(p, "utf8")).toBe("new");
		expect(r.details.type).toBe("update");
	});

	it("refuses when the file changed since read", async () => {
		const p = join(dir, "e.txt");
		writeFileSync(p, "old");
		await call("Read", { file_path: p });
		writeFileSync(p, "changed externally");
		utimesSync(p, new Date(), new Date(Date.now() + 5000));
		await expect(call("Write", { file_path: p, content: "new" })).rejects.toThrow(/modified since read/);
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

	it("writes empty content and unicode exactly", async () => {
		const p = join(dir, "u.txt");
		await call("Write", { file_path: p, content: "" });
		expect(readFileSync(p, "utf8")).toBe("");
		await call("Write", { file_path: p, content: "héllo — 世界\r\n" });
		expect(readFileSync(p, "utf8")).toBe("héllo — 世界\r\n");
	});

	it("errors on directories", async () => {
		mkdirSync(join(dir, "d"));
		await expect(call("Write", { file_path: join(dir, "d"), content: "x" })).rejects.toThrow(/is a directory/);
	});

	it("rejects when aborted", async () => {
		const ac = new AbortController();
		ac.abort();
		await expect(call("Write", { file_path: join(dir, "x"), content: "x" }, ac.signal)).rejects.toThrow(/aborted/);
	});
});

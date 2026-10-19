import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { compare, normalize } from "../parity/compare.js";
import { MockAnthropicServer, textOf } from "../parity/mock-server.js";
import type { RunOutcome, Scenario } from "../parity/types.js";
import { snapshot } from "../parity/workspace.js";

// Simulate EACCES even when the suite runs as root (where chmod 000 is not enforced).
vi.mock("node:fs", async (orig) => {
	const fs = await orig<typeof import("node:fs")>();
	const eacces = (p: unknown) => Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { code: "EACCES" });
	return {
		...fs,
		readFileSync: ((p: any, ...rest: any[]) => {
			if (String(p).endsWith("secret.txt")) throw eacces(p);
			return (fs.readFileSync as any)(p, ...rest);
		}) as typeof fs.readFileSync,
		readdirSync: ((p: any, ...rest: any[]) => {
			if (String(p).endsWith("locked")) throw eacces(p);
			return (fs.readdirSync as any)(p, ...rest);
		}) as typeof fs.readdirSync,
	};
});

const png = (bytes: number[]) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from(bytes).toString("base64") } });

describe("parity textOf / normalize", () => {
	it("renders images by mime type and sha256 instead of an empty string", () => {
		const a = textOf([{ type: "text", text: "hdr" }, png([1, 2, 3])]);
		const b = textOf([{ type: "text", text: "hdr" }, png([1, 2, 4])]);
		expect(a).toMatch(/^hdr\n<image image\/png 3 bytes sha256:[0-9a-f]{64}>$/);
		expect(a).not.toBe(b);
		expect(textOf([png([1, 2, 3])])).toBe(textOf([png([1, 2, 3])]));
		// survives normalization
		expect(normalize(a, "/nowhere")).toBe(a);
	});

	it("renders documents and unknown blocks", () => {
		const doc = textOf([{ type: "document", source: { type: "base64", media_type: "application/pdf", data: Buffer.from("%PDF").toString("base64") } }]);
		expect(doc).toMatch(/^<document application\/pdf 4 bytes sha256:[0-9a-f]{64}>$/);
		expect(textOf([{ type: "tool_reference", tool_name: "Foo" }])).toBe("<tool_reference Foo>");
		expect(textOf([{ type: "weird", z: 1, a: "x", cache_control: { type: "ephemeral" } }])).toBe('<weird {"a":"x","z":1}>');
		expect(textOf([{ type: "tool_result", content: [png([9])] }])).toMatch(/<image image\/png 1 bytes sha256:/);
	});

	it("reports image differences as a differing step", () => {
		const step = (text: string): RunOutcome["steps"][number] => ({ turn: 0, index: 0, label: "png", tool: "Read", toolUseId: "t", text, isError: false, status: "ok" });
		const outcome = (harness: "claude" | "pi", text: string): RunOutcome => ({ harness, steps: [step(text)], tools: [], subagentTools: {}, extraTurns: [], files: {}, durationMs: 0, cwd: "/x" });
		const s = { name: "img", description: "", prompt: "", turns: [] } as Scenario;
		expect(compare(s, outcome("claude", textOf([png([1])])), outcome("pi", textOf([png([2])]))).steps[0].verdict).toBe("differs");
		expect(compare(s, outcome("claude", textOf([png([1])])), outcome("pi", textOf([png([1])]))).steps[0].verdict).toBe("same");
	});
});

describe("parity workspace snapshot", () => {
	let root: string;
	let ws: string;
	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "parity-snap-test-"));
		ws = join(root, "ws");
		const outside = join(root, "outside");
		mkdirSync(outside);
		writeFileSync(join(outside, "SENTINEL.txt"), "outside\n");
		mkdirSync(join(ws, "sub", "deep"), { recursive: true });
		writeFileSync(join(ws, "a.txt"), "hello\n");
		writeFileSync(join(ws, "sub", "deep", "b.txt"), "deep\n");
		writeFileSync(join(ws, "bin1"), Buffer.from([0, 1, 2, 3]));
		writeFileSync(join(ws, "bin2"), Buffer.from([0, 1, 2, 4]));
		writeFileSync(join(ws, "secret.txt"), "nope\n");
		mkdirSync(join(ws, "locked"));
		symlinkSync(outside, join(ws, "link"));
		symlinkSync(".", join(ws, "loop"));
		symlinkSync(join(ws, "a.txt"), join(ws, "abs-link"));
		symlinkSync("missing", join(ws, "dangling"));
	});
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it("does not follow symlinks, loop, or crash on unreadable entries", () => {
		const snap = snapshot(ws);
		expect(Object.keys(snap).some((k) => k.includes("SENTINEL"))).toBe(false);
		expect(snap.link).toBe(`<symlink -> ${join(root, "outside")}>`);
		expect(snap.loop).toBe("<symlink -> .>");
		expect(snap["abs-link"]).toBe("<symlink -> <CWD>/a.txt>");
		expect(snap.dangling).toBe("<symlink -> missing>");
		expect(snap["secret.txt"]).toBe("<unreadable EACCES>");
		expect(snap.locked).toBe("<unreadable directory EACCES>");
		expect(snap["a.txt"]).toBe("hello\n");
		expect(snap[join("sub", "deep", "b.txt")]).toBe("deep\n");
	});

	it("hashes binary files so equal-size differences show up", () => {
		const snap = snapshot(ws);
		expect(snap.bin1).toMatch(/^<binary 4 bytes sha256:[0-9a-f]{64}>$/);
		expect(snap.bin1).not.toBe(snap.bin2);
	});

	it("compareFiles: [] does not walk; a list only reads the listed paths", () => {
		expect(snapshot(join(root, "does-not-exist"), [])).toEqual({});
		expect(snapshot(ws, ["sub/deep/b.txt", "loop", "nope.txt"])).toEqual({ [join("sub", "deep", "b.txt")]: "deep\n", loop: "<symlink -> .>" });
	});
});

describe("parity mock server robustness", () => {
	const mock = new MockAnthropicServer();
	let base: string;
	beforeAll(async () => {
		base = await mock.start();
	});
	afterAll(() => mock.stop());

	const post = (body: Buffer | string, headers: Record<string, string> = {}) =>
		new Promise<{ status: number; body: string }>((resolve, reject) => {
			const req = request(`${base}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", ...headers } }, (res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
			});
			req.on("error", reject);
			req.end(body);
		});
	const msg = (content: unknown) => JSON.stringify({ model: "m", tools: [{ name: "Read", input_schema: {} }], messages: [{ role: "user", content }] });

	it("answers a malformed gzip body with 400 and keeps serving", async () => {
		mock.load({ main: [{ text: "hi" }] }, "t");
		const bad = await post(Buffer.from("definitely not gzip"), { "content-encoding": "gzip" });
		expect(bad.status).toBe(400);
		expect(bad.body).toContain("bad gzip body");
		expect(mock.errors).toHaveLength(1);
		const good = await post(gzipSync(msg("hello")), { "content-encoding": "gzip" });
		expect(good.status).toBe(200);
		expect(JSON.parse(good.body).content[0].text).toBe("hi");
	});

	it("answers a throwing scripted input with 400 and keeps serving", async () => {
		mock.load(
			{
				main: [
					{
						calls: [
							{
								tool: "Read",
								input: () => {
									throw new Error("boom");
								},
							},
						],
					},
				],
			},
			"t",
		);
		const res = await post(msg("go"));
		expect(res.status).toBe(400);
		expect(res.body).toContain("boom");
		expect((await post("{not json")).status).toBe(400);
		mock.load({ main: [{ text: "again" }] }, "t");
		expect(mock.errors).toEqual([]);
		expect((await post(msg("go"))).status).toBe(200);
	});

	it("captures image tool results with their hash", async () => {
		mock.load({ main: [{ text: "a" }, { text: "b" }] }, "t");
		const body = JSON.stringify({
			model: "m",
			tools: [{ name: "Read", input_schema: {} }],
			messages: [
				{ role: "user", content: "go" },
				{ role: "assistant", content: [{ type: "tool_use", id: "x", name: "Read", input: {} }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: [png([7, 7])] }] },
			],
		});
		expect((await post(body)).status).toBe(200);
		expect(mock.requests.at(-1)!.toolResults[0].text).toMatch(/^<image image\/png 2 bytes sha256:[0-9a-f]{64}>$/);
	});
});

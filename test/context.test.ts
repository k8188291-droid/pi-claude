import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCCContext } from "../src/shared/context.js";
import type { ClaudeCodeHostEvent } from "../src/shared/types.js";

const event: ClaudeCodeHostEvent = { type: "output_spilled", toolName: "Bash", toolCallId: "t1", path: "/tmp/x", totalChars: 1 };

describe("CCContext.emit (#21)", () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	beforeEach(() => {
		unhandled.length = 0;
		process.on("unhandledRejection", onUnhandled);
	});
	afterEach(() => {
		process.off("unhandledRejection", onUnhandled);
	});

	const settle = () => new Promise((r) => setTimeout(r, 20));

	it("swallows a rejection from an async onEvent callback", async () => {
		const seen: ClaudeCodeHostEvent[] = [];
		const cc = createCCContext({
			onEvent: (async (e: ClaudeCodeHostEvent) => {
				seen.push(e);
				throw new Error("host async boom");
			}) as any,
		});
		expect(() => cc.emit(event)).not.toThrow();
		await settle();
		expect(seen).toEqual([event]);
		expect(unhandled).toEqual([]);
	});

	it("swallows a rejecting thenable and a synchronous throw", async () => {
		const thenable = { then: (_ok: unknown, fail: (e: unknown) => void) => fail(new Error("thenable boom")) };
		const cc1 = createCCContext({ onEvent: (() => thenable) as any });
		const cc2 = createCCContext({
			onEvent: () => {
				throw new Error("sync boom");
			},
		});
		expect(() => cc1.emit(event)).not.toThrow();
		expect(() => cc2.emit(event)).not.toThrow();
		await settle();
		expect(unhandled).toEqual([]);
	});

	it("still delivers events to synchronous callbacks", () => {
		const seen: ClaudeCodeHostEvent[] = [];
		const cc = createCCContext({ onEvent: (e) => seen.push(e) as unknown as void });
		cc.emit(event);
		expect(seen).toEqual([event]);
	});
});

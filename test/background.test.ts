import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalHost } from "../src/host/local.js";
import { BackgroundTaskRegistry, type BackgroundTask } from "../src/shared/background.js";
import { NotificationQueue } from "../src/shared/notifications.js";
import { tempDir } from "./helpers.js";

const bases: string[] = [];
afterEach(() => {
	for (const b of bases.splice(0)) rmSync(b, { recursive: true, force: true });
});

function registry(): BackgroundTaskRegistry {
	const base = tempDir("pi-cc-bgreg-");
	bases.push(base);
	return new BackgroundTaskRegistry(() => "sess/1", createLocalHost({ tmpBase: base }));
}

function task(id: string, stop: () => void | Promise<void> = () => {}): BackgroundTask {
	return { id, type: "local_bash", label: `cmd ${id}`, status: "running", stop };
}

describe("BackgroundTaskRegistry", () => {
	it("evicts a task as soon as it reaches a terminal status", () => {
		const r = registry();
		const a = r.add(task("ba"));
		const b = r.add(task("bb"));
		expect(r.list()).toEqual([a, b]);
		a.status = "completed";
		expect(r.get("ba")).toBeUndefined();
		expect(a.status).toBe("completed");
		b.status = "failed";
		expect(r.list()).toEqual([]);
	});

	it("stop() kills, marks killed and evicts; unknown and finished ids are not found", async () => {
		const r = registry();
		let stopped = 0;
		const t = r.add(task("bx", () => void stopped++));
		await r.stop("bx");
		expect(stopped).toBe(1);
		expect(t.status).toBe("killed");
		await expect(r.stop("bx")).rejects.toThrow("No task found with ID: bx");
	});

	it("stopAll() stops every running task", async () => {
		const r = registry();
		const ts = [r.add(task("b1")), r.add(task("b2"))];
		await r.stopAll();
		expect(ts.map((t) => t.status)).toEqual(["killed", "killed"]);
		expect(r.list()).toEqual([]);
	});

	it("evict() removes a task explicitly", () => {
		const r = registry();
		r.add(task("b1"));
		r.evict("b1");
		expect(r.list()).toEqual([]);
	});

	it.runIf(process.getuid !== undefined)("creates private output files and recreates missing directories", async () => {
		const r = registry();
		const { path } = await r.createOutputFile("b1");
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(path).toContain(`/pi-cc-${process.getuid!()}/sess_1/tasks/b1.output`);
		rmSync(dirname(dirname(path)), { recursive: true });
		expect(existsSync(dirname(path))).toBe(false);
		const again = await r.createOutputFile("b2");
		expect(readdirSync(dirname(again.path))).toEqual(["b2.output"]);
		expect(statSync(dirname(again.path)).mode & 0o777).toBe(0o700);
	});
});

describe("NotificationQueue", () => {
	function fakePi() {
		const handlers = new Map<string, Function[]>();
		const sent: Array<{ message: any; options: any }> = [];
		const pi = {
			on: (ev: string, h: Function) => handlers.set(ev, [...(handlers.get(ev) ?? []), h]),
			sendMessage: (message: any, options: any) => sent.push({ message, options }),
		} as unknown as ExtensionAPI;
		const fire = async (ev: string, event: any = { type: ev }) => {
			let out: any;
			for (const h of handlers.get(ev) ?? []) out = (await h(event, {})) ?? out;
			return out;
		};
		return { pi, sent, fire };
	}
	const tick = () => new Promise((r) => setTimeout(r, 10));

	it("starts a turn while idle", async () => {
		const f = fakePi();
		const q = new NotificationQueue(f.pi);
		q.enqueue("n1");
		expect(f.sent).toEqual([{ message: { customType: "cc-task-notification", content: "n1", display: false }, options: { deliverAs: "followUp", triggerTurn: true } }]);
	});

	it("drops queued notifications and sends nothing after session_shutdown", async () => {
		const f = fakePi();
		const q = new NotificationQueue(f.pi);
		q.attachToToolResults();
		await f.fire("agent_start");
		q.enqueue("queued while running");
		await f.fire("session_shutdown");
		await f.fire("agent_end");
		await tick();
		q.enqueue("after shutdown");
		await tick();
		expect(f.sent).toEqual([]);
		expect(await f.fire("tool_result", { content: [{ type: "text", text: "r" }] })).toBeUndefined();
		expect(q.isClosed).toBe(true);
	});
});

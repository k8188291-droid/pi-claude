/**
 * Scripted Anthropic Messages API server.
 *
 * Both harnesses (Claude Agent SDK / Claude Code and pi-claude) are pointed at this server, so they
 * receive byte-identical model output. Any difference in what they send back (tool results, files
 * on disk) comes from the harness, not the model.
 *
 * Routing is stateless: the next scripted turn is chosen by counting assistant messages already in
 * the request, so retries and side requests (titles, quota checks, ...) don't shift the script.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

export interface ScriptedCall {
	tool: string;
	/** Static input, or computed from the request (e.g. to reuse an id from the previous tool result). */
	input: Record<string, unknown> | ((req: CapturedRequest) => Record<string, unknown>);
}
export interface Turn {
	text?: string;
	calls?: ScriptedCall[];
}

export interface CapturedRequest {
	/** "main", a subagent script name, or "side" (tool-less helper requests). */
	route: string;
	turnIndex: number;
	model: string;
	system: string;
	toolNames: string[];
	tools: Array<{ name: string; description?: string; input_schema?: unknown }>;
	/** tool_result blocks from the last user message: tool_use_id → { text, isError } */
	toolResults: Array<{ toolUseId: string; text: string; isError: boolean }>;
	/** Every tool_result in the request, oldest first. */
	allToolResults: Array<{ toolUseId: string; text: string; isError: boolean }>;
	/** Raw text of the last user message (for reminders/notifications). */
	lastUserText: string;
}

export interface MockScript {
	main: Turn[];
	/** Subagent scripts, selected when the first user message contains `[[sub:NAME]]`. */
	subagents?: Record<string, Turn[]>;
	/** Extra routing for subagents without a marker (recordings): first user message contains `match` → route `name`. */
	subagentRoutes?: Array<{ name: string; match: string }>;
	/** Maps canonical tool names in the script to this harness's names (e.g. Task → Agent). */
	toolAliases?: Record<string, string>;
	/** Rewrites inputs for this harness (e.g. path placeholders). */
	render?: (input: Record<string, unknown>) => Record<string, unknown>;
}

const SUB_MARKER = /\[\[sub:([\w-]+)\]\]/;

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((b: any) => {
			if (b?.type === "text") return b.text;
			if (b?.type === "tool_result") return textOf(b.content);
			return "";
		})
		.join("\n");
}

function systemText(system: unknown): string {
	if (typeof system === "string") return system;
	if (Array.isArray(system)) return system.map((b: any) => b?.text ?? "").join("\n");
	return "";
}

/** One conversation captured in record mode (main agent or a subagent), keyed by its first user message. */
export interface RecordedConversation {
	firstUser: string;
	system: string;
	/** Assistant content per turn index (thinking blocks dropped). */
	turns: Array<{ content: any[] } | undefined>;
	/** Every tool_result the harness sent back, from the latest request of this conversation. */
	toolResults: Array<{ toolUseId: string; text: string; isError: boolean }>;
}

export class MockAnthropicServer {
	private server?: Server;
	private script?: MockScript;
	readonly requests: CapturedRequest[] = [];
	private idPrefix = "run";
	private recorder?: { upstream: string; apiKey?: string; model?: string; liveFile?: string };
	readonly recording = new Map<string, RecordedConversation>();

	/**
	 * Record mode: forward agent requests to a real Anthropic-compatible API and capture the model's turns.
	 * `apiKey` may be omitted when the upstream injects credentials (e.g. via an egress proxy);
	 * `model` overrides the model id sent upstream (e.g. a non-Claude model behind a translating proxy).
	 */
	startRecording(opts: { upstream?: string; apiKey?: string; model?: string; liveFile?: string }): void {
		this.recorder = { upstream: (opts.upstream ?? "https://api.anthropic.com").replace(/\/$/, ""), apiKey: opts.apiKey, model: opts.model, liveFile: opts.liveFile };
		this.recording.clear();
	}

	async start(): Promise<string> {
		this.server = createServer((req, res) => void this.handle(req, res));
		await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
		const { port } = this.server.address() as AddressInfo;
		return `http://127.0.0.1:${port}`;
	}

	async stop(): Promise<void> {
		await new Promise<void>((r) => this.server?.close(() => r()));
	}

	/** Load a script for the next run and clear captured requests. */
	load(script: MockScript, idPrefix: string): void {
		this.script = script;
		this.requests.length = 0;
		this.idPrefix = idPrefix;
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = req.url ?? "";
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		let buf = Buffer.concat(chunks);
		if (req.headers["content-encoding"] === "gzip") buf = gunzipSync(buf);
		const raw = buf.toString("utf8");
		if (req.method === "POST" && /\/v1\/messages\/count_tokens/.test(url)) {
			return json(res, 200, { input_tokens: 100 });
		}
		if (req.method !== "POST" || !/\/v1\/messages/.test(url)) {
			return json(res, 404, { type: "error", error: { type: "not_found_error", message: `mock: ${req.method} ${url}` } });
		}
		let body: any;
		try {
			body = JSON.parse(raw);
		} catch {
			return json(res, 400, { type: "error", error: { type: "invalid_request_error", message: "bad json" } });
		}
		// record mode: real model for agent turns; helper requests (titles, quota checks) stay local
		if (this.recorder && (body.tools?.length ?? 0) > 0) return this.proxy(req, res, url, raw);
		const messages: any[] = body.messages ?? [];
		const tools: any[] = body.tools ?? [];
		const firstUser = textOf(messages.find((m) => m.role === "user")?.content);
		const last = messages.at(-1);
		const sub =
			SUB_MARKER.exec(firstUser)?.[1] ??
			this.script?.subagentRoutes
				?.filter((r) => firstUser.includes(r.match))
				.sort((a, b) => b.match.length - a.match.length)[0]?.name;
		const hasTools = tools.length > 0;
		const route = !hasTools ? "side" : sub ?? "main";
		const turnIndex = messages.filter((m) => m.role === "assistant").length;
		const toolResults =
			last?.role === "user" && Array.isArray(last.content)
				? last.content
						.filter((b: any) => b?.type === "tool_result")
						.map((b: any) => ({ toolUseId: b.tool_use_id, text: textOf(b.content), isError: !!b.is_error }))
				: [];
		const allToolResults = messages
			.filter((m) => m.role === "user" && Array.isArray(m.content))
			.flatMap((m) => m.content.filter((b: any) => b?.type === "tool_result"))
			.map((b: any) => ({ toolUseId: b.tool_use_id, text: textOf(b.content), isError: !!b.is_error }));
		this.requests.push({
			route,
			turnIndex,
			model: body.model,
			system: systemText(body.system),
			toolNames: tools.map((t) => t.name),
			tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
			toolResults,
			allToolResults,
			lastUserText: last?.role === "user" ? textOf(last.content) : "",
		});

		let turn: Turn;
		if (route === "side") turn = { text: "ok" };
		else {
			const turns = route === "main" ? this.script?.main : this.script?.subagents?.[route];
			turn = turns?.[turnIndex] ?? { text: `[mock] script exhausted (${route} turn ${turnIndex})` };
		}
		const content = this.renderTurn(turn, route, turnIndex, this.requests.at(-1)!);
		const stopReason = content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
		const message = {
			id: `msg_${this.idPrefix}_${route}_${turnIndex}_${this.requests.length}`,
			type: "message",
			role: "assistant",
			model: body.model,
			content,
			stop_reason: stopReason,
			stop_sequence: null,
			usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
		};
		if (body.stream) return sse(res, message);
		return json(res, 200, message);
	}

	/** Record mode: pass the request through to the real API and capture the assistant turn. */
	private async proxy(req: IncomingMessage, res: ServerResponse, url: string, raw: string): Promise<void> {
		if (/\/count_tokens/.test(url)) return json(res, 200, { input_tokens: 100 });
		const rec = this.recorder!;
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (rec.apiKey) headers["x-api-key"] = rec.apiKey;
		if (rec.model) {
			const b = JSON.parse(raw);
			b.model = rec.model;
			raw = JSON.stringify(b);
		}
		for (const h of ["anthropic-version", "anthropic-beta", "accept"]) {
			const v = req.headers[h];
			if (typeof v === "string") headers[h] = v;
		}
		const upstream = await fetch(rec.upstream + url, { method: req.method, headers, body: req.method === "POST" ? raw : undefined });
		const resHeaders: Record<string, string> = {};
		upstream.headers.forEach((v, k) => {
			if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k)) resHeaders[k] = v;
		});
		res.writeHead(upstream.status, resHeaders);
		const text = await upstream.text();
		res.end(text);
		if (upstream.status >= 400) process.stderr.write(`[record] upstream ${req.method} ${url} → ${upstream.status}: ${text.slice(0, 300)}\n`);

		let body: any;
		try {
			body = JSON.parse(raw);
		} catch {
			return;
		}
		if (!/\/v1\/messages(\?|$)/.test(url) || !(body.tools?.length > 0) || upstream.status !== 200) return;
		const messages: any[] = body.messages ?? [];
		const firstUser = textOf(messages.find((m) => m.role === "user")?.content);
		const turnIndex = messages.filter((m) => m.role === "assistant").length;
		const content = body.stream ? contentFromSse(text) : (JSON.parse(text).content ?? []);
		let conv = this.recording.get(firstUser);
		if (!conv) {
			conv = { firstUser, system: systemText(body.system), turns: [], toolResults: [] };
			this.recording.set(firstUser, conv);
		}
		conv.turns[turnIndex] = { content: content.filter((b: any) => b.type === "text" || b.type === "tool_use") };
		conv.toolResults = messages
			.filter((m) => m.role === "user" && Array.isArray(m.content))
			.flatMap((m) => m.content.filter((b: any) => b?.type === "tool_result"))
			.map((b: any) => ({ toolUseId: b.tool_use_id, text: textOf(b.content), isError: !!b.is_error }));
		// checkpoint after every captured turn, so an interrupted recording is not lost
		if (rec.liveFile) {
			try {
				writeFileSync(rec.liveFile, JSON.stringify({ conversations: [...this.recording.values()] }));
			} catch {
				// best effort
			}
		}
	}

	private renderTurn(turn: Turn, route: string, turnIndex: number, req: CapturedRequest): any[] {
		const out: any[] = [];
		if (turn.text) out.push({ type: "text", text: turn.text });
		(turn.calls ?? []).forEach((c, i) => {
			const name = this.script?.toolAliases?.[c.tool] ?? c.tool;
			const raw = typeof c.input === "function" ? c.input(req) : c.input;
			const input = this.script?.render ? this.script.render(raw) : raw;
			out.push({ type: "tool_use", id: toolUseId(route, turnIndex, i), name, input });
		});
		if (out.length === 0) out.push({ type: "text", text: "" });
		return out;
	}
}

/** Deterministic tool_use id, identical for both harnesses. */
export function toolUseId(route: string, turnIndex: number, i: number): string {
	return `toolu_${route.replace(/\W/g, "")}_${turnIndex}_${i}`;
}

function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json", "request-id": "req_mock" });
	res.end(JSON.stringify(body));
}

function sse(res: ServerResponse, message: any): void {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "request-id": "req_mock" });
	const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	const { content, stop_reason, usage, ...rest } = message;
	send("message_start", { type: "message_start", message: { ...rest, content: [], stop_reason: null, usage: { ...usage, output_tokens: 1 } } });
	content.forEach((block: any, index: number) => {
		if (block.type === "text") {
			send("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
			send("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
		} else {
			send("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
			send("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
		}
		send("content_block_stop", { type: "content_block_stop", index });
	});
	send("message_delta", { type: "message_delta", delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
	send("message_stop", { type: "message_stop" });
	res.end();
}

/** Rebuild the assistant content blocks from an Anthropic SSE stream. */
export function contentFromSse(text: string): any[] {
	const blocks: any[] = [];
	const json: Record<number, string> = {};
	for (const line of text.split("\n")) {
		if (!line.startsWith("data:")) continue;
		let ev: any;
		try {
			ev = JSON.parse(line.slice(5).trim());
		} catch {
			continue;
		}
		if (ev.type === "content_block_start") {
			blocks[ev.index] = { ...ev.content_block };
			if (ev.content_block.type === "tool_use") json[ev.index] = "";
		} else if (ev.type === "content_block_delta") {
			const b = blocks[ev.index];
			if (!b) continue;
			if (ev.delta.type === "text_delta") b.text = (b.text ?? "") + ev.delta.text;
			else if (ev.delta.type === "input_json_delta") json[ev.index] += ev.delta.partial_json;
		} else if (ev.type === "content_block_stop" && json[ev.index] !== undefined) {
			try {
				blocks[ev.index].input = json[ev.index] ? JSON.parse(json[ev.index]) : {};
			} catch {
				blocks[ev.index].input = {};
			}
		}
	}
	return blocks.filter(Boolean);
}

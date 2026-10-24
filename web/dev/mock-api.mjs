// 本機的假 Managed Agents API，用來在不花 API 額度的情況下開發、測試介面。
// 只實作介面會用到的端點，agent 的回應是寫死的劇本。
//
//   node dev/mock-api.mjs            # 預設 http://localhost:4010
//   UPSTREAM_URL=http://localhost:4010 npm run dev
//
// 訊息裡含有「rm」時，agent 會要求執行一個需要核准的指令，用來測試核准流程。
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 4010);
const now = () => new Date().toISOString();
let seq = 0;
const id = (prefix) => `${prefix}_mock${(++seq).toString().padStart(6, "0")}`;

const agents = new Map();
const environments = new Map();
const sessions = new Map(); // id -> { session, events: [], clients: Set<res>, pendingAsk }

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data ? JSON.parse(data) : {}));
  });
}

function emit(s, event, { persist = true } = {}) {
  if (persist) s.events.push(event);
  for (const res of s.clients) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setStatus(s, status, extra = {}) {
  s.session.status = status;
  s.session.updated_at = now();
  emit(s, { id: id("sevt"), type: `session.status_${status}`, processed_at: now(), ...extra });
}

async function streamText(s, text) {
  const evId = id("sevt");
  emit(s, { type: "event_start", event: { type: "agent.message", id: evId } }, { persist: false });
  let sent = "";
  for (const chunk of text.match(/.{1,6}/gsu) ?? []) {
    sent += chunk;
    emit(
      s,
      { type: "event_delta", event_id: evId, delta: { type: "content_delta", index: 0, content: { type: "text", text: chunk } } },
      { persist: false },
    );
    await sleep(25);
  }
  emit(s, { id: evId, type: "agent.message", processed_at: now(), content: [{ type: "text", text: sent }] });
}

function addCost(s, cents) {
  const prev = Number(s.session.usage.list_cost?.amount ?? 0);
  s.session.usage.list_cost = { amount: String(prev + cents), currency: "USD" };
  emit(s, { id: id("sevt"), type: "session.usage", processed_at: now(), usage: { ...s.session.usage } });
}

async function runTurn(s, userText) {
  setStatus(s, "running");
  emit(s, { id: id("sevt"), type: "span.model_request_start", processed_at: now() });
  const thinkingId = id("sevt");
  emit(s, { type: "event_start", event: { type: "agent.thinking", id: thinkingId } }, { persist: false });
  await sleep(500);
  emit(s, { id: thinkingId, type: "agent.thinking", processed_at: now() });
  await streamText(s, `好的，我先看一下專案結構。你說的是：「${userText.slice(0, 60)}」`);
  const toolId = id("sevt");
  emit(s, {
    id: toolId,
    type: "agent.tool_use",
    name: "bash",
    input: { command: "ls -la /workspace && git -C /workspace status --short" },
    evaluated_permission: "allow",
    evaluation: { type: "auto", evaluated_permission: { type: "allow" } },
    processed_at: now(),
  });
  await sleep(400);
  emit(s, {
    id: id("sevt"),
    type: "agent.tool_result",
    tool_use_id: toolId,
    content: [{ type: "text", text: "total 12\ndrwxr-xr-x 3 root root 4096 .\n-rw-r--r-- 1 root root  120 README.md\n M src/index.ts" }],
    is_error: false,
    processed_at: now(),
  });
  const readId = id("sevt");
  emit(s, {
    id: readId,
    type: "agent.tool_use",
    name: "read",
    input: { file_path: "/workspace/README.md" },
    evaluated_permission: "allow",
    processed_at: now(),
  });
  await sleep(250);
  emit(s, {
    id: id("sevt"),
    type: "agent.tool_result",
    tool_use_id: readId,
    content: [{ type: "text", text: "# demo\n\nA demo repository." }],
    processed_at: now(),
  });

  if (/\brm\b/.test(userText)) {
    const askId = id("sevt");
    s.pendingAsk = askId;
    emit(s, {
      id: askId,
      type: "agent.tool_use",
      name: "bash",
      input: { command: "rm -rf /workspace/build" },
      evaluated_permission: "ask",
      evaluation: { type: "auto", evaluated_permission: { type: "ask" } },
      processed_at: now(),
    });
    emit(s, { id: id("sevt"), type: "span.model_request_end", processed_at: now(), is_error: false });
    addCost(s, 3);
    setStatus(s, "idle", { stop_reason: { type: "requires_action", event_ids: [askId] }, stop_details: null });
    return;
  }
  await finishTurn(s);
}

async function finishTurn(s) {
  await streamText(
    s,
    "完成了。摘要：\n\n- 專案只有一個 `README.md`\n- `src/index.ts` 有未提交的修改\n\n```bash\ngit diff src/index.ts\n```\n\n需要我繼續做什麼嗎？",
  );
  emit(s, {
    id: id("sevt"),
    type: "span.model_request_end",
    processed_at: now(),
    is_error: false,
    model_usage: { input_tokens: 1200, output_tokens: 180, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });
  addCost(s, 4);
  setStatus(s, "idle", { stop_reason: { type: "end_turn" }, stop_details: null });
}

async function handleEvents(s, events) {
  const echoed = [];
  for (const ev of events) {
    if (ev.type === "user.message") {
      if (s.session.status === "idle" && s.pendingAsk) {
        const err = new Error("Session is waiting on a tool confirmation.");
        err.status = 400;
        throw err;
      }
      const e = { ...ev, id: id("sevt"), processed_at: now() };
      emit(s, e);
      echoed.push(e);
      const text = ev.content.map((b) => b.text ?? "").join("\n");
      setTimeout(() => runTurn(s, text), 50);
    } else if (ev.type === "user.tool_confirmation") {
      const e = { ...ev, id: id("sevt"), processed_at: now() };
      emit(s, e);
      echoed.push(e);
      s.pendingAsk = undefined;
      setTimeout(async () => {
        setStatus(s, "running");
        const allowed = ev.result === "allow";
        emit(s, {
          id: id("sevt"),
          type: "agent.tool_result",
          tool_use_id: ev.tool_use_id,
          content: [{ type: "text", text: allowed ? "" : (ev.deny_message ?? "Permission denied by user.") }],
          is_error: !allowed,
          processed_at: now(),
        });
        await finishTurn(s);
      }, 50);
    } else if (ev.type === "user.interrupt") {
      const e = { ...ev, id: "", processed_at: now() };
      emit(s, e);
      echoed.push(e);
    } else {
      const e = { ...ev, id: id("sevt"), processed_at: now() };
      emit(s, e);
      echoed.push(e);
    }
  }
  return echoed;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const m = (re) => p.match(re);
  let r;
  try {
    if (req.method === "GET" && p === "/v1/agents") return json(res, 200, { data: [...agents.values()], next_page: null });
    if (req.method === "POST" && p === "/v1/agents") {
      const b = await readBody(req);
      const a = {
        type: "agent",
        id: id("agent"),
        version: 1,
        name: b.name,
        description: b.description ?? null,
        model: typeof b.model === "string" ? { id: b.model } : { ...b.model, effort: b.model.effort ? { type: b.model.effort } : undefined },
        system: b.system ?? null,
        tools: b.tools ?? [],
        mcp_servers: [],
        skills: [],
        metadata: b.metadata ?? {},
        multiagent: null,
        archived_at: null,
        created_at: now(),
        updated_at: now(),
      };
      agents.set(a.id, a);
      return json(res, 200, a);
    }
    if ((r = m(/^\/v1\/agents\/([^/]+)$/))) {
      const a = agents.get(r[1]);
      if (!a) return json(res, 404, { type: "error", error: { type: "not_found_error", message: "agent not found" } });
      if (req.method === "GET") return json(res, 200, a);
      const b = await readBody(req);
      if (b.version && b.version !== a.version)
        return json(res, 409, { type: "error", error: { type: "invalid_request_error", message: "version mismatch" } });
      Object.assign(a, b, {
        model: b.model ? { ...b.model, effort: b.model.effort ? { type: b.model.effort } : undefined } : a.model,
        version: a.version + 1,
        updated_at: now(),
      });
      return json(res, 200, a);
    }
    if (req.method === "GET" && p === "/v1/environments")
      return json(res, 200, { data: [...environments.values()], next_page: null });
    if (req.method === "POST" && p === "/v1/environments") {
      const b = await readBody(req);
      const net = b.config?.networking ?? { type: "unrestricted" };
      const e = {
        type: "environment",
        id: id("env"),
        name: b.name,
        config: {
          type: "cloud",
          packages: {},
          networking:
            net.type === "limited"
              ? { allowed_hosts: [], allow_mcp_servers: false, allow_package_managers: false, ...net }
              : net,
        },
        created_at: now(),
        archived_at: null,
      };
      environments.set(e.id, e);
      return json(res, 200, e);
    }
    if ((r = m(/^\/v1\/environments\/([^/]+)$/)) && req.method === "POST") {
      const e = environments.get(r[1]);
      Object.assign(e, await readBody(req));
      return json(res, 200, e);
    }
    if (req.method === "GET" && p === "/v1/sessions") {
      const list = [...sessions.values()].map((s) => s.session).reverse();
      return json(res, 200, { data: list, next_page: null, prev_page: null });
    }
    if (req.method === "POST" && p === "/v1/sessions") {
      const b = await readBody(req);
      if (!agents.has(b.agent)) return json(res, 400, { type: "error", error: { type: "invalid_request_error", message: "unknown agent" } });
      const session = {
        type: "session",
        id: id("sesn"),
        title: b.title ?? null,
        status: "idle",
        agent: agents.get(b.agent),
        environment_id: b.environment_id,
        resources: b.resources ?? [],
        metadata: b.metadata ?? {},
        budget: b.budget ?? null,
        usage: { list_cost: { amount: "0", currency: "USD" } },
        stats: {},
        outcome_evaluations: [],
        archived_at: null,
        created_at: now(),
        updated_at: now(),
      };
      const s = { session, events: [], clients: new Set() };
      sessions.set(session.id, s);
      if (b.initial_events?.length) await handleEvents(s, b.initial_events);
      return json(res, 200, session);
    }
    if ((r = m(/^\/v1\/sessions\/([^/]+)$/))) {
      const s = sessions.get(r[1]);
      if (!s) return json(res, 404, { type: "error", error: { type: "not_found_error", message: "session not found" } });
      if (req.method === "DELETE") {
        sessions.delete(r[1]);
        return json(res, 200, { id: r[1], type: "session_deleted" });
      }
      return json(res, 200, s.session);
    }
    if ((r = m(/^\/v1\/sessions\/([^/]+)\/events\/stream$/))) {
      const s = sessions.get(r[1]);
      if (!s) return json(res, 404, { type: "error", error: { type: "not_found_error", message: "session not found" } });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.flushHeaders();
      s.clients.add(res);
      const ping = setInterval(() => res.write("event: ping\ndata: {}\n\n"), 15000);
      req.on("close", () => {
        clearInterval(ping);
        s.clients.delete(res);
      });
      return;
    }
    if ((r = m(/^\/v1\/sessions\/([^/]+)\/events$/))) {
      const s = sessions.get(r[1]);
      if (!s) return json(res, 404, { type: "error", error: { type: "not_found_error", message: "session not found" } });
      if (req.method === "GET") return json(res, 200, { data: s.events, next_page: null });
      const b = await readBody(req);
      try {
        return json(res, 200, { data: await handleEvents(s, b.events) });
      } catch (err) {
        return json(res, err.status ?? 500, { type: "error", error: { type: "invalid_request_error", message: err.message } });
      }
    }
    if (req.method === "GET" && p === "/v1/files") {
      const scoped = url.searchParams.get("scope_id");
      const data = scoped
        ? [{ id: "file_mock1", type: "file", filename: "report.md", size_bytes: 2048, mime_type: "text/markdown", created_at: now() }]
        : [];
      return json(res, 200, { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data[0]?.id ?? null });
    }
    if (req.method === "GET" && p === "/v1/files/file_mock1/content") {
      res.writeHead(200, { "content-type": "text/markdown" });
      return res.end("# Report\n\nGenerated by the mock agent.\n");
    }
    json(res, 404, { type: "error", error: { type: "not_found_error", message: `mock: ${req.method} ${p}` } });
  } catch (err) {
    json(res, 500, { type: "error", error: { type: "api_error", message: String(err) } });
  }
});

server.listen(PORT, () => console.log(`mock Managed Agents API on http://localhost:${PORT}`));

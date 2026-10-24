// 正式環境的伺服器：提供 dist/ 靜態檔，並把 /anthropic/v1/* 原封不動轉送到 Anthropic API。
// 伺服器不保存任何 API key；key 由瀏覽器在每個請求的 x-api-key header 帶上。
import http from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 8787);
const UPSTREAM = (process.env.UPSTREAM_URL ?? "https://api.anthropic.com").replace(/\/$/, "");
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

// 不轉送的 header：連線層級的，以及會讓上游把請求當成瀏覽器跨來源請求的。
const DROP_REQUEST = new Set(["host", "connection", "origin", "referer", "content-length", "accept-encoding"]);
const DROP_RESPONSE = new Set(["content-encoding", "content-length", "transfer-encoding", "connection"]);

async function proxy(req, res) {
  const target = UPSTREAM + req.url.slice("/anthropic".length);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!DROP_REQUEST.has(k) && v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  const ac = new AbortController();
  res.on("close", () => ac.abort());
  try {
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: hasBody ? Readable.toWeb(req) : undefined,
      duplex: hasBody ? "half" : undefined,
      signal: ac.signal,
    });
    const out = {};
    upstream.headers.forEach((v, k) => {
      if (!DROP_RESPONSE.has(k)) out[k] = v;
    });
    res.writeHead(upstream.status, out);
    if (!upstream.body) return res.end();
    // SSE 需要逐塊送出，不能先緩衝。
    res.flushHeaders();
    Readable.fromWeb(upstream.body).on("error", () => res.destroy()).pipe(res);
  } catch (err) {
    if (ac.signal.aborted) return;
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "proxy_error", message: String(err?.message ?? err) } }));
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  let file = path.join(DIST, path.normalize(decodeURIComponent(url.pathname)));
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if ((await stat(file)).isDirectory()) file = path.join(file, "index.html");
  } catch {
    file = path.join(DIST, "index.html"); // SPA fallback
  }
  try {
    await stat(file);
  } catch {
    res.writeHead(404).end("Run `npm run build` first.");
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}

http
  .createServer((req, res) => {
    if (req.url.startsWith("/anthropic/v1/")) return proxy(req, res);
    if (req.url.startsWith("/anthropic/")) {
      res.writeHead(404).end();
      return;
    }
    return serveStatic(req, res);
  })
  .listen(PORT, () => {
    console.log(`pi-claude web on http://localhost:${PORT} (API → ${UPSTREAM})`);
  });

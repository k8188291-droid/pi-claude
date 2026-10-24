// Cloudflare Worker：和 server.mjs 做同一件事。靜態檔由 Workers Static Assets 直接提供
// （wrangler.jsonc 的 run_worker_first 只讓 /anthropic/* 進到這裡），
// 這支 Worker 只負責把 /anthropic/v1/* 原樣轉送到 Anthropic API。不保存任何 API key。

interface Env {
  ASSETS: Fetcher;
  UPSTREAM_URL?: string;
}

// 不轉送的 header：連線層級的、Cloudflare 加上的、以及會讓上游當成瀏覽器跨來源請求的。
const DROP_REQUEST = /^(host|connection|origin|referer|cookie|content-length|x-forwarded-.*|x-real-ip|cf-.*)$/i;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/anthropic/v1/")) {
      if (url.pathname.startsWith("/anthropic/")) return new Response("Not found", { status: 404 });
      return env.ASSETS.fetch(request);
    }

    const target = new URL((env.UPSTREAM_URL || "https://api.anthropic.com").replace(/\/$/, ""));
    target.pathname = target.pathname.replace(/\/$/, "") + url.pathname.slice("/anthropic".length);
    target.search = url.search;

    const headers = new Headers();
    for (const [k, v] of request.headers) {
      if (!DROP_REQUEST.test(k)) headers.set(k, v);
    }

    try {
      const hasBody = request.method !== "GET" && request.method !== "HEAD";
      const upstream = await fetch(target, {
        method: request.method,
        headers,
        body: hasBody ? request.body : undefined,
        redirect: "manual",
      });
      // 直接回傳上游的 body stream，SSE 會逐塊送出。
      const out = new Headers(upstream.headers);
      out.delete("set-cookie");
      return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
    } catch (err) {
      return Response.json(
        { type: "error", error: { type: "proxy_error", message: err instanceof Error ? err.message : String(err) } },
        { status: 502 },
      );
    }
  },
} satisfies ExportedHandler<Env>;

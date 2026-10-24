# pi-claude web

類似 Claude Code on the web 的網頁介面，背後使用 [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents)。
使用者填入自己的 Anthropic API key 就能開始用；每則對話是一個 Managed Agents session，在 Anthropic 託管的獨立容器裡執行
（bash、讀寫檔案、git），可以掛載 GitHub repo。

## 功能

- **左側欄**：最上方 `+ New` 開新對話，中間是 session 清單（狀態燈號、更新時間、刪除），最下方是設定。
- **對話**：agent 文字即時串流（live previews）、工具呼叫卡片（展開看輸入與輸出）、需要核准的工具呼叫可以允許／拒絕、
  執行中可以停止、執行中也能繼續輸入（訊息會排隊）。斷線會自動重連，並用事件歷史補齊斷線期間漏掉的事件。
- **輸出檔案**：列出 agent 寫到 `/mnt/session/outputs/` 的檔案並下載。
- **花費**：顯示每個 session 以公開牌價計算的累計花費，可設定每個 session 的上限。
- **設定**
  - API Key：輸入並測試連線。
  - Agent：選擇既有 agent 或建立新的；模型、effort、system prompt、啟用哪些內建工具、工具權限（auto / always_ask / always_allow）。
    修改會建立新版本，進行中的 session 不受影響。
  - Environment：選擇或建立容器範本；網路 limited / unrestricted、套件管理器、允許的主機。
  - 新對話預設：GitHub repo、分支、token，每個 session 的花費上限。

## 執行

```bash
cd web
npm install
npm run build
npm start          # http://localhost:8787
```

開發模式（Vite，含熱更新）：

```bash
npm run dev        # http://localhost:5173
```

環境變數：

| 變數 | 預設 | 說明 |
|---|---|---|
| `PORT` | `8787` | `npm start` 的埠號 |
| `UPSTREAM_URL` | `https://api.anthropic.com` | 轉送的目標 API |

### 部署到 Cloudflare Workers

`worker/index.ts` 是 `server.mjs` 的 Worker 版本：靜態檔由 Workers Static Assets 提供，
只有 `/anthropic/*` 會進到 Worker 轉送到 Anthropic API（SSE 串流直接轉送）。設定在 `wrangler.jsonc`。

```bash
cd web
npm install
npx wrangler login     # 第一次使用，用瀏覽器登入 Cloudflare
npm run deploy         # 打包並部署，完成後會印出 https://pi-claude-web.<你的子網域>.workers.dev
```

- 想換名稱或綁自己的網域：改 `wrangler.jsonc` 的 `name`，或在 Cloudflare 後台的 Worker → Settings → Domains & Routes 加上自訂網域。
- 在 CI 部署：設定 `CLOUDFLARE_API_TOKEN`（權限選「Edit Cloudflare Workers」範本）與 `CLOUDFLARE_ACCOUNT_ID` 後執行 `npm run deploy`。
- 本機用 Workers 執行環境測試：`npm run worker:dev`（http://localhost:8787）；接假 API 時加 `-- --var UPSTREAM_URL:http://localhost:4010`。
- `wrangler.jsonc` 用 `placement.region` 把轉送的 Worker 固定在美東執行。Worker 預設在離使用者最近的機房執行，如果那裡是 Anthropic 不支援的地區，API 會回 `403 Request not allowed`。
- Worker 不需要任何 secret；API key 仍由每個使用者在自己的瀏覽器輸入。
- 部署後網址是公開的，任何人都能打開頁面，但必須輸入自己的 key 才能使用。若只想自己用，可在 Cloudflare 後台替這個 Worker 開啟 Access（Zero Trust）登入保護。

### 不花額度試用介面

`dev/mock-api.mjs` 是假的 Managed Agents API，回應是寫死的劇本（訊息含 `rm` 時會觸發工具核准流程）：

```bash
node dev/mock-api.mjs                          # http://localhost:4010
UPSTREAM_URL=http://localhost:4010 npm run dev
```

API key 隨便填即可。

## 架構與安全

- 瀏覽器直接用 `@anthropic-ai/sdk`（`client.beta.agents / environments / sessions / files`）呼叫 API，
  base URL 指向同源的 `/anthropic`；`server.mjs`（開發時是 Vite proxy）把 `/anthropic/v1/*` 原樣轉送到 `UPSTREAM_URL`。
  這樣不受 CORS 限制，SSE 串流也會逐塊轉送。
- API key 和 GitHub token 只存在使用者自己瀏覽器的 localStorage，伺服器不保存、不記錄。
  因為 key 在瀏覽器裡，請只在自己信任的網域部署，並避免在頁面中加入第三方腳本。
- 轉送端點只接受 `/anthropic/v1/*`，而且每個請求都必須帶使用者自己的 key，伺服器本身沒有任何憑證。
- GitHub token 透過 session 的 `github_repository` resource 傳給 Anthropic，由 Anthropic 的 git proxy 在容器外注入，
  容器內的程式讀不到。
- 刪除 session 會永久刪除對話紀錄和容器。

## 檔案

| 路徑 | 內容 |
|---|---|
| `src/useSession.ts` | 連線一個 session：先開 SSE 串流再抓歷史、以 event id 去重、live preview 累積、自動重連、送訊息／中斷／核准 |
| `src/components/Timeline.tsx` | 事件時間軸：訊息、工具卡片與核准、錯誤與狀態提示 |
| `src/components/SettingsDialog.tsx` | 設定視窗（API key、agent、environment、新對話預設） |
| `src/components/NewSession.tsx` | 新對話：建立 session（`initial_events` 帶第一則訊息） |
| `src/settings.ts` | localStorage 設定 |
| `server.mjs` | 正式環境（Node）：靜態檔 + API 轉送 |
| `worker/index.ts`、`wrangler.jsonc` | 正式環境（Cloudflare Workers）：API 轉送，靜態檔由 Static Assets 提供 |
| `dev/mock-api.mjs` | 開發用假 API |

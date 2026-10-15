# pi-claude-code-tools

讓 [pi coding agent](https://github.com/earendil-works/pi)（`@earendil-works/pi-coding-agent` ≥ 1.2）透過 SDK 使用時，
具備和 Claude Code 相同名稱、參數與行為的工具。只處理 SDK 情境，不含 TUI 呈現。

## 工具

| 工具 | 說明 |
|---|---|
| `Read` | `cat -n` 格式、預設 2000 行、圖片（自動縮放）、PDF（`pages`，需 poppler）、`.ipynb` |
| `Write` | 覆寫既有檔案前必須先 Read；讀後被外部改動會要求重讀 |
| `Edit` | `old_string/new_string/replace_all`，另支援 `edits[]` 一次多處（全有或全無）；保留 CRLF / BOM；彎引號容錯 |
| `Grep` | ripgrep；`output_mode`（content / files_with_matches / count）、`-A/-B/-C/-n/-i/-o`、`type`、`glob`、`multiline`、`head_limit/offset` |
| `Glob` | 依修改時間新到舊排序，最多 100 筆 |
| `Bash` | timeout 毫秒（預設 2 分、上限 10 分）、`description`、`cd` 後的工作目錄跨呼叫保留、`run_in_background` |
| `BashOutput` / `KillShell` | 讀背景 shell 的新輸出（可 regex 過濾）／停止；背景結束時自動通知模型 |
| `TodoWrite` | 待辦存在 session（跟著 fork / tree 分支走），長時間未更新會提醒模型 |
| `AskUserQuestion` | 透過 host callback `onAskUserQuestion` 取得答案 |
| `Task` | 同程序 subagent：`general-purpose`、`Explore`、`Plan`＋`.claude/agents/*.md`＋自訂；平行、背景、`resume` |
| `tool_search` | 使用 pi 內建的 tool search：`deferredTools` 列出的工具以 pi 原生 `exposure: "deferred"` 註冊，模型用 `tool_search` 找到後才載入（同一輪內即生效） |

另外有**大輸出寫檔**：任何工具（含其他 extension、SDK customTools、Task）文字輸出超過 30000 字元時，
完整內容寫到暫存檔，模型拿到預覽＋路徑，可再用 Read / Grep 查看（Read 本身除外）。

## 使用方式

最簡單：用 `createClaudeCodeSession()`，它會關掉 pi 內建工具（read/bash/edit/write）、裝上本套件，
並加入 pi 的 `createToolSearchExtension()`（有延遲載入工具時自動啟用 `tool_search`）。

```ts
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createClaudeCodeSession } from "pi-claude-code-tools";

const modelRuntime = await ModelRuntime.create();             // 讀 ANTHROPIC_API_KEY 等憑證
const model = modelRuntime.getModel("anthropic", "claude-sonnet-5-5");

const { session } = await createClaudeCodeSession({
  cwd: process.cwd(),
  model,
  modelRuntime,
  claudeCode: {
    onAskUserQuestion: async (questions) => ({ [questions[0].question]: "選項 A" }),
    onEvent: (e) => { /* todos_updated, background_shell_*, subagent_*, output_spilled, tools_activated */ },
    agents: { reviewer: { description: "...", prompt: "...", tools: ["Read", "Grep"] } },
    deferredTools: ["Glob", "Grep"],   // 先藏起來，模型用 tool_search 找到才載入
  },
});
await session.prompt("...");
```

完整範例見 [`examples/sdk-basic.ts`](examples/sdk-basic.ts)。

### 自己組 session

```ts
import { createAgentSession, createToolSearchExtension, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { createClaudeCodeExtension } from "pi-claude-code-tools";

const loader = new DefaultResourceLoader({
  cwd, agentDir,
  extensionFactories: [
    createClaudeCodeExtension({ ...opts, modelRuntime }),  // modelRuntime 給 subagent 共用
    createToolSearchExtension(),                           // 用 deferredTools 時需要
  ],
});
await loader.reload();
const { session } = await createAgentSession({ cwd, modelRuntime, resourceLoader: loader, noTools: "builtin" });
```

## 選項（`ClaudeCodeToolsOptions`）

| 選項 | 預設 | 說明 |
|---|---|---|
| `onAskUserQuestion` | — | AskUserQuestion 的 host callback；未提供時（且無 UI）工具回錯誤讓模型自行判斷 |
| `onEvent` | — | host 事件通知 |
| `outputSpill` | `{ maxChars: 30000, previewChars: 2000 }` | `false` 關閉；可設 `dir`、`exclude` |
| `agents` | — | 自訂 subagent，覆蓋同名內建／磁碟定義 |
| `loadAgentsFromDisk` | `true` | 讀 `~/.claude/agents`、`<cwd>/.claude/agents` |
| `subagents` | `true` | 是否提供 `Task` |
| `subagentExtensions` | — | 額外裝進每個 subagent session 的 extension（例如你的自訂工具或 MCP） |
| `deferredTools` | `[]` | 以 pi 原生 `exposure: "deferred"` 註冊的本套件工具；有任何延遲載入工具（含你自己或 MCP 的）時會自動啟用 `tool_search` |
| `modelRuntime` | 由 `createClaudeCodeSession` 帶入 | subagent 使用的 ModelRuntime（憑證與模型目錄） |
| `bash` | `{ defaultTimeoutMs: 120000, maxTimeoutMs: 600000 }` | Bash timeout |

## Hooks

不另做設定檔；直接寫 pi extension 掛事件即可（`tool_call` 可擋／改參數、`tool_result` 可改結果、
`before_agent_start`、`agent_end`、`session_start`…），和本套件一起放進 `extensionFactories`。

## 與 Claude Code 的差異

- 不含權限系統。
- Bash 不載入使用者 shell profile（alias / function 不可用）；同一則回覆中平行的 Bash 共用工作目錄。
- Glob 不讀 `.gitignore`（但預設跳過 `node_modules`、`.git` 等）。
- PDF 需要系統安裝 poppler（`pdftotext`、`pdfinfo`，掃描頁轉圖需 `pdftoppm`）。
- 待辦提醒是暫時注入（只出現在該次 LLM 呼叫），不寫入 session。
- Subagent 使用記憶體內預設設定與 `getAgentDir()`（拿不到父 session 的 settingsManager）；憑證與模型目錄共用父 session 的 ModelRuntime。
- 工具搜尋用 pi 內建的 `tool_search`（參數 `query`、`limit`），不是 Claude Code 的 `ToolSearch`（`select:` 語法）。

## 開發

```bash
npm test          # vitest，使用 pi 的 faux provider 跑完整 agent 流程
npm run typecheck
npm run build
```

# pi-claude-code-tools

讓 [pi coding agent](https://github.com/badlogic/pi-mono)（`@mariozechner/pi-coding-agent` ≥ 0.73）透過 SDK 使用時，
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
| `ToolSearch` | `deferredTools` 列出的工具先只給名字，模型搜尋後才載入 schema（同一輪內即生效） |

另外有**大輸出寫檔**：任何工具（含其他 extension、SDK customTools、Task）文字輸出超過 30000 字元時，
完整內容寫到暫存檔，模型拿到預覽＋路徑，可再用 Read / Grep 查看（Read 本身除外）。

## 使用方式

最簡單：用 `createClaudeCodeSession()`，它會關掉 pi 內建工具（read/bash/edit/write）並裝上本套件。

```ts
import { createClaudeCodeSession } from "pi-claude-code-tools";

const { session } = await createClaudeCodeSession({
  cwd: process.cwd(),
  model,                       // pi Model
  claudeCode: {
    onAskUserQuestion: async (questions) => ({ [questions[0].question]: "選項 A" }),
    onEvent: (e) => { /* todos_updated, background_shell_*, subagent_*, output_spilled, tools_activated */ },
    agents: { reviewer: { description: "...", prompt: "...", tools: ["Read", "Grep"] } },
    deferredTools: ["SomeRarelyUsedTool"],
  },
});
await session.prompt("...");
```

完整範例見 [`examples/sdk-basic.ts`](examples/sdk-basic.ts)。

### 自己組 session

```ts
import { createAgentSession, DefaultResourceLoader } from "@mariozechner/pi-coding-agent";
import { createClaudeCodeExtension, wrapStreamFnForToolSearch } from "pi-claude-code-tools";

const loader = new DefaultResourceLoader({ cwd, agentDir, extensionFactories: [createClaudeCodeExtension(opts)] });
await loader.reload();
const { session } = await createAgentSession({ cwd, resourceLoader: loader, noTools: "builtin" });
// 有用 deferredTools 時建議加上，讓 ToolSearch 載入的工具在同一輪就生效（否則下一次 prompt 才生效）
session.agent.streamFn = wrapStreamFnForToolSearch(session.agent.streamFn);
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
| `deferredTools` | `[]` | 延遲載入的工具名稱；空的時候不註冊 ToolSearch |
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
- Subagent 使用記憶體內預設設定與 `getAgentDir()`（拿不到父 session 的 settingsManager）。
- 透過 `runtime.newSession()` 等替換出的新 session 不會自動套用 ToolSearch 的 streamFn 包裝，會退回「下一次 prompt 生效」。

## 開發

```bash
npm test          # vitest，使用 pi 的 faux provider 跑完整 agent 流程
npm run typecheck
npm run build
```

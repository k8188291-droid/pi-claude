# pi 補齊 Claude Code 工具：確定範圍

> **註：** 這是專案初期的範圍規劃。之後已改為比照目前的 Claude Code（例如 TodoWrite 改為 TaskCreate／TaskUpdate 等、Task 改名 Agent、BashOutput／KillShell 改為背景輸出檔＋TaskStop、Edit 不再支援 `edits[]`）。目前的工具與行為以 [README](README.md) 為準。

對象：`@mariozechner/pi-coding-agent` v0.73.1，以 SDK 方式使用；不處理 CLI / TUI 呈現。

## 已決定的原則

- **Hooks**：不做設定檔模式。直接用 pi extension 事件（`tool_call`、`tool_result`、`before_agent_start`、`agent_end`…）。
- **權限**：不做。
- **要問使用者的功能**（AskUserQuestion）：SDK 模式下 `ctx.hasUI = false`，改成由 host 提供 callback。

## 要做的工具

### 檔案

| # | 項目 | 內容 |
|---|---|---|
| F1 | **Edit / Write 對齊** | Edit 使用 `file_path/old_string/new_string/replace_all`，保留一次改多處（`edits[]`）；`old_string` 不唯一而且沒有開 `replace_all` 時要報錯。Write 和 Edit 改既有檔案前必須先 Read 過；讀過之後如果檔案被外部改動（mtime 或內容雜湊不同），要求重新讀取 |
| F2 | **Read 增強** | PDF（`pages` 參數，抽文字；可以的話把頁面轉成圖片）、`.ipynb`（cell 原始碼和輸出）；保留圖片支援；輸出加行號（`cat -n` 格式）；記錄讀取狀態給 F1 用 |
| F3 | **Grep / Glob 對齊** | Grep：`output_mode`（content / files_with_matches / count）、`-A/-B/-C/-n/-i`、`type`、`glob`、`multiline`、`head_limit`、`offset`，底層用 ripgrep。Glob：`pattern/path`，結果依 mtime 新到舊排序 |

### 執行與輸出

| # | 項目 | 內容 |
|---|---|---|
| E1 | **大輸出寫檔（所有工具）** | 用 `tool_result` 統一攔截：任何工具（內建、自訂、子 agent）的文字輸出超過上限，就把完整內容寫進 session 專屬的目錄，回傳「預覽＋檔案路徑＋總大小」，模型之後可以用 Read 分段讀。上限可以設定 |
| E2 | **Bash 背景執行** | `run_in_background: true` 時立刻回傳 shell id；新增 `BashOutput(bash_id, filter?)` 讀增量輸出、`KillShell(shell_id)` 停止；背景工作結束時，在下一輪注入通知（system reminder），session 結束時清掉所有背景程序 |
| E3 | **Bash 行為對齊** | `timeout` 單位改成毫秒，預設 120000、上限 600000；加 `description` 參數；`cd` 之後的工作目錄在多次呼叫間保留（記錄每次執行結束時的 `pwd`） |

### 外部整合

| # | 項目 | 內容 |
|---|---|---|
| X1 | **ToolSearch** | 可以設定一批「延遲載入」的工具，一開始只在 system prompt 列出名字；模型用 `select:a,b` 或關鍵字搜尋後，才用 `pi.setActiveTools` 啟用並回傳 schema |

### Agent 流程

| # | 項目 | 內容 |
|---|---|---|
| A1 | **Task / Agent（subagent）** | 在同一個程序裡用 `createAgentSession` 建子 session（in-memory），上下文隔離，只把最終回覆傳回主 agent；agent 定義可以從 `.claude/agents/*.md` 讀或由 SDK 傳入；內建 `general-purpose`、`Explore`（唯讀）、`Plan`（唯讀）；可以平行執行；`run_in_background` 背景執行，完成時通知主 agent；子 agent 不能再開子 agent；事件帶 `parentToolCallId` 轉給 host；回報 usage |
| A2 | **TodoWrite** | `todos[{content, activeForm, status}]` 整份取代；狀態存在 session（`appendEntry`），fork 和 resume 後會還原；變更時透過 event bus 通知 host；一段時間沒更新就用 reminder 提醒模型 |
| A3 | **AskUserQuestion** | `questions[1..4]`，每題 `question/header/options[2..4]{label,description}/multiSelect`；交給 host 的 `onAskUserQuestion` callback；host 沒提供 callback 時回傳錯誤，讓模型自己判斷 |

## 預計的程式結構

```
pi-cc-extensions/
  src/
    shared/        # file-state 追蹤、system reminder 佇列、host callback 型別
    tools/
      read.ts  write.ts  edit.ts  grep.ts  glob.ts
      bash.ts  background-shells.ts   # Bash + BashOutput + KillShell
      todo.ts  ask-user-question.ts  tool-search.ts
    output-spill.ts                   # E1 大輸出寫檔
    subagent/                         # A1
    index.ts                          # createClaudeCodeExtensions(options) → ExtensionFactory[]
  examples/sdk-basic.ts
  test/                               # 每個工具的單元測試＋用 mock 模型跑的 e2e
```

SDK 使用方式（草案）：

```ts
const loader = new DefaultResourceLoader({
  extensionFactories: createClaudeCodeExtensions({
    onAskUserQuestion: async (questions) => answers,
    outputSpill: { maxChars: 30000 },
    agents: { reviewer: { description, prompt, tools } },
    deferredTools: ["NotebookEdit"],
  }),
});
await loader.reload();
const { session } = await createAgentSession({ resourceLoader: loader, tools: [] }); // 內建工具用我們的版本取代
```

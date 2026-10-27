# pi-claude-code-tools

讓 [pi coding agent](https://github.com/earendil-works/pi)（`@earendil-works/pi-coding-agent` ≥ 1.2）透過 SDK 使用時，
具備和 Claude Code 相同名稱、參數與行為的工具。只處理 SDK 情境，不含 TUI 呈現。

## 工具

對照目標是目前的 Claude Code（`@anthropic-ai/claude-agent-sdk` 0.3.302 附帶的 2.1.302）。工具的描述、參數與結果文字都比照它，並用 `parity/` 的重播測試逐步驗證。

| 工具 | 說明 |
|---|---|
| `Read` | `N\t內容` 格式；沒給 `limit` 時超過 256KB 拒讀（`allow_large` 可放寬），超過 25,000 tokens 時分頁並標示；重讀沒改過的檔案回「Wasted call」；圖片、PDF（`pages`，需 poppler）、`.ipynb` |
| `Write` | 不需先 Read；但讀過之後被外部改動，就拒絕覆寫。保留原檔編碼（CRLF、BOM、UTF-16） |
| `Edit` | `old_string/new_string/replace_all`；不需先 Read，檔案在讀取後被外部改動時，只有能乾淨套用才成功；彎引號與 `\uXXXX` 容錯；`.ipynb` 請用 NotebookEdit |
| `NotebookEdit` | 以 cell id 或 `cell-N` 取代／插入／刪除 notebook cell |
| `Grep` | ripgrep；`output_mode`（content / files_with_matches / count）、`-A/-B/-C/context/-n/-i/-o`、`type`、`glob`、`multiline`、`head_limit/offset` |
| `Glob` | 相對路徑、依修改時間舊到新；包含 `node_modules`、隱藏檔與 gitignore 的檔案；最多 100 筆 |
| `Bash` | timeout 毫秒（預設 2 分、上限 10 分），逾時改轉背景執行；`cd` 後工作目錄保留並提醒模型；`run_in_background` 的輸出寫到檔案，用 Read 讀取，結束時通知模型 |
| `TaskStop` | 停止背景 Bash 指令或背景 agent |
| `TaskCreate` / `TaskGet` / `TaskList` / `TaskUpdate` | 工作清單（相依、owner、metadata）；存在 session，跟著分支走；和前景 subagent 共用；長時間未使用會提醒模型 |
| `AskUserQuestion` | 透過 host callback `onAskUserQuestion` 取得答案（可含 annotations） |
| `Agent` | 同程序 subagent：`general-purpose`、`Explore`、`Plan`＋`.claude/agents/*.md`＋自訂。預設背景執行、完成時以通知回報；`run_in_background: false` 時同步回傳；支援 `fork`、`isolation: "worktree"`、`effort` |
| `tool_search` | pi 內建的工具搜尋：`deferredTools` 列出的工具以 pi 原生 `exposure: "deferred"` 註冊，模型用 `tool_search` 找到後才載入 |

**大輸出寫檔：** 任何工具（含其他 extension、SDK customTools、Agent）的文字輸出超過門檻時，完整內容寫到暫存檔，模型拿到 2KB 預覽和路徑。門檻比照 Claude Code：Grep 20,000、Bash 30,000、其他 50,000 字元；Read 不寫檔。

**背景工作通知：** 背景 Bash 或 agent 結束時，`<task-notification>` 會附在下一個工具結果後面；agent 閒置時則直接開始新的一輪。

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
    onEvent: (e) => { /* tasks_updated, todos_updated, background_shell_*, subagent_*, output_spilled */ },
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

## 記憶體 host（`pi-claude-code-tools/memory`）

讓工具完全不碰宿主的檔案與程序（例如在 Lambda 裡）：檔案放在 just-bash 的 `InMemoryFs`，Bash 由 just-bash 直譯器執行（不啟動子程序），Grep 用 just-bash 內建的 `rg`，Glob 直接比對記憶體內的路徑。需要安裝選用的 peer dependency `just-bash`（≥ 3.4.2）與 `minimatch`；根目錄的 `pi-claude-code-tools` 不會載入它們。

```ts
import { createMemoryClaudeCodeSession } from "pi-claude-code-tools/memory";

const { session, host, snapshot } = await createMemoryClaudeCodeSession({
  model, modelRuntime,                       // 由呼叫端提供（Bedrock、OpenAI 相容 endpoint 等皆可）
  snapshot: saved,                           // 選用：還原檔案、cwd 與完整 session tree
  hostOptions: {
    executionLimitProfile: "hardened",
    fetch: myVirtualApiFetch,                // 選用：讓 curl 呼叫 host 提供的虛擬 HTTP API
  },
});
await session.prompt("...");
const text = new TextDecoder().decode(await host.fs.readFile("/workspace/out.md"));
store(JSON.stringify(await snapshot()));     // 讀寫 snapshot 物件由呼叫端負責
```

- **環境：** cwd 預設 `/workspace`、`/tmp`、`/home/agent`；network、Python、JavaScript 預設關閉；`supportsWorktrees: false`。也可以只用 `createMemoryHost()`，再把它當 `claudeCode.host` 傳給 `createClaudeCodeExtension`。
- **資源：** `MemoryResourceLoader` 只讀 VFS：AGENTS.md／CLAUDE.md（`/agent`，再從 `/` 到 cwd 每一層）、skills（`/agent/skills`、`<cwd>/.pi/skills`、`<cwd>/.agents/skills`）、prompt templates（`/agent/prompts`、`<cwd>/.pi/prompts`）。Extension 只有程式內傳入的 factory，永遠不從檔案載入；settings 與 session 都在記憶體中。
- **Snapshot：** 和 memory-pi-agent 相同的 version 1 格式（檔案含 base64 與 mode、目錄、symlink、cwd、session tree），另外保存 mtime。`/bin`、`/usr`、`/proc`、`/dev` 每次重建，不存。OAuth 等憑證不放進 snapshot（舊格式的 `oauth` 欄位會被忽略）。
- **ModelRuntime：** 沒給時用 `createMemoryModelRuntime()`（記憶體憑證、只有內建模型目錄、不連網）。

已知限制：

- Bash 的 stdout／stderr 在指令結束時一次送出（just-bash 沒有串流 API）。`kill()`／timeout 在直譯器下一次 await 時生效；完全不 await 的迴圈（`while :; do :; done`）要靠 `executionLimits` 結束。
- 每次指令都是獨立的 just-bash 狀態（同一個 `Bash` 可同時跑多個指令，`cd`／`export` 互不影響，只共用檔案系統）。
- Grep：just-bash 的 `rg` 一律跳過 `node_modules`、`.git`、`.svn`、`.hg`、`__pycache__`、`.pytest_cache`、`.mypy_cache`、`venv`、`.venv`、`.next`、`.nuxt`、`.cargo`；`.gitignore` 在非 git repo 也生效；二進位檔直接略過（沒有「binary file matches」）；regex 是 just-bash 轉成 JavaScript 的語法（不支援 `(?i)` 等 inline flag）。其餘差異已在 `src/memory/ripgrep.ts` 補齊（預設大小寫、`--max-columns`、`{a,b}` glob、排除目錄、未知 `--type`、JSON 的 context 與 multiline、錯誤訊息）。
- 檔案系統沒有權限檢查（mode 只記錄不強制）、沒有 FIFO 等特殊檔案；`readRange` 只回傳範圍內的位元組，但由 just-bash 寫入、以字串保存的檔案，每次讀取會先整份編碼。
- `createMemoryClaudeCodeSession` 預設關閉 `Agent`（`subagents: false`）：subagent session 目前由 pi 的 `DefaultResourceLoader` 建立，會讀宿主磁碟。
- pi 1.x 只在有名為 `read` 或 `bash` 的工具時才把 skills 列進 system prompt，Claude Code 工具（`Read`、`Bash`）不符合，所以 skills 會載入但不會出現在 prompt 中（磁碟版 `createClaudeCodeSession` 也一樣）。
- pi-ai 預設的憑證探測仍會讀 `process.env`，並檢查宿主上 Google ADC 檔案是否存在；pi 1.x 的 `ModelRuntime` 無法替換這個 auth context。

## 選項（`ClaudeCodeToolsOptions`）

| 選項 | 預設 | 說明 |
|---|---|---|
| `host` | `createLocalHost()`（本機） | 工具使用的檔案系統、shell 與搜尋（`ClaudeCodeHost`，見 `src/host/types.ts`）；所有工具、背景輸出與 spill 檔都經由它，subagent 共用同一個 host。host 的 `supportsWorktrees` 為 `false` 時，`isolation: "worktree"` 回報不支援 |
| `onAskUserQuestion` | — | AskUserQuestion 的 host callback；未提供時（且無 UI）工具回錯誤讓模型自行判斷 |
| `onEvent` | — | host 事件通知 |
| `outputSpill` | 依工具（見上） | `false` 關閉；`maxChars` 會覆蓋所有工具的門檻；可設 `dir`、`exclude` |
| `agents` | — | 自訂 subagent，覆蓋同名內建／磁碟定義 |
| `loadAgentsFromDisk` | `true` | 讀 `~/.claude/agents`、`<cwd>/.claude/agents` |
| `subagents` | `true` | 是否提供 `Agent` |
| `subagentResourceLoader` | `DefaultResourceLoader` | 進階：自行建立 subagent session 的 resource loader（`(options) => ResourceLoader`，`options` 即 `DefaultResourceLoader` 會收到的參數，須照用其中的 extension 與 system prompt）。`DefaultResourceLoader` 會讀實體磁碟上的設定、`~/.pi/agent` 與 context 檔，非本機 host 時改用此選項 |
| `subagentExtensions` | — | 額外裝進每個 subagent session 的 extension（例如你的自訂工具或 MCP） |
| `deferredTools` | `[]` | 以 pi 原生 `exposure: "deferred"` 註冊的本套件工具；有任何延遲載入工具（含你自己或 MCP 的）時會自動啟用 `tool_search` |
| `modelRuntime` | 由 `createClaudeCodeSession` 帶入 | subagent 使用的 ModelRuntime（憑證與模型目錄） |
| `bash` | `{ defaultTimeoutMs: 120000, maxTimeoutMs: 600000 }` | Bash 前景 timeout（背景工作的時間上限另計：預設 30 分、最多 2 小時） |
| `compat` | `"claude-code"` | Claude Code 本身有 bug 的行為：`"claude-code"` 照樣重現（逐位元相容），`"fixed"` 全部改用修正後的行為 |
| `quirks` | — | 逐項覆寫 `compat`，例如 `{ bashErrexit: "fixed" }`；項目見下表 |

### Claude Code 相容選項（`compat` / `quirks`）

下列行為是 Claude Code 本身的問題（見 [review](docs/review-2026-10-18.md) C 類）。預設照樣重現，以維持和 Claude Code 相同；設成 `"fixed"` 改用修正後的行為。

| 項目 | Claude Code 的行為（預設） | `"fixed"` 時 |
|---|---|---|
| `bashErrexit` | `set -e` 失效，前一步失敗仍繼續 | `set -e` 正常生效 |
| `orphanProcesses` | 指令用 `&` 啟動的子程序在 shell 結束後仍存活 | shell 結束時一併終止整個 process group |
| `agentDisallowAll` | agent 的 `disallowedTools: "*"` 被忽略 | 移除全部工具 |
| `remoteIsolationFallback` | `isolation: "remote"` 靜默改成本機執行 | 明確回報不支援 |
| `mtimeOnlyChangeDetection` | 只看 mtime 判斷檔案是否被改過 | 比對內容雜湊 |
| `notebookStaleBeforeSize` | NotebookEdit 先讀完整檔案才檢查大小 | 先檢查大小 |
| `specialFileReads` | FIFO 等特殊檔案會讓 Read 卡住，也無法取消 | 先拒絕特殊檔案，讀取可取消 |
| `pathTrim` | 路徑被 `trim()`，`"name "` 會寫到 `"name"` | 路徑照原樣使用，空路徑回錯誤 |
| `searchPermissionErrors` | Grep／Glob 讀不到的檔案被當成「沒有符合」 | 回報讀不到的路徑 |
| `readTokenCountLineNumbers` | Read 的 token 上限沒計入行號 | 計入行號 |
| `replaceAllTrailingMatch` | `replace_all` 刪除時漏掉不帶換行的最後一個符合 | 全部刪除 |
| `notebookCellTypeConversion` | 轉換 cell 型別後的欄位比照 Claude Code | 比照 nbformat 4 |

## Hooks

不另做設定檔；直接寫 pi extension 掛事件即可（`tool_call` 可擋／改參數、`tool_result` 可改結果、
`before_agent_start`、`agent_end`、`session_start`…），和本套件一起放進 `extensionFactories`。

## 與 Claude Code 的差異

- 不含權限系統，也沒有 SendMessage、Cron、Workflow、Monitor 等 Claude Code 的其他工具。
- 工具搜尋用 pi 內建的 `tool_search`（參數 `query`、`limit`），不是 Claude Code 的 `ToolSearch`。
- Grep 的 content／count 模式依路徑排序；Claude Code 直接沿用多執行緒 ripgrep 的輸出順序，每次可能不同。
- Read 圖片時，pi 的 Anthropic provider 會在純圖片的工具結果前加一段「(see attached image)」文字。
- 整份 PDF 以頁面圖片（或 pdftotext 文字）提供給模型，不是 Claude Code 的 PDF document block；需要系統安裝 poppler。
- Read 的 token 數用估算（字元數 ÷ 4），Claude Code 會向 API 精算。
- pi 送出工具 schema 時會拿掉 `additionalProperties: false`。
- Bash 不載入使用者 shell profile（alias / function 不可用）。
- 背景輸出、大輸出寫檔都放在 host 的私有目錄（`tmpDir`；本機為 `<tmpdir>/pi-cc-<uid>/`，目錄 0700、檔案 0600）。
- Subagent 使用記憶體內預設設定與 `getAgentDir()`；憑證與模型目錄共用父 session 的 ModelRuntime。不支援接續已完成的 agent（Claude Code 改用 SendMessage）。
- 工作清單的提醒是暫時注入（只出現在該次 LLM 呼叫），不寫入 session。

## 與 Claude Code 的差異測試（parity）

`parity/` 用同一組可重播的情境，分別跑 Claude Code（透過 `@anthropic-ai/claude-agent-sdk`）和 pi-claude，再比對兩邊的工具結果。

- **原理：** 兩邊都連到本機的模擬 Anthropic API（`parity/mock-server.ts`），由它依劇本回傳模型的工具呼叫，所以兩邊收到完全相同的模型輸出，差異只來自工具實作。不需要 API key，也不花費用。
- **比對內容：** 每一步的工具結果（正規化路徑、時間、隨機 id 後逐字比對）、錯誤狀態、執行後的工作目錄檔案、宣告給模型的工具清單與參數、子 agent 的工具清單，以及劇本以外多出的模型回合（例如背景工作的喚醒）。
- **輸出：** `parity/out/report.md`（Markdown 報告）和 `parity/out/results.json`。

```bash
npm run parity                              # 跑全部情境
npx tsx parity/run.ts --only grep-modes,glob # 只跑部分情境
npx tsx parity/debug.ts edit-guards claude  # 印出單一情境、單一 harness 的請求紀錄
```

新增情境：在 `parity/scenarios/` 加一個 `Scenario`。路徑寫成 `{{cwd}}`；兩邊工具名稱或參數不同時，用 `claude` / `pi` 覆寫；參數可以寫成函式，從前面的工具結果取值（例如背景工作 id）。子 agent 的劇本放在 `subagents`，並在 Agent 的 prompt 裡寫 `[[sub:名稱]]`。

```bash
npx tsx parity/debug.ts <情境> claude --full  # 印出完整（未截斷）的工具結果
```

### 錄製真實 session 再重播

手寫劇本只涵蓋想得到的情況。錄製模式讓真的模型透過 Claude Code 執行任務，把模型實際送出的工具呼叫錄下來，之後再拿去兩邊重播比對：

```bash
ANTHROPIC_API_KEY=... npx tsx parity/record.ts --name review-pi-claude \
  --prompt "請 review 這個 repo 目前的程式碼……" [--model claude-sonnet-5-5] [--ref HEAD]
npx tsx parity/run.ts --only review-pi-claude   # 重播：Claude Code 與 pi-claude 各跑一次並比對
```

- 錄製時，模擬伺服器改為代理：把請求轉發到真的 Anthropic API，同時記下每個模型回合（主 agent 與各 subagent），存成 `parity/recordings/<name>.json`；最後一則回覆另存成 `<name>.final.md`。
- 工作目錄是指定 commit 的 `git archive`，以固定時間戳記建成 git repo，並連結 `node_modules`，錄製和重播時內容完全相同。
- 重播時，背景工作 id、暫存檔路徑這類每次不同的值，會依前面的工具結果自動換成當次執行的值。
- `parity/recordings/` 裡的錄製檔會自動載入成情境。

## 開發

```bash
npm test          # vitest，使用 pi 的 faux provider 跑完整 agent 流程
npm run typecheck
npm run build
```

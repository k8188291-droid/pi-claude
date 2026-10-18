# Code review 驗證報告（review-run1.final.md）

對象：`/home/user/pi-cc-extensions`（pi-claude），以 node_modules 內 Claude Code 2.1.302 為基準。
方法：用 parity harness（mock Anthropic API）讓 Claude Code 與 pi-claude 跑同一串 tool calls，比較結果與磁碟狀態。工具無法探測的項目（pi 內部生命週期、parity harness 本身）則直接呼叫 pi 模組或 harness 函式，必要時對 Claude Code binary 執行 `grep -a`。
探測腳本：`/tmp/claude-0/-home-user-report-ppt/d2380889-b09b-5652-92e1-7ce2cb120d6f/scratchpad/verify/`（`h.mts` 是共用 probe；`runners2.mts` 是可傳入 agents、磁碟 agents 與 MCP 工具的 runner 變體；#16 需以非 root 身分執行，腳本放在 `/tmp/verify-nobody/`）。

> 注意：驗證期間（約 09:24 起），repo 有 5 個檔案被**另一個程序**修改：`parity/compare.ts`、`parity/runners/pi.ts`、`src/subagent/agents.ts`，以及兩個測試檔。改動包括新增內建 `claude` agent、pi runner 等待背景 agent、stripNoise 正規式。這些不是本次驗證造成的，我也沒有改動 repo。逐項檢查後，這些改動不影響以下任何判定：它們沒有碰到工具過濾、worktree、檔案狀態或搜尋邏輯。

## 判定總表

| # | 標題 | 判定 | 證據摘要 | 位置 |
|---|---|---|---|---|
| 1 | `set -e` 失效 | **與 CC 相同** | 兩邊都輸出 `continued`、建立 `marker`、exit 0 | `src/tools/bash-process.ts:109–112` |
| 2a | deferred 工具繞過 agent `tools` 限制 | **pi-only** | `tools: Read` 的 child 在 pi 經 `tool_search` 啟用並執行 `mcp__prod__danger`；CC child 只有 `[Read]`，呼叫回 `No such tool available` | `src/subagent/index.ts:329–335,404–405` |
| 2b | `tools: []` 變成全部允許 | **pi-only** | CC child 收到 0 個工具（options 與磁碟 frontmatter 皆然）；pi 收到 10 個並成功執行 MCP 工具 | `src/subagent/agents.ts:177–184,243–248` |
| 2c | `disallowedTools: "*"` 被丟棄 | **與 CC 相同** | CC 與 pi 的工具清單相同（全部 10 個），兩邊都執行了 danger | `agents.ts:183` |
| 2d | `mcp__prod__*`／`mcp__prod` 規則失效 | **pi-only** | CC child 的工具清單中沒有 MCP 工具，呼叫被拒；pi 仍保留並執行 | `agents.ts:281–283` |
| 3 | remote isolation 靜默降級 | **與 CC 相同** | 非 git 目錄：兩邊都在前景、相同 cwd 執行；git 目錄：兩邊都降級成 worktree | `src/subagent/index.ts:558–563` |
| 4a | `status.showUntrackedFiles=no` 下刪除成果 | **pi-only** | CC 保留 worktree 並回報 `worktreePath`；pi 刪除 worktree 與分支 | `src/subagent/worktree.ts:59–75` |
| 4b | detached HEAD 後 `branch -D` 刪掉成果分支 | **pi-only** | CC 移除 worktree，但保留分支（可達 commit 數 2）；pi 刪除分支，commit 變成 dangling | `worktree.ts:62–72` |
| 5 | mtime 判斷漏掉外部修改 | **與 CC 相同** | 外部改寫並還原 mtime 後，兩邊都回 `Wasted call`，Write 和 NotebookEdit 也都成功覆寫 | `src/shared/file-state.ts:69–70,137–148` |
| 6a | Read `limit:1` 仍讀完整個大檔 | **pi-only** | 1GB 檔：pi 程序 RSS 從 287MB 升到 1283MB、耗時 6.5s；CC 整個 CLI 峰值 382MB | `src/tools/read.ts:529–530` |
| 6b | NotebookEdit 先做 stale 檢查再檢查大小 | **與 CC 相同** | 101MiB notebook：兩邊都回 `File has been modified since read…`，順序相同 | `src/tools/notebook-edit.ts:146–152` |
| 7a | FIFO 命名成 `.png` 讓 Read 卡住 | **與 CC 相同** | 兩邊都阻塞到 writer 出現（CC 8369ms，pi 8343ms），之後回相同錯誤 | `read.ts:661–667,1146–1148` |
| 7b | Edit 對 FIFO 卡住 | **pi-only（比描述更嚴重）** | CC：讀取阻塞到 writer 出現後，回 `Not a regular file (device, FIFO, or socket)`；pi：讀完後**把 `bye` 寫進 FIFO**，阻塞到有 reader 才結束，並回報 `updated successfully` | `src/tools/edit.ts:329–340,393`；`write.ts:107–111` |
| 7c | abort 無法解除阻塞 | 無法用工具探測；看程式碼屬實 | readFile／readImage 沒有傳入 signal。CC 對 .png FIFO 也同樣阻塞。即使傳入 signal，也無法取消卡在 threadpool 的 `open()` | — |
| 8 | 路徑 `trim()` 改寫另一個檔案 | **與 CC 相同** | 兩邊都把 `NEW` 寫入 `space`，`space ` 未變 | `src/shared/paths.ts:5–9` |
| 9 | Bash 輸出開頭被丟棄，卻宣稱已完整保存 | **pi-only** | 12MiB 輸出：CC 的 spill 檔 12582923 bytes，開頭有 `BEGIN`；pi 只有 10461188 bytes，沒有 `BEGIN` | `bash-process.ts:19–26`；`bash.ts:430–431,600` |
| 10 | 暫存輸出可被其他帳號讀取 | **背景輸出：pi-only；spill：部分 pi-only** | CC 自行建立 `$TMPDIR/claude-<uid>`，權限 0700；pi 使用 `/tmp/pi-cc-tasks/...`，各層都是 0755、檔案 0644。spill 檔兩邊都是 0644，但 pi 的預設位置在共用的 `/tmp/pi-cc-tool-results` | `src/shared/background.ts:55–60`；`src/output-spill.ts:83–91,112–116` |
| 11 | shell 結束後，子程序逃過清理 | **與 CC 相同** | `(sleep; touch) &`：工具回傳後、session 結束後，兩邊的 marker 都照樣產生 | `bash-process.ts:151–179` |
| 12a | 背景任務開輸出檔失敗時沒有 rollback | **pi-only** | 刪掉 tasks 目錄後：CC 正常重建；pi 回 `ENOENT` 錯誤，但命令仍在執行（`bg2_ran true`），且沒有登記，無法 TaskStop | `bash.ts:426–449` |
| 12b | 寫入失敗時 FD 洩漏 | pi 內部；已確認 | 模擬 `writeSync` 丟出 ENOSPC 後，任務狀態為 `completed`，但仍有 1 個 FD 指向輸出檔未關閉 | `bash.ts:463–469` |
| 13 | 取消／shutdown 後仍能啟動新工作 | pi 內部；已確認 | (a) signal 已 abort，背景 Bash 仍會執行（`marker exists: true`），前景則會拒絕；(c) `NotificationQueue` 沒有監聽 `session_shutdown`，shutdown 後仍呼叫 `sendMessage(triggerTurn:true)`；(b) 由程式碼確認：`createChildSession` await 返回後沒有檢查 `shuttingDown` | `bash.ts:645–650`；`notifications.ts:51–55,74–88`；`subagent/index.ts:567–608,693–703` |
| 14 | 完成的任務仍被 closure 保留 | pi 內部；已確認，CC 不同 | registry 沒有 remove 方法，完成的任務一直留著；CC 有 `evictTerminalTask` 會移除已結束的任務 | `background.ts:37–44`；`subagent/index.ts:612–620` |
| 15 | 前景 subagent 的 task 變更不會持久化 | pi 內部；已確認 | 父 agent 的 TaskList 看到 `parent`、`child` 兩項；`taskListFromBranch(父 branch)` 只有 `["parent"]` | `src/tools/task-tools.ts:625–633,663–674` |
| 16 | 搜尋 I/O 錯誤被當成無匹配 | **與 CC 相同** | 以 uid 65534 執行，檔案為 000：兩邊都回 `No files found`／`No matches found`；Glob 也相同（`countIsComplete` 只出現在 pi 的 details，模型看不到） | `src/tools/grep.ts:308–328`；`glob.ts:137–162` |
| 17a | content 截斷時丟失整組結果 | **pi-only** | 40 萬行 `a_big` 加 1 行 `b_small`，head_limit 5：CC 回 5 行（`b_small` 加 4 行 `a_big`）；pi 只回 `b_small.txt:1:match small` | `grep.ts:467–487,519` |
| 17b | NUL 分隔清單截斷時全部丟失 | **pi-only** | 9 萬個長檔名（約 22MB）：CC 的 Glob 與 Grep 都回結果；pi 兩者都報錯 `Ripgrep output passed the 20MB limit before a single complete line…` | `grep.ts:298–305,317–320`；`glob.ts:146–153` |
| 18 | Read 的 token 上限沒計入行號 | **與 CC 相同** | 10 萬個換行：CC 689k 字元、pi 688.9k 字元，兩邊都沒有截斷提示 | `read.ts:438–460,506–507` |
| 19 | replace_all 刪除時漏掉不帶換行的匹配 | **與 CC 相同** | `"foo\nfoo"` 兩邊結果都是 `"foo"`，都回報 All occurrences replaced | `src/tools/edit.ts:233–235` |
| 20 | worktree 部分建立後失敗，留下殘留 | **pi-only** | post-checkout hook `exit 1`：CC 忽略 hook 失敗，照常執行 agent 並清理（worktree list 1、分支 0）；pi 報錯 `Cannot create an agent worktree … hookfail`，且留下目錄、worktree 登記與分支 | `worktree.ts:44–48` |
| 21 | async `onEvent` 的 rejection 沒有被隔離 | pi 內部 API；已確認 | 出現 `UNHANDLED REJECTION: host async boom`（CC SDK 沒有對應 API） | `src/shared/context.ts:29–34` |
| 22 | parity 漏報圖片與 binary 差異 | harness 問題；看程式碼屬實 | `textOf()` 把非 text 區塊轉成空字串；含 NUL 的檔案只保留 `<binary N bytes>` | `parity/mock-server.ts:55–64`；`parity/workspace.ts:29–30` |
| 23 | 錄製重播替換錯誤的值 | harness 問題；已確認 | 錄到 `Task ID: 1`、重播時為 `ID: 2`：`{"command":"sleep 1","timeout":10000}` 變成 `{"command":"sleep 2","timeout":20000}`。路由問題由程式碼確認（main 請求也會套用 `firstUser.includes(match)`） | `parity/recording.ts:26–70`；`mock-server.ts:137–141` |
| 24 | snapshot 跟隨 symlink 越出 workspace | harness 問題；已確認 | 快照包含 `link/SENTINEL.txt`；`loop -> .` 丟出 `ELOOP`；`compareFiles: []` 時仍會遍歷（#16 的探測中，因 EACCES 讓整個 harness crash） | `parity/workspace.ts:21–30` |
| 25 | mock server 的 rejection 讓程序終止 | harness 問題；已確認 | 送出錯誤的 gzip body，因未處理的 `Z_DATA_ERROR` 終止程序 | `mock-server.ts:98,115–122` |
| 26 | 大型 UTF-16 檔被當成 UTF-8 解碼 | **pi-only**（與程式碼註解相反） | 64.8MB 的 UTF-16LE 檔：CC 回 `1 hello`／`2 xxxx…`；pi 回 `��h\0e\0l\0l\0o\0`，夾雜 NUL | `read.ts:381,429`（門檻在 `read.ts:27`，10MiB） |
| 27 | notebook cell 型別轉換的結構 | **與 CC 相同** | md→code、code→md 後的 JSON 兩邊逐字相同 | `notebook-edit.ts:201–208` |
| 28 | AskUserQuestion 的 `"__proto__"` 問題 | **pi-only** | CC：`"__proto__"="A"`；pi：`The user did not answer the questions.`（`"constructor"` 兩邊相同） | `src/tools/ask-user-question.ts:380–386,424` |

## 各項說明與關鍵輸出

**#1**：`set -e; false; touch marker; printf continued`。claude：`continued`，產生 `marker`；pi：相同。
**#2**：使用自訂 runner（CC 端為 `settingSources:["project"]` 加 `agents` 加 SDK MCP server `prod`；pi 端為 `subagentExtensions` 註冊 `mcp__prod__danger`）。
- `empty`（options，`tools: []`）：CC 的 child 請求有 0 個工具，被 mock 歸類為 side request；pi 的 `subagentTools` 為 `["Agent","Bash","Edit","Glob","Grep","NotebookEdit","Read","TaskStop","Write","mcp__prod__danger"]`，`executed: ['pi:mcp__prod__danger']`。
- `emptydisk`（frontmatter `tools: []`）：結果同上。
- `noall`（`disallowedTools: "*"`）：兩邊工具清單相同，`executed: ['claude:…','pi:…']`，屬於與 CC 相同。
- `nomcp`（`mcp__prod__*`）、`nomcpsrv`（`mcp__prod`）：CC 回 `Error: No such tool available: mcp__prod__danger`，pi 回 `danger ran`。
- `readonly`（`tools: Read`，MCP 工具設為 deferred）：CC 的 child 工具清單為 `["Read"]`，呼叫 ToolSearch 與 danger 都回 `No such tool available`；pi 的工具清單為 `["Read","tool_search"]`，第二輪出現 `mcp__prod__danger` 並成功執行。

**#3**：CC 的 schema 與 pi 相同，`enum:["worktree","remote"]`。非 git 目錄時，兩邊 child 的 `pwd` 都是 `<CWD>`，且都在前景回傳 hand-back。git 目錄時，兩邊都在 `.claude/worktrees/agent-*` 執行並回報 worktreePath。
**#4**：untracked 情境的 inspect 輸出（ls、worktree 數、分支數、commit 數）：claude `agent-ae33…/2/1/1`、pi `(空)/1/0/1`。detached 情境：claude `1/1/2/0`、pi `1/0/1/1`（pi 的 fsck 出現 dangling）。
**#5**：Read、外部改寫並 `touch -r` 還原 mtime、再 Read：兩邊都回 `Wasted call — file unchanged…`；之後 Write 兩邊都成功，NotebookEdit 也兩邊都成功（內容都被覆寫成 `three`／`print(3)`）。CC binary 中也有多處 `Math.floor(x.mtimeMs)`。
**#6**：在程序內監測 pi 的 RSS：baseline 為 `287MB`，執行 Read 時為 `1283MB, elapsed 6496ms`。CC 子程序全程峰值為 `382MB`，且包含 101MiB notebook 的步驟。
**#7**：`.png` FIFO：兩邊都回 `File has an image extension but its content is not a valid PNG… (hex: 68 65 6c 6c 6f 0a)`，耗時約 8.3s。`.txt` FIFO 的 Read：CC 阻塞後讀出 `hello`，pi 立即拒絕（`is not a regular file`）；pi 這裡比 CC 更保守，不構成 bug。Edit：pi `The file …/f.txt has been updated successfully.`，獨立的 reader 讀到 `bye`；CC `Not a regular file (device, FIFO, or socket)`。Write：兩邊都立即拒絕。
**#8**：files 結果兩邊都是 `{ space: 'NEW\n', 'space ': 'orig-trailing\n' }`。
**#9**：spill 檔：claude `BEGIN … END 12582923`；pi `aaaaa … END10461188`。結果中 claude 標示 `Output too large (12MB)`，pi 標示 `(10MB)`。
**#10**：以 `TMPDIR` 指向全新目錄再跑 CC：`700 …/fresh-tmp-*/claude-0`，表示 CC 會自己建立 0700 的根目錄。pi 的輸出路徑 `755 /tmp/pi-cc-tasks/<key>/tasks`、`755 /tmp/pi-cc-tasks`，檔案 `644`。
**#11**：`after session end+5s: claude marker true pi marker true`。
**#12**：`bg2 after dir gone`：claude 回正常啟動訊息；pi 回 `ENOENT: no such file or directory, open '<TMP>'`，之後 `claude bg2_ran true pi bg2_ran true`。FD 測試輸出：`task status: completed fds still open on output file: 1`。
**#13**：`bg with aborted signal -> Command running in background…`、`marker exists: true`；前景則為 `fg threw: Command was aborted before completion`。`NotificationQueue listens to session_shutdown: false sendMessage calls after shutdown: [{"deliverAs":"followUp","triggerTurn":true}]`。
**#14**：`registry after completion: [["byukw3xw8","completed"]] registry has remove method: undefined`。CC binary 中有 `evictTerminalTask: evicted task ${e}`。
**#15**：`TaskList seen by parent: "#1 [pending] parent\n#2 [pending] child"`、`rebuilt from parent branch: ["parent"]`。CC 的任務清單另行存放（磁碟），不受 branch 重建影響，所以這是 pi 特有的設計缺口。
**#16**：以 `setpriv --reuid=65534` 執行，`cat locked.txt` 出現 `Permission denied`。Grep／Glob 結果兩邊相同（`No files found`、`No matches found`、Glob `**/*.txt` 列出 `locked.txt open.txt`）。
**#17**：見總表。另有一個額外觀察（不在 review 中）：count 模式下 CC 依 rg 或 mtime 的順序輸出（`b_small` 在前），pi 則依路徑排序（`a_big` 在前）。
**#18**：`claude result chars 688989 … has truncation banner false`、`pi result chars 688902 … false`，正規化後判定為 same。
**#19**：兩邊的 `od -c` 都是 `f o o`。
**#20**：inspect 結果：claude `(無目錄)/1/0`；pi `agent-ceca1544/2/1`。CC 的 child 也確實在 worktree 中執行過。
**#21–25**：見總表輸出。
**#26**：CC 能正確解碼，pi 輸出 `M-oM-?M-=M-oM-?M-=h^@e^@l^@l^@o^@`。小檔（12 字元）兩邊都正常。
**#27**：檔案快照逐字相同：code→markdown 時 `outputs: []`、`execution_count: null` 都被保留；markdown→code 時沒有補上 outputs。
**#28**：見總表。

## 建議修正（pi-only）

1. **#2a／2b／2d**：subagent 工具限制。要區分 `tools: []` 與未指定；限制要套用到 deferred 與 `subagentExtensions` 工具（tool_search 的候選、啟用、執行都要過濾）；`mcp__server`／`mcp__server__*` 要依 CC 的規則比對。`disallowedTools: "*"` 不在此列，與 CC 相同。
2. **#4a／4b**：worktree 清理。判斷是否乾淨時改用 `--untracked-files=all`，並比對分配分支的 tip；CC 在 detached 情境會保留分支。
3. **#20**：`worktree add` 遇到 hook 失敗時要比照 CC：不能直接報錯並留下殘留。
4. **#6a**：Read 的 partial／串流路徑不要為了 `recordRead` 而 `readFile` 全檔。
5. **#7b**：Edit 在讀檔前就拒絕非一般檔案（CC 的訊息是 `Not a regular file (device, FIFO, or socket)`），絕不可寫入 FIFO。
6. **#9**：Bash 輸出超過 10Mi 字元時，spill 檔要包含完整輸出（CC 會保存完整的 12MB）。
7. **#10**：背景輸出的根目錄比照 CC，使用 `$TMPDIR/<name>-<uid>`，權限 0700；spill 的預設目錄也應改到私有位置。
8. **#12a**：開輸出檔失敗時要停止已 spawn 的程序（CC 會重建目錄）。#12b：`closeSync` 改放進 `finally`。
9. **#17a／17b**：截斷時要保留不完整的最後一組 JSON 結果；NUL 分隔的輸出要以 NUL 作為截斷邊界。
10. **#26**：串流 Read 也要辨識 UTF-16LE BOM（CC 2.1.302 會處理；`read.ts` 的註解與 CC 實際行為不符）。
11. **#28**：answers 改用 `Object.create(null)` 或 Map，存在性判斷改用 `Object.hasOwn`。
12. pi 內部生命週期（沒有 CC 對照，但已確認屬實）：**#13**（abort／shutdown 的入口檢查、NotificationQueue 監聽 shutdown）、**#14**（比照 CC 的 `evictTerminalTask` 移除已結束任務）、**#15**（共享 TaskStore 的變更要寫入父 branch）、**#21**（處理 `onEvent` 回傳的 Promise）。
13. parity harness（不影響產品，但會削弱驗證可信度）：**#22–25**。

## 與 Claude Code 相同（需決定是否偏離）

- **#1** Bash `set -e` 失效（`eval … && pwd`）
- **#2c** `disallowedTools: "*"` 被忽略
- **#3** `isolation: "remote"` 靜默降級成 worktree 或本機、前景執行
- **#5** mtime 未增加就跳過內容比對（Read dedup，以及 Write／NotebookEdit 的覆寫保護）
- **#6b** NotebookEdit 先做 stale 檢查再檢查大小
- **#7a** FIFO 命名成 `.png` 時 Read 會阻塞（abort 無法解除，CC 也阻塞）
- **#8** 路徑 `trim()`
- **#11** shell 結束後，子程序不會被清理
- **#16** rg 權限錯誤被回報為無匹配
- **#18** Read 的 token 預算沒計入行號
- **#19** replace_all 刪除時漏掉不帶換行的匹配
- **#27** notebook cell 型別轉換時沒有調整欄位

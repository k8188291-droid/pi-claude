## 審查結論

目前的測試覆蓋不少正常流程，但仍有數項涉及**錯誤執行、工具限制繞過、資料遺失與背景資源管理**的問題，建議先處理 P1，再補上失敗與中斷情境的測試。

本次全程未修改專案檔案，最後確認 Git 工作樹乾淨。

### 驗證範圍
- 現有測試：**17 個測試檔、273 項測試全部通過**。
- 正式程式碼與 parity 框架的 TypeScript 型別檢查均通過。
- 針對問題以直接呼叫工具、faux provider、獨立暫存目錄或記憶體 mock 重現。
- **未執行完整 Claude Code／pi parity 重播**，因此以下不宣稱全部都是與 Claude Code 本體的差異。
- 未將 README 已明示的「沒有權限系統」或「Write／Edit 不需先 Read」列為缺陷。

以下按嚴重度排序；同一子系統的相關問題合併說明。

---

## P1：應優先修正

### 1. 前景 Bash 包裝會讓 `set -e` 失效

**位置：** `src/tools/bash-process.ts:109–112`

產生的腳本是：

```bash
eval '<使用者指令>' && pwd -P > ...
```

由於 `eval` 位於 `&&` 左側，Bash 會對其中的指令忽略 `errexit`。

**已重現：**
```bash
set -e; false; printf SHOULD_NOT_RUN
```

前景包裝會印出 `SHOULD_NOT_RUN`，並回傳 exit 0；不含 cwd side channel 的包裝則正確停止、回傳 exit 1。這可能讓建置、部署或安全檢查在前置步驟失敗後繼續執行。

**建議修法：** 不要將 `eval` 放在會抑制 `errexit` 的條件位置。獨立執行命令並保留原始退出狀態，再依成功與否記錄 cwd。

### 2. 延遲工具可透過 `tool_search` 繞過 subagent 工具白名單

**位置：** `src/subagent/index.ts:329–335, 356, 404–405`

目前限制只透過 `setActiveToolsByName()` 過濾已啟用的工具；禁止的 deferred 工具仍留在 registry，之後可以被 `tool_search` 找到並啟用。

**已重現：** 將 agent 設為 `tools: ["Read"]`，由 `subagentExtensions` 註冊一個不在白名單內的 deferred 工具。子 agent 搜尋後成功載入並實際執行該工具。

**建議修法：** 在子 session 的註冊／可執行層套用 allowlist，而不只是隱藏宣告。工具搜尋與直接執行路徑都必須使用相同的限制。

### 3. `isolation: "remote"` 會靜默降級成本機執行

**位置：** `src/subagent/index.ts:556–563`；`src/subagent/prompt.ts:105–106`

工具描述承諾 remote cloud environment，且固定背景執行；實作卻在 Git repo 中改成本機 worktree，非 Git 目錄則直接使用父 cwd，也仍接受前景執行。

**已重現：** 在模擬非 Git 環境中，`remote + run_in_background: false` 成功以前景執行，child cwd 就是父 cwd，沒有降級警告。

**建議修法：** 尚未支援 remote 時直接拒絕。若需要 fallback，應由 host 明確 opt-in，並在執行前揭露實際模式，不可靜默降低隔離程度。

### 4. 外部修改保護可能漏判，導致覆蓋使用者變更

**位置：** `src/shared/file-state.ts:69–70, 81–84, 137–148`；`src/tools/read.ts:529–530, 1095–1101`

`isStale()` 在 `mtime <= recorded timestamp` 時直接判定未變更，且時間戳被取整到毫秒。因此：

- 外部修改若保留／倒退 mtime，Write 可以覆蓋新內容。
- 同一毫秒內的變更可能被漏掉。
- Read 可能對已變更檔案錯回 `Wasted call`。
- `recordRead()` 將先前讀到的內容 hash 搭配讀完後的 mtime；若期間有外部寫入，會形成錯誤的快照。

上述時間戳與讀取競態均已重現，違反 README「讀過之後被外部改動，就拒絕覆寫」的承諾。

**建議修法：** 修改前比較目前內容 hash，不能只靠 mtime 是否增加。讀取時使用同一 file handle 驗證快照穩定性；`Wasted call` 也需可靠的版本或內容判斷。

### 5. 工具輸出暫存檔預設會洩漏給其他本機使用者

**位置：** `src/shared/background.ts:55–65`；`src/tools/bash.ts:427–431`；`src/output-spill.ts:112–116`

目錄與輸出檔未指定私有權限。在常見的 `umask 022` 下，實測為目錄 `0755`、檔案 `0644`，其他本機帳號可列舉並讀取背景工作或 spill 的輸出。

此外，spill 使用可預測的清理後檔名及一般 `writeFile`：
- 會跟隨既有符號連結，已重現覆寫連結目標。
- 不同 tool-call ID 清理後可能撞名，已重現覆寫前一個結果。

**建議修法：** 使用私有暫存目錄 `0700`、檔案 `0600`，驗證既有目錄的擁有者與權限；以唯一檔名及排他建立避免碰撞／symlink。符號連結攻擊需要攻擊者能預先寫入輸出目錄，並非遠端任意檔案覆寫。

---

## P2：正確性、資料安全與資源風險

### 6. 寫入非原子操作；工具報錯時，原檔可能已毀損

**位置：** `src/tools/write.ts:107–110`；`src/tools/edit.ts:393`；`src/tools/notebook-edit.ts:215–217`

三種修改工具都直接對原檔呼叫 `writeFile`，會先截斷內容。已在限制檔案大小的子程序中重現：Write 拋出 `EFBIG`，原檔卻已變成只有 1,024 bytes 的新內容。

**建議修法：** 同目錄建立唯一暫存檔，完整寫入成功後再原子 `rename`；失敗只清除暫存檔。需一併定義權限及 symlink／hardlink 語意。

### 7. 路徑 `.trim()` 會把合法檔名指向另一個檔案

**位置：** `src/shared/paths.ts:5–9`

Unix 檔名可以包含前後空白。實測同時存在 `trailing` 與 `trailing ` 時，對後者 Write，實際被覆寫的是前者。此函式也供其他檔案及搜尋工具使用。

**建議修法：** 保留完整路徑字串，移除 `.trim()`；非法輸入應明確拒絕，不應偷偷改指向另一個檔案。

### 8. Bash 可能把前段命令失敗誤報成成功

**位置：** `src/tools/bash.ts:260–277, 586–588`

退出碼判斷依原始文字的「最後一個命令」，對 grep 等命令放寬 exit 1，卻沒有確認該命令是否真的執行。

**已重現：**
```bash
false && grep x /dev/null
```

grep 根本沒有執行，工具仍將 exit 1 當成非錯誤，回傳完成訊息。`npm test && grep ...` 等情境也可能掩蓋測試失敗。

**建議修法：** 保守地只對可確認的單一命令套用例外；複合命令不能只靠字串末段推斷退出碼來源。

### 9. Bash 程序與 FD 的生命週期缺少完整回收

**位置：** `src/tools/bash-process.ts:151–179`；`src/tools/bash.ts:427–469, 549–559, 607–615`

確認兩類問題：

- `sleep 30 & printf '%s' "$!"` 的 shell 結束後，子程序仍存活，但 PID 已解除追蹤、task 被標為完成，TaskStop 與 shutdown 都無法再清理。
- 程序先啟動，之後建立背景輸出檔若失敗，可能尚未加入 registry 就失去管理。已重現工具報 `ENOTDIR`，shutdown 後程序仍存活。

另外，開檔後的初始寫入失敗，或完成階段 `writeSync` 失敗，都可能跳過關閉 FD。

**建議修法：** 將程序啟動與背景接管做成可回滾流程；成功接管前保留原追蹤。關閉 FD 應放在 `finally`，並區分「shell 已退出」與「整個 process group 已結束」。

### 10. 已完成背景工作仍保留大型記憶體 buffer

**位置：** `src/shared/background.ts:36–44`；`src/tools/bash.ts:430–446, 457–489`

registry 沒有移除已完成工作的路徑；task 的 `stop()` closure 又捕捉整個 `run`，包含輸出 buffer。

已用 WeakRef／GC 驗證，完成的工作仍保留 2 MiB buffer；清除 registry 後才可回收。每個轉背景工作可能持續保留約 10 Mi 字元，長 session 可能累積到 OOM。

**建議修法：** 完成後釋放 closure、程序與 buffer 引用；歷史只保留小型 metadata，並設置有界保留策略。

### 11. 所謂「完整輸出」可能已被靜默截掉開頭

**位置：** `src/tools/bash-process.ts:5–6, 19–27`；`src/tools/bash.ts:430–431, 600`；`src/output-spill.ts:109–116`

OutputBuffer 超過約 10 Mi 字元便丟棄最早內容，後續 spill 或轉背景只能保存剩下的尾段。

已重現 11 MiB 輸出中的 `BEGIN` 消失，卻沒有截斷提示。這不符合 README 第 25 行「完整內容寫到暫存檔」的描述。

**建議修法：** 從輸出產生時就串流保存完整內容，記憶體只留有限預覽；若產品確實要設總量限制，必須明確標示丟棄量，不可稱為 Full output。

### 12. 巢狀 Agent 使用另一份 context，導致 TaskStop 與 task 分享失效

**位置：** `src/index.ts:28–40`；`src/subagent/index.ts:346–362`

子 session 的基本工具與 TaskStop 使用第一份 `CCContext`，巢狀 Agent 卻另外建立 context，因而使用不同的 registry；第二份 context 也沒有設定 task store。

**已重現：**
- worker 啟動背景後代，卻無法用自己的 TaskStop 停止回傳的有效 ID。
- 三層前景 agent 中，最內層新增的 task 未出現在根 session。

**建議修法：** 每個 session 只建立一份 context，讓 Agent、TaskStop、notifications 與 task store 共用。

### 13. Agent 啟動、完成與 shutdown 存在生命週期競態

**位置：** `src/subagent/index.ts:274–282, 486–518, 565–608, 635–659, 693–704`；`src/subagent/worktree.ts:59–71`

確認以下行為：

- launcher 回覆 final 後立即 dispose，仍在執行的背景後代會被取消，外層卻可能已回報成功。
- worktree 清理早於 child shutdown，背景程序或 shutdown handler 可能仍在使用目錄。
- 建立中的 child 尚未加入 `runs`，shutdown 看不到；已重現 shutdown 返回後，初始化完成的 child 仍開始執行。

worktree 順序以記憶體 Git mock 驗證；實際資料刪除風險屬於程式路徑推論，未做破壞性實測。

**建議修法：** 第一個 `await` 前登記 pending launch，以 session 級 abort controller 管理；先停止並等待後代與 shutdown handler，再判斷是否移除 worktree。若不支援背景後代存活至 launcher 結束後，應在啟動時拒絕。

### 14. 子 agent 的共享 task 更新未持久化至父分支

**位置：** `src/tools/task-tools.ts:624–634, 663–684`；`src/subagent/index.ts:638–651`

父分支只從自己的 TaskCreate／TaskUpdate 結果還原 task；child 的變更只更新共享記憶體與 host events。

已重現父 TaskList 當下有兩項，觸發 `session_tree` 重建後只剩父原先建立的一項。這不符合 README「存在 session、跟著分支走、和前景 subagent 共用」的組合承諾。

**建議修法：** 由父 session 將共享 store 的每次更新保存成可還原的 task-state entry，不要只發 host event。

### 15. Read 指定一行，仍可能把整個大檔載入記憶體

**位置：** `src/tools/read.ts:428–434, 529–532`

大檔範圍讀取雖走 streaming，但 `range.raw` 不存在，記錄 file state 時又執行一次整檔 `readFile(absPath)`，且未帶取消訊號。

**影響：** `Read(limit: 1)` 仍可能配置與整檔大小成正比的記憶體，甚至 OOM。此項由程式路徑確認，未以多 GB 檔案壓測。

**建議修法：** 串流增量計算 hash，或使用獨立的 partial-view 狀態；不能為追蹤狀態再次整檔載入。

### 16. FIFO／特殊檔案可讓工具卡住，abort 也無效

**位置：** `src/tools/edit.ts:329–340`；`src/tools/write.ts:93–96`；`src/tools/read.ts:1146–1149`

Edit 未先確認 regular file；Read 的圖片分支又早於通用檔案型別檢查。

已對沒有 writer 的 FIFO 重現：
- Edit `input.txt` 卡住。
- Read `input.png` 卡住。
- 發出 abort 後仍不返回，只能由外部 timeout 終止。

**建議修法：** 所有文字、圖片、PDF、notebook 分支在 I/O 前統一檢查 regular file；必要時安全開啟後對同一 handle 做 `fstat`，並傳遞取消訊號。

### 17. `replace_all` 刪除不完整，卻回報全部成功

**位置：** `src/tools/edit.ts:228–237, 397–399`

已重現：

```text
原內容：foo\nfoo bar\nfoo
old_string：foo
new_string：""
replace_all：true
結果：foo bar\nfoo
```

只刪掉第一行，行內及 EOF 的匹配都保留下來。原因是只要找到 `oldString + "\n"`，整次操作便改搜這個較長字串。

**建議修法：** 以原始匹配逐一替換；若要保留刪除整行換行的特殊規則，應逐個匹配判斷，不能全域更換搜尋字串。

### 18. 編碼與換行處理在不同路徑不一致，可能靜默改檔

**位置：** `src/tools/write.ts:67–76, 101–103, 155–161`；`src/tools/read.ts:322–328, 381–434`

已確認：

- UTF-32LE BOM `FF FE 00 00` 被認成 UTF-16LE，Write 後編碼被靜默轉換。
- 不完整 UTF-16LE 的尾端 byte 在 Edit 後遺失。
- 超過 10 MiB 的 UTF-16LE 改走 UTF-8 streaming，Read 回傳亂碼且無警告。
- Write 固定傳 `"LF"`，將 CRLF 原檔改成 LF，與 README 第 13 行相反。

**建議修法：** 共用一致的 codec：先辨識完整 BOM、嚴格驗證解碼有效性，streaming 與一般路徑使用相同規則；Write 應保留既有 line endings，或修正文案明確揭露差異。

### 19. Notebook cell 定位可能歧義，型別轉換也會產生非法結構

**位置：** `src/tools/read.ts:891–897`；`src/tools/notebook-edit.ts:164–176, 200–208`

已重現兩種問題：

- 真實 ID `cell-1` 與另一個無 ID cell 的合成 ID `cell-1` 碰撞，依 Read 顯示的 ID 操作會改到另一個 cell。
- markdown 轉為 code 時，先依舊型別處理欄位、最後才修改 `cell_type`，因此缺少 `outputs`／`execution_count`，並可能保留不適用欄位。

**建議修法：** cell locator 必須唯一，歧義時拒絕；先決定目標型別，再建立／移除相應欄位，序列化前驗證 nbformat。

### 20. Grep 將無法搜尋誤報為沒有匹配

**位置：** `src/tools/grep.ts:298–328, 562–588`

已對本環境的 `/proc/1/mem` 重現：ripgrep exit 2、stderr 為 Permission denied、實際搜尋數為零，工具卻成功回傳 `No matches found`。

原因包括把 JSON summary 視為「有輸出」，以及只特別處理部分 usage error。

**建議修法：** exit 2 且無可用匹配時回報失敗；若保留部分結果，必須明示搜尋未完成，不能與「已搜尋且不存在」混為一談。

### 21. 搜尋中斷時，可能丟掉完整結果或將部分結果宣稱為完整

**位置：** `src/tools/grep.ts:298–328, 335–350`；`src/tools/glob.ts:137–160`

- runner 一律按換行丟棄未完成紀錄，但檔名模式是 NUL 分隔；逾時時可能把已完整收到的檔名全部丟掉。
- 保留下部分結果時，timeout／stdout cap 狀態又未傳給上層。已重現 Grep 無未完成警告，以及 Glob 回傳錯誤的 `countIsComplete: true`。

**建議修法：** runner 必須知道輸出 framing；檔名依 NUL、JSON/count 依換行保留完整紀錄。向上傳遞 incomplete 狀態，計數只能視為下界。

### 22. 普通物件字典造成特殊鍵資料遺失與驗證繞過

**位置：** `src/tools/input-validation.ts:115–137`；`src/tools/task-tools.ts:527–546`；`src/tools/ask-user-question.ts:380–386, 424–425`

已確認：
- metadata 的 `__proto__` 變成物件 prototype，而非 own property；可讓 task 因繼承 `_internal` 而從清單消失。
- 未宣告的 `constructor` 通過 strict 參數檢查。
- question 為 `__proto__` 時答案遺失；為 `constructor` 時可能錯判已回答。

這是個別物件的 prototype 被改動，**未觀察到全域 `Object.prototype` 污染**。

**建議修法：** 字典使用 null-prototype object 或安全建立 own property；鍵存在性一律使用 `Object.hasOwn`。parser、metadata merge、答案正規化需一併修正。

---

## P3：設計與驗證改善

| 項目 | 位置 | 問題與建議 |
|---|---|---|
| **23. Grep 的 stat 無界排程** | `src/tools/grep.ts:622–631` | 分頁前對所有匹配路徑啟動 `Promise.all(stat)`。40,000 筆合成路徑測試中，即使 `head_limit: 1` 仍排程 40,000 次。改用有界 worker pool、加入取消檢查；需保留 mtime 排序語意。 |
| **24. 非同步 host callback 錯誤未隔離** | `src/shared/context.ts:29–33` | `try/catch` 只能攔截同步錯誤。`onEvent: async () => { throw ... }` 已重現 `unhandledRejection`，可能終止 Node 程序。應明確支援並捕捉回傳 Promise 的 rejection，或限制／驗證 callback 契約。 |
| **25. parity schema 比對只看欄位名稱** | `parity/compare.ts:67–69, 108–118` | 已重現同名參數一邊是必填 number、另一邊是選填 string，仍得到 `schemaDiffs: []`。應遞迴比較 type、required、enum、範圍、items 等 schema 語意，而非只比較 property names。 |
| **26. workspace snapshot 跟隨 symlink** | `parity/workspace.ts:20–30` | `statSync` 跟隨連結，可能遍歷 workspace 外的內容；循環連結已重現 `ELOOP`。改用 `lstat`，將 symlink 本身納入快照，避免遞迴跟隨，並對二進位內容使用 hash 而非只比較長度。 |

---

## 建議處理順序

1. **先修執行與隔離語意：** Bash `set -e`、工具白名單、remote 靜默降級。
2. **再修資料安全：** 外部變更判斷、私有暫存檔、原子寫入與路徑保真。
3. **統一生命週期管理：** session context、pending launch、process group、背景後代、FD 與 worktree teardown。
4. **補失敗路徑回歸測試：** 磁碟寫入失敗、特殊檔案、搜尋逾時／權限錯誤、分支重建、特殊字典鍵與編碼邊界。

整體而言，正常路徑已有良好基礎；目前最需要加強的是：**失敗後是否仍保有原資料、停止後是否真的沒有工作繼續執行，以及不完整結果是否被誤當成成功或完整結果。**
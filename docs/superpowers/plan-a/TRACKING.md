# 子專案 A 計畫撰寫進度追蹤

計畫檔：`docs/superpowers/plans/2026-09-01-yeschef-a-sdk-host.md`
契約：`docs/superpowers/plan-a/CONTRACT.md`

| Task | 內容 | 狀態 | 負責 |
|---|---|---|---|
| 1 | session-args（cwd 守衛） | 已寫入計畫 | 控制端 |
| 2 | closeIncomplete（前綴測試） | 已寫入計畫 | 控制端 |
| 3 | events.ts 與兩個正規化轉接器 | 待派 | |
| 4 | fold.ts 投影函式 | 待派 | |
| 5 | session 狀態機 | 待派 | |
| 6 | approval.ts 待決 promise 註冊表 | 待派 | |
| 7 | layout.ts 擴三欄 | 待派 | |
| 8 | agent-host.ts 與 IPC 橋接 | 待派 | |
| 9 | React 版面與 Conversation／Turn／ToolCall | 待派 | |
| 10 | ApprovalCard 端到端 | 待派 | |
| 11 | session-store 與 Recents | 待派 | |
| 12 | 整合驗收清單 | 待派 | |

## 跨模型審查紀錄

2026-09-02，Claude opus 與 codex 各一份，對象是規格加 Task 1-3。

三項共識發現，全部已修進 Task 1、2：
- 前綴測試四條斷言全為否定式，`return ''` 通過 157 個案例
- 拿掉圍欄內外之分的實作通過全部 9 個測試，含那條名字在講圍欄的
- `normalizeLive` 丟掉 20/32 筆 stream_event，含 `content_block_stop`（complete 的唯一來源）與 `input_json_delta`

codex 額外貢獻（實機驗證）：
- `path.resolve('.../YesChef')` 不做大小寫正規化，`realpathSync.native()` 才會。macOS 上同一個 inode 被 resolve 判為不相等
- `/var` 是指向 `/private/var` 的符號連結

Claude 額外貢獻：
- `permissionMode: 'manual'` 過不了 typecheck，執行期靜默降級為 default（傳 plan 回報 plan 可證該欄位忠實）
- 規格與計畫五處對不上，含 §9 說「3000 字真實文件」但計畫用 157 字元手寫文件

控制端額外查證：
- `tool_use_result` 在 user 訊息頂層而非 content 內，是規格 §6 的唯一來源

## 契約裁決紀錄

| # | 日期 | 裁決 | 來源 | 判斷錯的代價 |
|---|---|---|---|---|
| 1 | 09-02 | 區分「認得出但無內容」（回空陣列加註解）與「認不出來」（產出 unknown），前者窮舉五類 | Task 3 撰寫者回報：原契約會讓兩輪對話產生 6 張原始 JSON 卡片 | 少數事件被歸錯類，UI 多或少幾張卡片 |
| 2 | 09-02 | `normalizeLive` 改為 `stepLive(msg, cursor)`，呼叫端持有游標，禁用 module 層級可變狀態 | 實機確認 content_block_* 不帶 message id | 若其實有別的方式取得 id，代價是多一個參數 |
| 3 | 09-02 | `tool_use_result` 兩種形狀（物件與純字串）統一成同一種 | fixture 02 實測為字串 | 無 |
| 4 | 09-02 | 歷史對話無 tool-raw-output，列為已知限制，Task 11 要顯示明確說明而非空展開區 | getSessionMessages 產物不含該欄位 | 使用者以為工具沒輸出 |

## Task 撰寫狀態（更新於 09-02）

| Task | 狀態 | 產出 |
|---|---|---|
| 1、2 | 已寫入計畫 | 控制端 |
| 3 | 已完成待審 | `task-3.md`（858 行、36 測試、4 突變全實測，實跑過 tsc 與測試） |
| 6 | 已完成待審 | `task-6.md`（7 Step、11 測試、3 突變全實測） |
| 7 | **不進計畫**（裁決 9） | `task-7.md` 保留供日後參考。Electron 維持兩欄，側邊欄分割改由 React CSS 處理 |
| 4 | 已完成待審 | `task-4.md`（765 行、12 測試、3 突變全實測。範圍已縮小為 fold 核心，工具狀態機移到 4B） |
| 4B | 已完成待審 | `task-4b.md`（682 行、23 測試、3 突變全實測。提出裁決 11-13） |
| 8 | 已完成待審 | `task-8.md`（1806 行、約 60 測試、7 突變。提出裁決 6-8） |
| 9 | 已完成待審 | `task-9.md`（7 Step、9 測試、4 突變全實跑。提出裁決 9-10） |
| 9B、10、11 | 第三波已派（09-02 16:40） | 對話元件／批准卡片／Recents。接縫先寫進契約再派 |
| 12 | 等 9B／10／11 回來再派 | 整合驗收清單要看最終形狀 |
| 5 | 已完成待審 | `task-5.md`（316 行、17 測試、3 突變。**控制端撰寫**，subagent 兩次撞輸出上限） |

## 派工失誤紀錄（控制端自省）

五個 agent 有三個因同一原因中止：單次回應超過 16384 token。寫計畫天生產生長輸出
（task-3.md 是 858 行 34 KB），而 agent 預設一次吐完。

修法是要求分次寫檔（多次 Write／Edit，每次控制在 6000 token 以內）。Task 3、6、7
沒掛是因為它們碰巧自己那樣做，不是因為指示寫了。**控制端到第三次失敗才把這條
寫進派工單。** 第二波（Task 8-12）此條為預設。

## Task 撰寫者回報的重要發現

| 來源 | 發現 | 意義 |
|---|---|---|
| Task 3 | 突變「messageId 一律傳空字串」後筆數完全不變、40 個 Event 全在，只有 2 條檢查內容的測試紅 | 「看起來還會過」的突變，後果是同一段回答渲染兩遍 |
| Task 6 | 突變「拿掉清理」讓 5 條測試紅而非預期的 1 條 | 清理缺失的擴散面比文件寫的廣，已如實記錄 |
| Task 7 | 原測試參數（側邊欄 355 為奇數、ratio 0.5）讓「減法 vs 獨立四捨五入」兩種算法巧合一致，突變測不到。改用 400 才踩中 x.5 的四捨五入分界 | 斷言對、名字對，但挑的數值讓測試變盲 |
| Task 4B | 突變「id 查找退化成第一個 tool 記錄」在初稿下 23/23 全綠，因為測試把拒絕指向第一個建立的工具。改成指向第二個才命中 | 第五次「測試是盲的」，第二次由撰寫者自己在強制突變下抓到 |
| Task 4 | 突變「鍵改成只用 index」在第一版實作下 12 個測試全綠。原因是 block 存進各自 turn 的陣列，messageId 靠 turn 的分界間接生效。重構成全域 records 清單後突變才命中 | **實作的組織方式讓正確性變成巧合**。前三個是測試有洞，這個是結構有洞。撰寫者選擇改實作而非改測試 |

## 派工方式的結論

十次派工，五次因單次回應超過 16384 token 中止。調整指示兩次都無效，最後兩種修法有效：

1. **縮小 task 範圍**（Task 4 拆成核心與 4B），且拆點站得住腳：兩者本來就是不同的關注點
2. **控制端自己寫**（Task 5）

用 subagent 是手段不是目的。重複撞同一堵牆時換方法，不要再調同一個旋鈕。

## 回頭對齊（第三波同時進行）

已寫好的 task 在後續裁決前完成，與契約不一致處要回頭改。控制端逐一比對後的清單：

| Task | 不一致 | 對應裁決 | 處置 |
|---|---|---|---|
| 4 | `complete` 只由 block-stop 決定；history／user-text 永遠 false | 5、15 | 派 sonnet 修：session-end → 全部 complete；user-text 建立即 true |
| 4B | 拒絕理由塞 `result`；歷史缺 tool_result 停 running | 12、13、15 | 派 sonnet 修：加 `deniedReason`；session-end → running 變 done |
| 5 | `SessionState` 型別在 main | 14 | 控制端已改：搬到 `src/shared/session-state.ts` |
| 8 | 用 `session:open`／`openSession`；`SessionStateName` 字串；`SessionSummary` 4 欄；payload 無 title／displayName；無 `global.d.ts`；生命週期由 main 反推而非持有狀態機 | 6、7、11、14 | 派 opus 修，範圍最大 |
| 9 | import 已作廢 Task 7 的 `DEFAULT_SIDEBAR_WIDTH`；正文有「三欄兩可」的疑慮段落 | 9 | 派 sonnet 修：側邊欄寬度改 CSS 變數；刪疑慮段 |

裁決 14、15 於 09-02 16:35 寫入契約：`SessionState` 物件穿 IPC 並搬 shared、`YesChefApi` 定稿、
`session-end` 統一收尾（歷史載入補一筆）。裁決 15 把裁決 5 的四行與裁決 13 收成一條機制，
Event 型別不必加「來源」欄位。

## 控制端補記（第三波期間）

- Task 0 已由控制端撰寫（`task-0.md`）：拆 PTY、最小 `index.ts`、`bridge.ts` 空殼、佔位 `index.html`、移除 4 個相依。計畫中 Task 6B 全部改名 Task 0。
- recon-9 回報 DONE：`.app` 改 grid、`--sidebar-width: 280px`、移除 `main/layout.ts` import、15 處破折號清除。控制端接受 grid（裁決 9 原文即 CSS grid）。
- 控制端另在 task-9 修正兩處：(1) Task 0 已刪 `terminal.ts/.css` 與舊相依，task-9 對應的 Delete、`git rm`、相依 diff 說明改掉；(2) `vitest.config.ts` 的 `include` 只收 `.test.ts`，`.tsx` 測試在本 repo 實測「No test files found」，task-9 加 Modify `vitest.config.ts` 改 `{ts,tsx}`。此問題會連帶影響 9B/10/11 的驗證，三者回報時要核對。
- 裁決 16 寫入 CONTRACT：`ApprovalRegistry.request(ask: ApprovalAsk)` 收物件，`ApprovalRequest` 加 title／displayName。recon-6（sonnet）已派出。recon-8 原被告知「不動 Task 6」，回報後要用 SendMessage 補送裁決 16 與 index.ts 接線。

## 第四波（2026-09-02，回報處理後）

| 工作 | 模型 | 狀態 | 備註 |
|---|---|---|---|
| recon-9 | sonnet | 完成 | grid + `--sidebar-width`；控制端另補 vitest tsx include 與 Task 0 連動修正 |
| Task 10 撰寫 | opus | 完成（有疑慮） | 1428 行、54 測試、6 突變；App.tsx 與 9B 衝突 → 交給拆分/合併 agent |
| Task 11 撰寫 | opus | 完成（有疑慮） | 1115 行、47 測試、6 突變；拆成 7/11 → 交給拆分/合併 agent |
| Task 9B 撰寫 | opus | 完成（有疑慮） | 1309 行、32 測試、7 突變；錯誤卡片 → 裁決 17 |
| recon-6 | sonnet | 完成 | 裁決 16；12 測試、突變 4 條 |
| recon-4 | sonnet | 完成 | 裁決 5/15；15 測試 |
| recon-8 第一輪 | opus | 完成 | 2595 行；用了 pendingMeta 槽位 → 第二輪改裁決 16 |
| recon-8 第二輪 | opus | 完成 | 2835 行、120 測試、12 突變；`IpcBridgeDeps.webContents`（BaseWindow 下無 BrowserWindow）；Step 6b 完整 `index.ts`；Step 10 依裁決 18 縮成兩塊；控制端另依裁決 19 改 coverage 步驟 |
| recon-4B | sonnet | 完成 | 28 測試、5 突變；`applyToolsSessionEnd(applySessionEnd(records))` 疊加；控制端同步契約 `Block.tool.deniedReason`、清 10 處破折號與「邊界」 |
| recon-3+4（裁決 17） | sonnet | 完成 | events 38／fold 17 測試；`sessionEndError()`；控制端清破折號與用詞 |
| recon-9B（裁決 17） | sonnet | 完成 | 36 測試、8 突變（M8 起草時盲、改 `ended:true` 命中）；修正既有計數錯誤 19→21；控制端改 coverage diff 為裁決 19 形式 |
| 拆分 7/11 + App.tsx 合併 | opus | 完成 | task-7 506 行、task-10 1562 行、task-11 878 行；181 測試全綠；突變依檔案歸屬切 3/3；9B 的 listSessions 拋錯樁改由 Task 11 Step 3e 處理；已提交 b362f31 |

| Task 12 撰寫 | opus | 完成 | 352 行、39 項；找出三筆規格缺口 → 裁決 20（resume 帶原 cwd）、裁決 21（標題列）、A3 查證後不改；已提交 65e981a |

## 第五波（2026-09-02，裁決 20／21 寫進 task 檔）

| 工作 | 模型 | 狀態 | 備註 |
|---|---|---|---|
| task-7／task-8 修訂（裁決 20 全部、裁決 21 main 側） | opus | 完成 c1fea14 | worktree 驗 session-store 18、agent-host 48，兩個新突變各紅一條。提出契約矛盾：工廠單參數逼 `createWindow` 讀兩次 env；已採其建議改成 `requireProjectDir()` + `createSessionOptionsFactory(projectDir, sessions)`，CONTRACT 裁決 20 同步改 |
| task-9／9b／10／11 修訂（裁決 21 renderer 側） | sonnet | 完成 c1fea14 | task-9 沒有假 api 不動；9b／10／11 共 4 個假 api 都有 `projectDir`；Task 11 加 `title.ts`、`app-title-bar.test.tsx` 三條、突變 4（兩條紅）、手動第 4 項，文件層面推演未實跑（檔內已註明）。附帶指出 9b App.css diff 的減號行對不上 Task 9 原檔：已改成完整檔案 |

控制端另外做的：task-9 三處「骨架」改「版面」（標題連 TRACKING 一起改）；計畫檔案結構樹補齊 `App.css`／`title.ts`／`block-equals.ts`／`relative-time.ts`／各 CSS。

組裝、xref、掃描已於 815a594／4f74071 完成；codex 三份審查完成，發現處理見第六波。

## 第六波（2026-09-02，codex 三份審查的發現修進 task 檔）

codex（`codex exec -s read-only`，三份各約 18 分鐘）審查組裝後的計畫：p1 介面一致、p2 執行順序、p3 規格覆蓋。
控制端逐條查證後，確認的發現寫成裁決 22 到 28（CONTRACT.md），未被裁決的三項是純缺口補齊。範圍外的建議（右窗格 example.com、IPC payload 上限、Enter/IME、thinking 摺疊、y/n 快捷鍵、相對時間）記錄但不做。

| 發現 | 查證結果 | 處置 |
|---|---|---|
| Task 4B 的完整檔案少了 Task 4 後來加的 `sessionEndError`／`error`，測試也沒合併 | 確認 | Package A |
| Task 3 module 層級游標違反裁決 2；契約裁決 2 的草稿本身過時 | 確認 | 契約裁決 2 改寫；Package A |
| Task 3 對 signature_delta／message_delta／message_stop 產出 unknown，與裁決 1 相反 | 確認 | Package A |
| 矛盾 3：load-history 先推事件後推狀態，9B 靠狀態換場清空，歷史被清掉；另外三處清空判斷相反 | 確認 | 裁決 22（`reset` 事件）；Package B（推）＋ C（收） |
| 矛盾 4：兩個 action 的 effects 並行，連點 Recents 最終狀態可能是先點的那筆 | 確認 | 裁決 23；Package B |
| SDK 安裝在 Task 8，Task 7 先 import；Task 9 說「由 Task 3 加」；Task 9 改 package.json 沒跑 npm install | 確認 | 裁決 24；Package B（7/8）＋ D（9） |
| 規格 §3 的 main 事件存放區沒有任何 task 建 | 確認，判定規格改 | 裁決 25；控制端改規格 §3／§3.1／§3.2 加 §12 修訂紀錄 |
| 規格 §8 markdown 解析失敗退回純文字，Task 9 沒有錯誤處理 | 確認 | 裁決 26；Package D |
| 規格 §9 約 3000 字真實文件，Task 2 只有 466 字 | 確認 | 裁決 27；Package D |
| 規格 §9 canUseTool 四種結局，Task 8 bridge 只測了找不到 requestId 與壞 payload | 確認 | Package B 補 allow／deny 端對端測試 |
| 規格 §8 批准逾時「可見記錄」：renderer 卡片逾時後留在畫面上 | 確認，且查出裁決 11 的前提錯了（`CanUseTool` options 有 `toolUseID`，0.3.252 與 0.3.258 第 248 行） | 裁決 28；Package B（傳）＋ C（比對） |

| 工作 | 模型 | 狀態 | 備註 |
|---|---|---|---|
| Package A：task-3／4／4b（裁決 1、2、22；4B 重做完整檔案） | opus | 完成 | task-3 46 條（突變 7）、task-4 19 條／全套 124（突變 8）、task-4b 35 條／全套 140（突變 13），三階段 tsc 乾淨。`tests/helpers/live-events.ts` 不會被 `test.include` 當測試檔跑。A 的兩個判斷都接受：裁決 1 三種回空陣列的分支不動游標（`message_stop` 後 messageId 不清空，與原 default 一致）；裁決 1、22 的新行為各補突變。4B 的 `fold.ts` 是 524 行完整檔案，與 task-4 的 410 行大量重複，這是刻意的（避免貼片段時刪掉裁決 17），之後改 `fold.ts` 兩處要同步 |
| Package B：task-8／6／7（裁決 22 推 reset、23、24、28；allow／deny 測試） | opus | 完成 | task-6 13、task-7 19、task-8 三檔 98（agent-host 49、ipc 29、ipc-bridge 20），worktree 全套 164，tsc 0 error；突變 5＋4＋18 條全部實跑變紅。B 補的東西控制端都接受：task-8 突變 2（`mergeAccept` 串接反向）原本兩條指名測試都從 pending 為空出發抓不到，補了從 pending 非空再 accept 的第二段；`approvalReply` 原本一條測試都沒有，補齊 allow／deny／找不到 requestId／壞 payload 四條；`dispose()` 也接上 `pending` 鏈（裁決 23 同一理由）；task-8 Step 4 的 SDK 行號改成 0.3.258 實查值（title 233、displayName 238、toolUseID 248），刪掉「options 沒有 tool_use_id」那句作廢前提。使用者主動 deny 的 outcome 是 `{ decision: 'deny' }` 沒有 reason，canUseTool 補「使用者拒絕」當 message，不另開裁決 |
| Package C：task-9b／10（裁決 22 收 reset、28 id 比對；task-11 核對） | opus | 完成 | task-9b 43 條（conversation 23、use-conversation 20）、task-10 51 條（approvals 26、approval-card 14、use-approvals 11），全專案 139，tsc 0；突變 8＋7 條全部變紅。兩處偏離裁決字面，控制端接受並寫回 CONTRACT：截斷邏輯抽成匯出的純函式 `appendEvents`（`fold()` 也認 reset，hook 層測不到 M1）；`findAskForBlock` 多認 `awaiting-approval`（它讀的是標過的 view）。CONTRACT renderer 介面節補上 `findAskForBlock`／`unmatchedAsks`／`appendEvents` 簽章。task-11 不需改 |
| Package D：task-2／9（裁決 24、26、27） | sonnet | 完成 | task-2 13 個測試、task-9 11 個測試、全套件 72、tsc 與 `npm run build` 皆過。真實文件前綴測試踢出 `closeIncomplete` 的既有缺陷（儲存格裡的 `\|` 被當成列已收尾），D 加 `endsWithUnescapedPipe` 修掉，控制端核對後接受並補成第 4 條突變。task-9 的替代建置指令 `npx vite build --config electron.vite.config.ts` 實測失敗，改成一律 `npm run build` |
| 控制端：CONTRACT 裁決 22 到 28、規格 §3 修訂與 §12、task-12 加 E8 與 D1／D4／D6／E2／E3／E5／F2 的判準、契約行號引用全數改成裁決編號 | | 完成 | task-12 現在 40 項 |

控制端另外兩件事：Task 1 與 Task 2 原本只存在於組裝後的計畫檔，Package D 要改 task-2 時才發現沒有 `task-2.md`；已從 4f74071 的計畫抽成 `task-1.md`、`task-2.md`，`assemble.py` 改成從表頭檔（scratchpad `wave6/plan-header.md`）加 15 個 task 檔重建，不再需要還原計畫檔。教訓一則：控制端在 agent 編輯 task 檔期間誤跑 `git stash`，task-9 短暫回到 HEAD，靠 `git checkout stash@{0} -- <file>` 救回並通知 B／D 重讀；agent 編輯期間不做任何會改工作樹的 git 操作。

四個 package 全部核對完成。跨 package 核對：`{ kind: 'reset' }` 字面在 task-3（定義）、task-8（推）、task-9b（收）一致；`ApprovalAskPayload.toolUseId` 在 task-8 定義、task-6／10 使用，task-9b／11 不涉及；`liveEvents` helper 只在 task-3 用。

組裝完成：計畫 14201 行、15 個 task；`xref.py`（已讓它認得 `tests/` 路徑）問題數 0；破折號、TBD／TODO、0.3.252、禁用詞掃描皆 0。順手修掉 task-4b 兩段還在說「裁決 11 定案、payload 沒有 toolUseId」的舊文字（改成裁決 28）。

codex 第二輪對組裝後計畫（5374f5d）：p2 執行順序「共 0 條」（55 萬 token，第一輪的 4 條全部消失）；p1 介面一致「共 1 條」（中）：契約第 99 行寫「用 `uuid` 當 `messageId`」，Task 3 實作讀 `message.id`。控制端查 fixture 04：4 行 assistant、2 個 `message.id`、4 個 `uuid`，一則 API 訊息每個 block 各寫一行，用 `uuid` 會把回合拆開；Task 3 的既有測試已鎖定 `msg_...`，寫錯的是契約。修契約第 99 到 102 行、task-3 的 `normalizeHistory` 註解（原本寫 `message` 只有 `{role, content}`，只對 user 行成立），並在既有測試內補「4 個 messageId、2 個相異」兩句斷言（不增加測試條數，突變表數字不動）。重新組裝 14205 行，xref 0 問題，掃描乾淨。

第六波完成。待辦：交使用者選執行方式（建議 subagent-driven）。

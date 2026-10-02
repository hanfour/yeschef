# Plan B 撰寫追蹤

契約：`CONTRACT.md`（裁決 1 到 19）。撰寫者須知：`WRITER-GUIDE.md`。表頭：`plan-header.md`。
組裝目標：`docs/superpowers/plans/2026-09-03-yeschef-b-view-tools.md`。

## Task 表

| Task | 內容 | 模型 | 波 | 上游 | 狀態 | 備註 |
|---|---|---|---|---|---|---|
| 0 | zod 相依、`src/shared/view-tools.ts`、`policy.ts`、`errors.ts`、`types.ts`、`tests/helpers/manual-clock.ts`（agent-host.test.ts 改用） | sonnet | 1 | 無 | 完成 | 970 行、~37 測試（4 檔）、3 突變；`renderStaleReason` 為 errors.ts 私有 |
| 1 | `cdp.ts` 加 `onEvent`／`sessionId`／`attachCdp(wc, opts)`、`tests/helpers/fake-cdp.ts` | sonnet | 1 | 無 | 完成 | 1076 行、16 測試、4 突變 |
| 2 | `refs.ts` | sonnet | 1 | 0 | 完成 | 433 行、35 測試、3 突變；疑慮見裁決 20 |
| 3 | `keys.ts`、`urls.ts` | sonnet | 1 | 0 | 完成 | 498 行、51 測試、4 突變；lookupKey 回 null 照契約 |
| 4 | `snapshot.ts`、`tests/fixtures/ax/form.json`、`tests/fixtures/view/form.html` | opus | 1 | 0 | 完成 | 1116 行、39 測試、3 突變；疑慮見裁決 22 |
| 7 | `handoff.ts` | sonnet | 1 | 0 | 完成 | 642 行、24 測試、6 突變；`readToolUseId` 回 null 照契約；裁決 31 修訂完成（`EARLY_DONE_MAX`、earlyDone FIFO、`abortAll` 清空） |
| 8 | `settle.ts` | opus | 1 | 0、1 | 完成 | 1075 行、30 測試、10 突變；裁決 21／30 修訂完成（inflight 鍵含 session、detachedFromTarget 清理、navigatedWithinDocument 算載入） |
| 5 | `snapshot-collect.ts` | opus | 2 | 0、1、4 | 完成 | 1337 行、36 測試、8 突變；裁決 26／29 修訂完成（`parentId ?? parentFrameId`、`RawTargetInfo`、offset 失敗往外丟：`frame-detached`／`invalid-response`） |
| 6 | `watch.ts` | sonnet | 2 | 0、1、2 | 完成 | 680 行、24 測試、4 突變；主 frame 判定同裁決 21；域啟用三個照契約（裁決 24） |
| 11 | `ipc.ts`／preload `handoffDone`、`relative-time.ts` `formatElapsed` | sonnet | 2 | 0 | 完成 | 404 行、13 新測試、5 突變；裁決 23 已補三個 Plan A 測試檔（tsc 0、vitest 500 綠） |
| 12 | `HandoffCard.tsx/.css`、`Turn.tsx`／`Conversation.tsx` `renderToolOverride`、`App.tsx` | opus | 2 | 0、11 | 完成 | 1192 行、25 新測試、7 突變；裁決 25；Plan A 測試檔補樁歸 Task 11 |
| 13 | `session-args.ts`／`session-options.ts` `mcpServers`、`agent-host.ts` `autoAllow`、`ipc-bridge.ts` `viewTools` | opus | 2 | 0、7 | 完成 | 649 行、65 測試、4 突變；IPC 鍵改 `IPC.handoffDone`（裁決 23，已 sed） |
| 9 | `controller.ts` | opus | 3 | 0 到 8 | 完成 | 1601 行、54 測試、8 突變；依 400 行上限拆成 controller-types／-core／-page／-input／-eval 六檔；裁決 22／28／29 修訂完成（evaluate 用 `unserializableValue ?? JSON.stringify`、click 端 offset 失敗不吞） |
| 10 | `server.ts` | opus | 3 | 0、7、9 | 完成 | 790 行、28 測試、8 突變；server.ts 覆蓋 100；裁決 27／32／33 已納入；測試路徑照契約 §14 `tests/view-tools/server.test.ts` |
| 14 | `index.ts` 接線、`spikes/capture-ax.ts`（`spike:ax`）、`form.real.json`、`RESULTS-05`、規格 §11 修訂、vitest 註解 | opus | 3 | 全部 | 完成 | 982 行、9 新測試（startup.ts）、5 突變；spike:ax 實跑成功（34 節點，兩份 fixture 過同組 45 測試）；規格 §11 列 22 條；裁決 35／36／37 |

## 波次

- 第一波：0、1、2、3、4、7、8（Task 2、3、4、7、8 依契約簽章自行 stub Task 0 的型別）
- 第二波：5、6、11、12、13
- 第三波：9、10、14

## 紀錄

（每波派出時間、回報摘要、契約疑慮與裁決）

- 2026-09-03 第一波派出：Task 0、1、2、3、7（sonnet）、4、8（opus）。契約已先修裁決 6／7（RESULTS-03：root getFrameTree 不含 OOPIF，父 session 由 Target.getTargets 的 parentId 決定）。
- 同日提前派出 Task 6、11（sonnet）、13（opus）：上游只有契約已定的簽章，不必等第一波。Task 5、12 等 Task 4、11 完成再派。
- 契約補：§9.4 加 `readToolUseId(extra): string | null` 匯出（原本只在裁決 8 提到，沒有歸屬檔案）；裁決 9 括號內改為 `Target.getTargets` 找父 target。
- 裁決 20（Task 2 疑慮）：ref 的 snapshotId 大於表的 snapshotId 時維持 `stale／newer-snapshot`，不新增 reason。理由：這只會在模型編造編號時發生，訊息「請先呼叫 view_snapshot」給的下一步已正確；多一種 reason 是為不存在的使用者情境加分支。
- 第一波回報（同日）：Task 0、1、4、7、8、13 完成；Task 11 完成但 `YesChefApi.handoffDone` 必填讓三個 Plan A 測試檔 tsc 出錯，退回補做（裁決 23）。Task 6 仍在寫。
- 裁決 21（Task 8 疑慮）：主 frame 判定統一為 `frame.parentId` 與 `sessionId` 都是 undefined（OOPIF session 自己的頂層 frame 也沒有 parentId）；settle 與 watch 同一定義；`SettleTracker.dispose()` 讓還在等的 waitFor* 以 `'aborted'` 結束；匯出 `SettleWaitOptions`。契約 §9.2／§9.3 已改。
- 裁決 22（Task 4 疑慮）：`formatSnapshotText(snapshot, intervention?: string | null)`，controller 直接傳 `summarizeIntervention` 結果（原本 `?? undefined` 是多餘轉換）；ref 的 `n` 從 0 起（派工提示寫錯，契約為準）；空 frame 仍印標頭；nodeId 重複／成環只印一次。契約 §6、§10.2 已改。
- 裁決 23（Task 13 疑慮）：IPC 鍵沿用既有 camelCase，`IPC.handoffDone`；契約 §11.3 與 task-11／task-13 已改。`YesChefApi.handoffDone` 維持必填，三個 Plan A 測試檔的假 api 由 Task 11 一併補。
- 教訓：派工提示不要重述契約值（Task 3 lookupKey、Task 4 ref 起始、Task 7 readToolUseId 三處寫錯，撰寫者都照契約做對）。之後的提示只給檔案路徑與章節號。
- Task 11 修訂完成：三個 Plan A 測試檔補樁（`use-conversation` 沿用該檔「未用成員丟錯」慣例，不是 `vi.fn()`），tsc 0 error、vitest 500 全綠，拆成 `feat` 與 `test:` 兩個 commit。
- Task 6 完成（DONE_WITH_CONCERNS）：主 frame 雙條件與裁決 21 一致。裁決 24：view-tools 只啟用 `DOM`／`Network`／`Accessibility` 三個域（root 與每個 iframe session）；`Page`／`Runtime` 由 cdp.ts 在 root 啟用即可，OOPIF session 不需要 `Page.enable`，因為 settle／watch 只用 root 主 frame 的 `frameNavigated`／`loadEventFired`，`Page.getFrameTree` 不需 enable。派工提示寫成五個是我的錯，契約為準。
- 第三波提前：Task 9、10 在 Task 5 完成前派出，上游缺的照契約簽章 stub（契約已定稿，型別一致性由 Task 14 接線與組裝後自審再驗一次）。Task 14 等全部到齊。
- Task 12 回報（DONE_WITH_CONCERNS）：裁決 25 = HandoffCard modifier 對應（streaming-input／進行中 → `--pending`、historical 進行中 → `--stale`、done → `--done`、error／denied → `--error`）、文字歸屬、標題私有常數、ref 旗標防連按；契約 §12 已補。其 Step 11 重複補三個 Plan A 測試檔（Task 11 已納入），退回刪除。
- Task 5 完成（DONE_WITH_CONCERNS）：裁決 26 = 父 target 讀 `parentId ?? parentFrameId`（探針 `spikes/probe-oopif.ts:125` 就是這樣讀，RESULTS-03 沒分開記哪個欄位有值；Task 14 實機必須記錄）；`resolveFrameOffset` 加選填 `cache`；root getFrameTree／getLayoutMetrics 失敗往外丟；上限順序用 `nodes` 陣列順序。契約 §9.1 已補。
- Task 10 完成（DONE）：裁決 27 = server 端補選填預設（`scope ?? 'viewport'`、`clear ?? false`、`submit ?? false`）、`dispose()` 四步順序；測試檔路徑照契約 §14（派工提示又寫錯路徑，契約為準）。controller stub 與 task-9.md 的 Produces 比對一致。
- Task 5 裁決 26 修訂完成：1271 行、35 測試、7 突變；`tests/cdp.test.ts` 3 紅是 worktree 未放 Task 1 測試檔，非缺陷。
- Task 9 完成（DONE_WITH_CONCERNS）：1551 行、51 測試、6 突變；controller 依 400 行上限拆六檔（contract §1 已註）。四條疑慮全數採納為裁決 28：工具入口先查 `signal.aborted` 丟 `sessionEnded`、`waitForQuiet`／`waitForLoad` 回 `'aborted'` 一律丟 `sessionEnded`、navigate 用正規化後的 url、type 的 Backspace 走 §8 `dispatchKey`。另發現 task-4.md 簽章與裁決 22 不一致（`intervention?: string`），已直接改 task-4.md 為 `string | null`。
- codex 契約審查（`b-contract-codex-review.md`，27 條，審的是裁決 21 前的快照）：採納為裁決 29 到 34；不採納 #4（極少見競態）、#8／#14（使用者自己的 settings 與 CLI 預設）、#15（不支援 CSS transform）、#16（假設 zoom 為 1）、#19（Plan A 範圍）、#24（記進 RESULTS-05）；已處理 #1、#2、#3、#6、#12、#13、#20、#22、#27。
- 裁決 29：`resolveFrameOffset` 任一步失敗往外丟（找不到 session／target → `CdpError` `'frame-detached'`），不再靜默回 `{0,0}`；`collectSnapshotInput` 自己 catch 補 `{0,0}` 並 `logError`，click 路徑不 catch 讓錯誤變成 `cdpFailed`。理由：在使用者真實 session 裡點錯元素比失敗更糟。
- 裁決 30：settle inflight 鍵改 `${sessionId ?? 'root'}:${requestId}`；`Target.detachedFromTarget` 清掉該 session 的 inflight；`waitForLoad` 也接受 `Page.navigatedWithinDocument`（都限 root session）。
- 裁決 31：handoff registry 加 `EARLY_DONE_MAX = 8` 的 earlyDone FIFO；`done()` 沒有 pending 就先記著，之後同 id 的 `begin()` 立即回 done；`abortAll()` 一併清空。理由：按鈕按一次就停用（裁決 25），早到的 done 會讓 agent 白等 10 分鐘。
- 裁決 32：`createSdkMcpServer` 帶 `timeout: HANDOFF_TIMEOUT_MS + 60_000`，不讓 `MCP_TOOL_TIMEOUT` 環境變數截斷 handoff（RESULTS-05 加驗 `MCP_TOOL_TIMEOUT=5000` 仍能等超過 5 秒）。
- 裁決 33：不加序列化鎖、工具不設 `annotations`；Claude Code 對沒有 `readOnlyHint` 的 MCP 工具本來就依序執行，RESULTS-05 實機驗同訊息 `view_navigate` 加 `view_snapshot` 拿到新頁。
- 裁決 34：§13 接線失敗路徑（`attachCdp` 失敗不掛 cdp；`createViewToolServer` 失敗先 `cdp.detach()`；兩者都退回 Plan A 的 `createSessionOptionsFactory` 三參數與 `createIpcBridge` 不帶 viewTools），抽成可單元測試的函式由 Task 14 命名；`package.json` SDK 釘死 `0.3.258`；§14 跨站 fixture 改 `localhost` 主頁加 `127.0.0.1` iframe（同 host 不同 port 是 same-site，不會產生 OOPIF）。
- 修訂派出：Task 5（裁決 29）、Task 9（裁決 22／28／29）、Task 10（裁決 27／32／33，已完成 790 行、28 測試、8 突變）續用原撰寫者；Task 7（裁決 31）、Task 8（裁決 30）續用原撰寫者。Task 14 等五份修訂到齊再派。
- Task 9 修訂完成：1601 行、54 測試、8 突變；wt-9 的 snapshot.ts／snapshot-collect.ts 已同步裁決 22／29；tsc 0 error。
- Task 5 裁決 29 修訂完成：1337 行、36 測試、8 突變；`resolveFrameOffset` 內不再 logError，`collectSnapshotInput` 用 `frameOffset()` 自己 catch（同 session 只記一次）；覆蓋 Stmts 96.89。
- Task 8 裁決 30 修訂完成：1075 行、30 測試、10 突變；wt-8 重建後已移除。撰寫者註明 `Page.navigatedWithinDocument` 不比對 frameId，root session 內同行程子 frame 的 hash 導航也會讓 `waitForLoad` 提前結束；接受這個代價，因為 navigate 之後還有 `waitForQuiet` 接住，且加 frameId 比對要多追主 frame id 的狀態。
- Task 7 裁決 31 修訂完成：642 行、24 測試、6 突變；`done()` 對不上 pending 改記 earlyDone、不再 logError（deps 的 `logError` 依契約保留）；wt-7 重建後已移除。
- 五份修訂到齊，Task 14（opus）派出。
- Task 14 完成（DONE_WITH_CONCERNS）：982 行、25 個 Step、9 新測試、5 突變；`npm run spike:ax` 在 Electron 44 實跑成功（順帶證實 `checked` 的實機形狀是 tristate 字串，task-4.md 的「推論」已改成確認）。四條疑慮裁決：35 = index.ts 無工具路徑無條件傳 `undefined`（契約 §13 已改）；36 = `form.html` label 與 input 之間的空白在 task-4.md 源頭拿掉，task-14 的 Step C1 改成只確認不修改（不跨 task 改檔）；37 = 實機驗收 25 項為判準表，裁決 32／33／34 與規格 §10 的量測項列補充記錄不計判準；裁決 26 的 `parentId`／`parentFrameId` 留給 RESULTS-05 跨站實測記錄，不需動作。
- 15 個 task 檔全部完成，wt-5／9／10／12 已移除，wt-14 待組裝後移除。下一步：組裝、自審、`docs:` 提交。

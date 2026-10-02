# 四條已知缺陷的修正與實機驗收

量測日期:2026-09-08
機器:macOS 26.6.2(Darwin 25.6.0)、arm64
Node 24.18.0 / Electron 44.0.0 / Agent SDK 0.3.258
分支:`fix/known-defects`,起點 5787041

四條缺陷來自子專案 D 併入後的檢視:兩條由 codex(gpt-6-astra)獨立讀 repo 時指出,
兩條在 RESULTS-08 已記為待處理。每條都先寫失敗測試再實作。

量測方法:`npm run build` 之後
`YESCHEF_PROJECT_DIR=/tmp/yeschef-acc-4/proj npx electron . --remote-debugging-port=9333 --user-data-dir=/tmp/yeschef-acc-4/userData`,
左窗格用 CDP `Runtime.evaluate` 操作 DOM,工具回傳從 SDK session jsonl 逐字讀,
主程序 log 導到 `main.log`。全程沒有動到真正的 userData:
驗完 `~/Library/Application Support/yeschef/` 底下依然沒有 `yeschef-projects.json`。

fixture 專案 `/tmp/yeschef-acc-4/proj` 內含 `CLAUDE.md`(寫一個只有讀過才知道的代號
`ZANTHER-7719`)、`MARKER`、`probe-delete.txt`,以及一個 `index.html`,
按鈕會呼叫 `window.open('file:///etc/hosts')`。

## 四條缺陷

| # | 缺陷 | 位置 | 修法 |
|---|---|---|---|
| 1 | `window.open` 直接 `loadURL`,不經過協定白名單與專案範圍限制 | `src/main/agent-view.ts:26` | 判斷抽成 `view-tools/window-open.ts` 的 `decideWindowOpen`,與 `view_navigate` 共用 `checkNavigateUrl` |
| 2 | 「本專案」Recents 是全域最新 100 筆的子集合 | `src/main/session-store.ts:53`、`src/main/ipc-bridge.ts:331` | 改用 SDK `listSessions` 的 `dir` 選項,由 SDK 篩選該專案的 session 並限制回傳筆數 |
| 3 | `recordSession` 只跟鏈上最後一筆去重 | `src/main/projects-state.ts` | 比對整條鏈,命中時原樣回傳同一個物件 |
| 4 | 使用者層設定被載入,app 不是權限決定的唯一來源 | `src/main/session-args.ts:73` | `settingSources: ['project', 'local']` |

第 1 條可以串成一條路徑:agent 用 `view_navigate` 開專案內自己寫的 HTML,
該頁 `window.open` 專案外的檔案,右窗格載入之後 `view_snapshot` 就讀得到。

RESULTS-08 第 12 項已經量到第 2 條的現象(「本專案」2 筆、「全部」100 筆),
當時沒有判定為缺陷。

## 結果表

| # | 項目 | 結果 | 佐證 |
|---|---|---|---|
| 1 | `cat MARKER` | 沒有批准卡,直接執行 | 對話顯示 `Bash 完成 → marker-alpha`;等 90 秒沒有出現 `.approval-card` |
| 2 | `echo $ECC_GATEGUARD` | 出批准卡 | 卡片參數逐字為 `echo GATE=[$ECC_GATEGUARD] CODE=[$ZANTHER_PROBE]`;按「允許 Bash」後 jsonl 的 `tool_result` 是 `GATE=[off] CODE=[]` |
| 3 | `rm probe-delete.txt` | 出批准卡,送出到卡片 2020 ms | 按允許後 `probe-delete.txt` 真的被刪掉 |
| 4 | 使用者層設定不再載入 | 通過 | yeschef 的 session `770ea95f` 跑了三次 Bash,`~/.helm/live` 底下沒有它的紀錄;同時段另一個一般 Claude Code session(cwd 在 `example/demo-app`)有紀錄。那個 PreToolUse hook 定義在 `~/.claude/settings.json` |
| 5 | CLAUDE.md 仍然載入 | 通過 | 問「這個專案的內部代號是什麼,不要用任何工具」,直接答 `ZANTHER-7719` |
| 6 | `window.open` 到專案外的檔案 | 擋下 | 右窗格 url 點擊前後都是 `file:///private/tmp/yeschef-acc-4/proj/index.html`;`main.log` 有 `[yeschef] Error: 右窗格 window-open 已擋下 file:///etc/hosts:只允許開啟 /private/tmp/yeschef-acc-4/proj 底下的本地檔案` |
| 7 | Recents 兩種範圍 | 通過 | 「本專案」1 筆(`執行 cat MARKER`)、「全部」100 筆 |

單元測試:57 個測試檔、1167 個測試全綠,`tsc --noEmit` 0 error。
覆蓋率 Stmts 93.81、Branch 89.38、Funcs 93.78、Lines 95.55(門檻 93 / 86)。

## 追加:批准卡切走再切回拿不回(RESULTS-08 記的窄窗口)

量測日期:2026-09-08(同日稍晚)

RESULTS-08 記過:前景時已送到 renderer 的批准,切走再切回拿不回卡片,只能等 30 秒逾時。
原因是 renderer 在 `activeId` 換人時把 pending 整批清空,而 `replay()` 只重送事件與狀態,
不重送 registry 裡還開著的請求。

修法不是在切換時多做什麼,是把「清空」這個特殊情況拿掉:renderer 的 pending 改成主行程
registry 的鏡像。`agent:approval:ask` 帶 `projectId`;新增 `agent:approval:settled`,
registry 的 `settle()`(回覆、逾時、denyAll、送不出去四種了結都經過它)通知一次;
renderer 收著所有專案的請求,只顯示 `activeId` 那個專案的。切專案只是換過濾條件。

RESULTS-08 I1 那個時序問題(`projects:state` 與新專案的 ask 同一批到達,清空搶跑)在鏡像
設計下不存在:兩則各自更新自己的狀態,沒有清空動作可以搶跑。

| # | 項目 | 結果 | 佐證 |
|---|---|---|---|
| 1 | 專案 a 前景送 `rm probe.txt`,出批准卡 | 3,525 ms | DOM `.approval-card` 1 張 |
| 2 | 切到專案 b | 卡數 0 | 別的專案的卡藏起來 |
| 3 | 切回專案 a,距出卡 4,027 ms | 卡數 1 | 卡片還在,沒有等逾時 |
| 4 | 按「允許 Bash」 | `probe.txt` 真的被刪掉 | 切回來的卡還能用,不是殘影 |
| 5 | 主程序 log | 0 個 Error | `ap-main.log` |

單元測試:`useApprovals` 改寫為過濾模型,`approval.ts` 的 `onSettled` 四種了結各一測,
`ipc-bridge` 驗 payload 帶 `projectId` 與 settled 走 best-effort。全套 58 檔 1201 個測試綠。

## 更正 RESULTS-08 對「讀取類工具免批准」的歸因

RESULTS-08 把這個行為歸因於使用者層的 `permissions.defaultMode: "auto"`
蓋過 `buildSessionOptions` 明寫的 `permissionMode: 'default'`。本次驗收顯示,
使用者層設定不載入時仍然會發生。

結果表第 4 項確認使用者層設定未載入;同一次啟動中,第 1 項的 `cat MARKER`
仍然直接執行,沒有出現批准卡。
`cat` 不被問是 `permissionMode: 'default'` 自己的行為:SDK 型別檔對 `'default'`
的說明是 `Standard behavior, prompts for dangerous operations`,`cat` 不在其中。
當時的觀察(「`cat` 沒被問」)在 `'default'` 與 `'auto'` 之下都成立,分辨不出誰在生效。

因此第 4 條的修正作用與原本的說法不同:它停止載入使用者層的 hook 與
`permissions.allow` 清單,那些設定不再影響 yeschef 的權限判斷。
它不會讓讀取類工具在執行前要求批准。若要所有工具都先取得批准,
要走 `dontAsk` 或自己的 PreToolUse hook,與 `settingSources` 無關。

## SDK 的查詢耗時與權限處理流程

本機 962 場 session,三種 `listSessions` 呼叫方式:

| 呼叫 | 筆數 | 耗時 |
|---|---|---|
| `listSessions()` | 962 | 1188 ms |
| `listSessions({ limit: 100 })` | 100 | 162 ms |
| `listSessions({ dir: '/private/tmp/yeschef-d-a', limit: 100 })` | 2 | 32 ms |

`dir` 由 SDK 端過濾,而且依 `ListSessionsOptions` 的說明會一併涵蓋該目錄的
git worktree。先前 RESULTS-08 記的 536 到 736 ms 是 940 場 session 時的數字。

`canUseTool` 只處理需要問使用者的權限請求,不是通用閘門。`sdk.d.ts` 對
`SDKPermissionDeniedMessage` 的說明寫明:有 permission prompt surface 時,
`'ask'` 才會變成 `can_use_tool` control request。SDK 在更前面的權限檢查就決定
允許或拒絕時,不會呼叫 `canUseTool`,所以 app 端攔不到設定已經放行的工具。

## 對規劃的影響

- 驗收腳本用 CDP 找 renderer 時,比對條件要用 `out/renderer/index.html`。
  只比對 `index.html` 會在右窗格開著同名檔案時抓錯 target,拿到空的 `#root`。
- 環境變數不能當作「使用者層設定有沒有載入」的判準。從已經有那些變數的 shell
  啟動 Electron 時,子程序會直接繼承,`GATE=[off]` 分辨不出來源。
  可靠的判準是 hook 有沒有跑。
- 第 3 條(`recordSession` 去重)沒有在本次實機驗到,同一條 thread 上換 session
  要等 E 才會發生。單元測試涵蓋 `s1 → s2 → s1` 與物件同一性。
- 子專案 E 若要保證每個工具都問,`settingSources` 不是答案,見上面的更正。

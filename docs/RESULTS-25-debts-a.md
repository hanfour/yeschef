# RESULTS-25:小債務一波(批次 A)實機驗收

- 日期:2026-09-12
- 分支:`debts-a`,七個實作 commit(codex gpt-6-astra 實作,sonnet 逐 Task 審查,opus 整支審查)
- 計畫:`docs/superpowers/plans/2026-09-12-debts-a.md`
- 清的是 RESULTS-14、15、18、21 記錄的四條已知缺陷

## 1. 自動測試

typecheck 0 error;87 檔、1772 測試全過;Stmts 94.2%、Branch 89.78%;build 成功。

## 2. 實機驗收

| # | 缺陷 | 做什麼 | 實際 |
|---|---|---|---|
| 1 | MCP 工具結果多畫「未知事件」 | `ask_peer` 跑完展開看 | 0 個未知事件 ✓ |
| 2 | 歷史檢視看不到花費 | 對話結束後正常關 app 重開,從 Recents 開那條 | 狀態列與底部都是 `2 輪 · US$0.0275`;另一條 `US$0.0439`;狀態檔的 `SessionLink.cost` 有值 ✓ |
| 3 | 沒切到前景的對話不在同伴清單 | 冷啟動只切 c1,`ask_peer` to=c2 的 linkId | c2 被叫起來(busy 短暫出現 `c1,c2`),回答送回 c1 ✓ |
| 4 | 預覽被上限擋下沒有重試 | 單元測試(RESULTS-21 §10 之後 renderer 已排隊,實機碰不到上限) | 有「重試」按鈕,按了重讀 ✓(單元) |

## 3. 審查抓到、驗收沒抓到的

**回合結束時同步注入的同伴提問會被 sleep 打斷。** `turnEnded` 第一行 `setBusy(false)` 同步觸發 `notifyIdle`
→ 排隊中的提問立刻投遞 → 新回合開始、`deactivate` 設 `sleepPending` → 控制權回到 `turnEnded` 就 sleep,
剛開始的回合被 teardown,提問方等到逾時。這條在第 3 項之前打不到(沒切到前景的對話根本不在 registry),
第 3 項加上「背景核心要會睡」之後變成排隊路徑的必然。驗收沒抓到是因為驗收走的是非排隊的直送路徑。
修法兩個核心各一行:`setBusy(false)` 之後 `if (!sleepPending || busy) return`,新回合自己的結尾再睡。
codex 先寫了四條會失敗的測試重現那條鏈才改。

其他審查中修掉的:`deliver` 拿不到 core 從靜默改成 throw(不然 `inject` 不會 `cancelQuestion`,提問方等到逾時);
`recordSessionCost` 後蓋前的測試;`sessionCostOf` 刻意跨專案掃描的註解;renderer 的讀取排隊改成全域一份並給測試重設;
`ProjectImage` 與 `PreviewPane` 的讀取抽成 `usePreviewRead`。

## 4. 沒做的

- 降速跟 agent 動作掛勾(原本的第 5 條):執行中切換 `setBackgroundThrottling` 會不會把 `visibilityState` 拉回
  `visible` 沒量過,要另外 spike。
- `App` 上只給測試用的 `slot` prop 不動:三條測試靠它。
- 花費寫入在值沒變時短路、`syncPeers` 用 Set、多個「重試」按鈕加 `aria-label`:審查建議,量級都不構成問題。

# RESULTS-18:狀態列實機驗收

- 日期:2026-09-11
- 分支:`status-bar`,三個 commit:`e7b2027`、`3223ac4`、`4806f3c`
- 規格:`docs/specs/2026-09-11-shell-regions-design.md` 增量 1
- 計畫:`docs/superpowers/plans/2026-09-11-status-bar.md`

## 1. 自動測試

| 項目 | 結果 |
|---|---|
| `npm run typecheck` | 0 error |
| `npx vitest run` | 76 檔、1623 測試全過 |
| `npm run build` | 成功 |

## 2. 實機驗收

用 `npx electron . --remote-debugging-port=9336 --user-data-dir=<fixture>` 開真的 app,
專案 `sb` 底下兩個 Claude 對話 `c1`、`c2`,透過 CDP 讀狀態列文字。

| # | 做什麼 | 應該看到 | 實際 |
|---|---|---|---|
| 0 | 沒有任何事情在跑 | 狀態列在,沒有內容也沒有佔位符號 | `""`,`.status-bar` 節點存在 ✓ |
| 1 | c1 跑一個要批准的 Bash、c2 跑一輪 | 同時顯示進行中與待批准 | `1 個進行中1 個待批准1 輪 · US$0.0441` ✓ |
| 2 | 點狀態列的「待批准」 | 切到那個對話,批准卡在畫面上 | `activeTabId` 變 `c1`,`.approval-card` 存在,內容是那個 Bash ✓ |
| 3 | 允許後等對話結束 | 花費出現在狀態列,不必捲到對話底部 | `2 輪 · US$0.1781` ✓ |
| 4 | 切到一個還沒跑過的新對話 | 不再顯示上一個的數字 | `""` ✓ |

## 3. 驗收時發現並修掉的問題

Task 2 的審查指出:前景可以是終端機分頁,那時沒有任何對話 pane 會回報花費,
狀態列會留著上一個對話的數字。實機重現成立:c1 結束顯示 `1 輪 · US$0.1656`,
切到終端機分頁後仍是 `1 輪 · US$0.1656`,但畫面上的前景已經是終端機。

修法在 `4806f3c`:`App.tsx` 自己看前景分頁的 `contentType`,不是 `conversation` 就不顯示花費,
不依賴對話 pane 主動回報。修完重測:切到終端機分頁得到 `""`,切回 c1 得到 `1 輪 · US$0.0175`。

## 4. 已知但不在這次範圍

對話切走再切回時,主行程走的是歷史重建那條路(`conversation.ts` 的 `open-history`),
歷史補的 `session-end` 沒有 `costUsd`/`numTurns`,所以花費不會回來。
這是既有行為,`fold.ts:235-240` 的註解已經寫明,畫面底部同樣沒有花費那一列,兩邊一致。
要讓花費在歷史檢視也在,得讓主行程把結束時的花費一起存進 transcript,那是另一個子專案。

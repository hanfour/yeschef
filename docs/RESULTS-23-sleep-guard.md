# RESULTS-23:按需擋主機睡眠 實機驗收

- 日期:2026-09-12
- 分支:`sleep-guard`,commit `8376682`(codex gpt-6-astra 實作,sonnet 審查兩項通過)
- 規格:`docs/specs/2026-09-07-yeschef-roadmap.md` §2.2 與 §4 第 4 項後半
- 計畫:`docs/superpowers/plans/2026-09-12-sleep-guard.md`

## 1. 自動測試

typecheck 0 error;88 檔、1748 測試全過;Stmts 94.08%、Branch 89.62%;build 成功。

## 2. 實機驗收

用 `pmset -g assertions` 讀系統的 power assertion,用主行程 log 讀 guard 的兩句話。

| # | 做什麼 | 應該看到 | 實際 |
|---|---|---|---|
| 1 | 開起來沒有對話在跑 | 沒有 Electron 的 assertion,log 沒有「擋睡眠」 | assertion 清單裡只有別的程式的 `caffeinate`;log 0 次 ✓ |
| 2 | 對話 A 跑 40 秒的 Bash | 「擋睡眠」一次;assertion 出現 | `pid 44755(Electron): NoIdleSleepAssertion named: "Electron"`;log 1 次 ✓ |
| 3 | 期間對話 B 也跑一輪 | 沒有第二次「擋睡眠」 | 仍 1 次,「放行」0 次 ✓ |
| 4 | 兩個都結束 | 「放行睡眠」一次;assertion 消失 | log 各 1 次;`pmset` 裡 Electron 0 筆 ✓ |

第 4 項第一輪沒過,原因在驗收腳本:A 的批准卡在 c1 的 pane 裡,我切到 c2 之後腳本只點看得見的卡,
A 一直在等批准所以一直忙。切回 c1 允許之後,9 次輪詢內兩個都閒置,「放行」出現。不是程式問題。

## 3. 範圍

第一版只用「任何對話在忙」當訊號。roadmap 寫的另一個訊號「手機已連線」等手機 SSH 實測(要使用者開 Remote Login)
之後再加;那時可以用 `tmux list-clients` 看有沒有 yeschef 以外的 client 接著。

`prevent-app-suspension` 擋的是閒置睡眠,不擋闔蓋與選單的強制睡眠,這是規格 §2.2 就寫明的界線。

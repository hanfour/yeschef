# Codex 批准與歷史恢復相容修正

日期：2026-09-17。由 demo-app 工作台實測發現，CLI 版本 `0.154.0`。

## 觸發與修正

1. `untrusted` 政策下，批准普通命令仍會留在 workspace-write 網路沙箱；連本機 MySQL 3308 回 `EPERM`，提出 `require_escalated` 又因 UnlessTrusted 被拒絕。改為在 thread/start 與 thread/resume 指定 `on-request`，保留 workspace-write；需要超出沙箱的操作仍透過既有批准卡逐次同意，不開啟全域網路或 full access。
2. 重啟後恢復原主廚對話，CLI 回 `unknown variant thread/items/list`，導致歷史載入失敗。僅在舊介面明確不受支援時，改讀 `thread/turns/list`，指定升冪及 `itemsView: full`，維持分頁/重複游標檢查與 4000 筆內容上限。不把登入或一般讀取錯誤當作版本差異。

依據：本機 `codex app-server generate-json-schema --experimental` 產生的 ThreadTurnsListParams/Response、實際錯誤與 [Codex 安全設定說明](https://developers.openai.com/codex/security/)。手冊仍描述部分舊 items/list 能力；本機 CLI 實際不提供該 method，因此保留新舊版本相容而非假設所有版本一致。

## 驗證

- 型別檢查通過。
- YesChef 全套 101 檔、2192 個測試通過；新增完整 turn 分頁、認證錯誤不 fallback、summary/notLoaded 拒絕、重複 cursor 與 4000 筆上限案例。
- 實機同一個 Codex thread `01a0ae05-73c8-7102-80a6-859ff7fe0826` 已恢復歷史，無需另開對話。
- 原主廚接續提出隔離庫測試的提升權限請求，YesChef 正常顯示含 reason 的批准卡；批准後回到工具執行並繼續測試品質與 RED 判讀。

修正範圍是工作台的執行/恢復路徑。demo-app 的功能實作、測試及同伴審查仍由 YesChef 內部對話執行；不以外部代跑代替工作台驗收。

## 後續管理工作區迭代的壓縮服務中斷

同日接續管理後台迭代時，原 Codex 對話在 remote compact 呼叫收到上游 `502 Bad Gateway`。原對話直接重試一次後仍失敗；這是本次觀察到的壓縮服務錯誤，不能據此判定為 YesChef 的歷史載入相容問題。

處置是在相同 demo-app 專案透過工作台「新 codex 對話」建立接班分頁，保留原對話、既有 Claude 審查同伴與未提交程式修改。接班對話 ID 為 `dda57866-dc9b-43e2-8a50-b03eb5ac48ae`、工作台 thread ID 為 `c709e3c7-061c-429e-a34b-29f0eb3f8f9b`。由左窗格輸入交接說明，要求先核對 diff/status，再繼續回歸、同伴審查與右窗格驗收。沒有更動全域服務設定或以外部 agent 代寫 demo-app。

這是人工明確交接的恢復流程，不代表已實作自動壓縮容錯。後續可改善錯誤後的接班入口與上下文摘要，但不能將未完成的測試／驗收隨交接視為通過。

# Diff repo 選單依本次對話的成功寫檔紀錄篩選

2026-09-21。修正使用者指出的問題：Workspace 的 repo 選單原本列出全部 29 個子專案，無法代表目前這一筆對話實際修改的專案。

## 行為

選單只列出目前 session 及其可驗證子 agent 紀錄中，成功完成寫檔／patch 的路徑所屬 repo。Read、搜尋、assistant 的文字描述、僅提出的工具請求、批准、失敗／被拒絕的操作，以及其他對話造成的 dirty 檔案都不構成修改證據。

支援 Claude Write／Edit／MultiEdit／NotebookEdit、獨立 apply_patch，以及 Codex completed fileChange。對應 tool-use 與成功 tool-result 才採用路徑；不同 session／子 agent 的 tool ID 不會交叉配對，Edit 的明確 no-op 不計入。

一般 shell、外部 CLI 或腳本沒有結構化寫檔事件時不猜測。這會保守漏列無法驗證的工作，但不會拿目錄現有 dirty 檔案或命令中的 repo 名稱冒充本次修改。介面已明示此範圍。

沒有證據的新對話顯示空狀態，不退回全部 repo。後端讀取 diff 同樣檢查歸屬，不能靠手動送 repo ID 繞過選單篩選。選定 repo 後，檔案差異仍依使用者選擇的 Git 比較範圍顯示；此變更沒有把 repo 中所有未提交檔案都歸因於這筆對話。

## 歷史與持久化

- 使用目前 core 的 session ID，必要時才取目前 thread 的最後 session；不掃其他 thread 的歷史。
- Claude 透過 SDK getSessionMessages／listSubagents／getSubagentMessages 查詢該父 session 關聯的子 agent；最多 32 個，每次讀取限制 10,000 messages。Codex 使用該 thread 的 items。
- 即時事件在主程序、前景／背景對話皆可記錄，不依賴 renderer 是否顯示卡片。
- 已確認的成功路徑依 provider + session ID 原子保存於 userData/conversation-activity；不保存工具內容、文件內容或工具輸出。歸屬不因 reset／對話壓縮清除，重啟後與新證據合併。
- 舊對話僅能恢復 provider 歷史仍可驗證的部分；較早已壓縮且從未保存的證據不從摘要推測。
- 讀取期間切換 session／thread 時拒絕舊結果，避免歸屬混入新對話。repo 路徑以 canonical path 與最深 repo 邊界比對。

## 驗證

- typecheck、正式 build、git diff --check：通過。
- 完整回歸 `npm test -- --maxWorkers=4`：113 個測試檔、2,300 項全部通過。
- 一次完整執行遇到真實 Git subprocess 整合測試的 5 秒時限；已將該整合測試檔時限設為 20 秒，並以 4 workers 完整重跑。測試沒有刪除斷言。
- 新回歸涵蓋唯讀／提及／失敗／pending 不列入、寫檔成功匹配、子 agent 隔離、Codex 移動路徑、repo ID 後端歸屬、session 切換競態、持久化／reset／重啟、內容不寫入 ledger 與空清單呈現。
- 真實 Workspace 對話（8c5dc871…）及 4 個子 agent，SDK 可讀事件驗證得到 web-ui；沒有把 service-b 的既有 docker-compose.yml dirty 狀態當成本次寫入證據。這不是「service-b 從未修改」的宣稱，而是本次清單只採用已驗證來源。
- 真實 Electron 下拉只有提示項與 web-ui；新增一個未送出訊息的空白對話，下拉只有提示項。驗收後關閉空白對話與預覽，恢復原本對話。沒有送出模型任務。

## UI 檢查

| Before | After | Why |
| --- | --- | --- |
| 列出父目錄所有 repo | 只列目前對話有成功寫檔證據的 repo | 對應本次開發的專案範圍 |
| 空白對話也看到既有 repo | 明確顯示尚無可驗證修改 | 不把其他工作或既有 dirty 當成本次修改 |
| 歷史或前景切換可能混淆來源 | 以 session 隔離並丟棄過期查詢 | 防止上一筆對話的結果留在新對話 |

截圖未收錄。

篩選結果截圖中的洋紅色只遮蔽原始碼區域以避免複製其他專案內容，產品本身正常顯示 diff。

## 外部委派修正

進一步追查確認這筆對話亦經由外部 Codex 修改 service-a。相關父子來源與成功 patch 已接入歸屬恢復，選單現為 web-ui、service-a，見 [外部委派驗收](RESULTS-external-delegation-2026-09-21.md)。之前僅顯示 web-ui 是篩選器漏算，不能視為實際完整範圍。

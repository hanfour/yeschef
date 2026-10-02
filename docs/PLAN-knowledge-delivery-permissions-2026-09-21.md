# 封存、知識庫、開發文件與授權管理

狀態：需求設計，尚未實作。2026-09-21。

## 現況

- 歷史清單由 provider catalog 提供，Recents 尚無封存操作；Codex catalog 目前只查 archived:false。
- Claude 透過 canUseTool 與批准 registry；Codex 處理 command/fileChange 批准，啟動使用 on-request + workspace-write。
- 現有 autoAllow 主要服務右側工具，不能視為通用的使用者授權政策。
- 本次檢查未發現 GitHub／Confluence 文件發布管理介面；provider 登入不可視為取得文件平台的發布授權。

## 使用者流程

### 歷史封存

每筆對話提供「封存」，對話框可選「只封存」或「封存並建立知識草稿」。預設只封存。提供使用中／已封存篩選、搜尋與還原。封存只改 YesChef 中的可見性，不刪除或搬移 provider transcript，也不呼叫中止；執行中對話等回合結束再做封存與知識快照，明確顯示排程狀態並可取消。

知識草稿保存問題背景、結論、決策理由、可重用流程、相關檔案、測試證據、未解項目與來源對話。原始對話是來源，不能把整段逐字稿直接當成已驗證知識。使用者可編輯、標籤、合併重複內容、確認發布，或設定同專案自動收錄。生成失敗不撤銷封存，保留可重試工作。還原對話不刪除已建立知識。

### Commit／PR 文件

建立交付記錄，明確綁定 repository、branch、commit SHA 與 PR（若存在）。從 diff、來源需求、決策、測試結果建立 Markdown 草稿，包含行為改變、影響範圍、操作／部署／回復方法、驗收與已知限制。沒有跑過的測試標示「未執行」，不能推測成功。

目的地分別設定：本機 repository docs、GitHub repository 文件（以 commit／PR 交付）、GitHub PR 說明、Confluence 指定 space／父頁。GitHub／Confluence 連線方式與版本支援須在 connector 實作時確認；第一階段不預設已有可用連線。外部發布須有有效連線、明確目的地與使用者手動發布或事先設定的自動發布規則。

Commit 後產草稿，PR 建立後補上連結與檢查狀態，後續修改更新同一份交付文件。以 repository + delivery ID + destination 去重；發布前顯示預覽／差異。外部內容已被修改時回報衝突，不直接覆寫。離線、逾時、權限失效可重試，記錄外部頁面 ID、版本、最後同步 commit。

### 管理介面

專案新增「知識與交付」：封存對話、知識條目、交付文件、生成／發布工作。提供草稿／已發布／需更新／失敗狀態、搜尋、來源追溯與重試。

設定新增「連線」及「授權」。連線憑證由主程序持有，使用系統憑證儲存能力，不交給 renderer 或寫入 repository。連線與可發布目的地分開設定。共用知識以明確分享範圍提供給 agent，新對話按專案／任務查找相關條目，不自動注入所有逐字稿。

## 自動批准

提供「逐次詢問」「專案內自動」「自訂授權」模式，以及使用者明確選擇的完整工具自動批准模式。完整模式必須清楚顯示涵蓋的 provider、專案與操作範圍；可隨時撤銷。授權可以只作用本次對話、指定專案或全域預設；明確拒絕優先，較窄範圍的規則優先於預設。

分開設定讀取／寫檔、終端命令、網路／安裝、git commit、push／PR、文件外部發布、刪除／部署。使用者勾選的範圍內不再逐次跳卡；其餘維持詢問。不把「批准寫檔」擴張成「任意 shell 自動允許」。命令無法可靠分類時由獨立終端授權決定，不用字串前綴猜測。

所有授權由主程序判斷，同時接入 Claude 和 Codex adapter，檢查 canonical path、工作樹根目錄、符號連結與不存在檔案的最近實存父目錄。記錄操作、決策、命中規則與時間，避免記錄 token／檔案內容；提供暫停自動批准按鈕。政策變更後重新判定尚未了結的請求，同一批准只結算一次。

「寫檔被卡住」要顯示具體原因：等待批准、sandbox 範圍、OS 權限、路徑唯讀、鎖定或工具失敗。自動批准解決的是等待批准；不宣稱能越過 OS 或外層執行環境的限制。provider 執行隔離設定需與已授權的範圍一致，不能只把批准卡自動點掉卻維持不相容的 sandbox。需重建 session 的變更顯示生效時機，不中止現有任務。

## 資料與工作

YesChef userData 中持久化版本化 metadata：ArchiveEntry（provider＋來源識別＋session ID）、KnowledgeEntry（來源與版本）、DeliveryRecord（repo／SHA／PR）、PublishTarget、PermissionPolicy、Job。provider transcript 保持獨立。寫入採原子替換／序列化；工作使用明確 queued/running/succeeded/failed/cancelled 狀態，啟動恢復未完成工作，支持去重與重試。生成知識與文件會使用模型，排程前顯示目標與範圍。

## 交付順序與驗收

1. 封存／還原與知識草稿：重啟持久化、provider ID 隔離、生成失敗可重試、執行中封存不 interrupt。
2. 專案授權中心：Claude／Codex 行為一致；授權內寫檔不等批准、授權外仍詢問、撤銷立即影響後續請求、路徑逃逸與重複回覆回歸。
3. 交付文件本機草稿：綁定 SHA、可檢閱差異、證據不造假、重複觸發不產生重複文件。
4. GitHub／Confluence connector 與發布管理：授權／目的地／重試／外部版本衝突／撤銷連線驗收。

本文件是實作契約草案，不代表上述功能已完成，也不代表目前工作台已啟用全域自動批准。

## Agent 審核補充

規則優先序、審核 worker、provider 介接與等待界線依 [Agent 審核授權契約](CONTRACT-agent-approval-review-2026-09-21.md)。自動批准不等於每個工具必然經過審核；介接需明示攔截覆蓋率。

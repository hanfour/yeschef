# 授權與 Agent 審核 — 首版驗收

2026-09-21。承接 CONTRACT-agent-approval-review-2026-09-21.md。此版本交付專案級檔案授權、獨立 Claude 審核與人工接管，不宣稱已交付契約的全部未來能力。

## 已交付

工作台標題列新增「授權」。每個專案可儲存人工／規則自動／Agent 審核模式，選取讀取、寫入與禁止相對路徑，並可全域暫停。首次使用沒有任何自動授權；在畫面選擇模式後，必須儲存才生效。設定存於 userData/permissions/policies.json，原子寫入並檢查 revision，避免舊視窗覆寫新設定。

Claude 與 Codex 的批准 registry 接入同一套判斷。批准卡顯示檢查中、審核中或轉人工，沿用同一 requestId；使用者隨時可允許／拒絕接管。人工允許也不能繞過已設定的禁止路徑。審核中變更授權會取消 worker；最終放行再檢查版本，遲到或重複回覆只結算一次。

獨立審核使用 Claude Sonnet、無工具／MCP／plugins、無專案設定、無持久對話，且沒有一般 peer 問答。審核目的來自使用者設定，不由執行 agent 自行聲稱。模型回傳 allow／deny／ask-user；嚴格驗證 JSON 與綁定 requestId、專案／對話、規則版本、目的及操作證據的 hash。每筆 30 秒逾時，SDK 預算設定 US$0.25，每個專案同時一筆；其餘直接轉人工。授權總期限仍為 300 秒。

檔案證據檢查 canonical path、符號連結、多硬連結、工作目錄與操作內容；已存在檔案保存內容 hash，放行前再比對。Codex 由同 thread／turn／item 的 item/started 關聯 changes；缺失、過期或變動證據不能自動放行。已失效的工具請求不可再人工批准。沒有可關聯證據的普通請求保留人工決定。

最近 200 筆決策紀錄保存時間、專案／對話、工具、規則版本、來源、理由與參數 hash，不保存工具參數或檔案內容原文。UI 顯示目前專案最近 30 筆，可重新整理。模型理由是生成文字，仍應避免將敏感資料寫入審核目的。

## 支援範圍

| 請求 | 本版行為 |
| --- | --- |
| Claude Read／Write／Edit／MultiEdit | 已設定且可驗證的工作目錄內檔案請求可自動處理 |
| Codex fileChange | 有完整 add／update 差異及對應 item 證據時可自動處理 |
| Codex grantRoot | 涉及 session 範圍授權，僅人工；不把單次檔案批准擴大成目錄授權 |
| 刪除、搬移、shell、外部發布 | 不提供自動批准，收到請求時維持人工 |
| SDK／provider 未提出批准的工具 | 無法由批准 callback 攔截；此功能不是全工具防火牆 |
| OS／sandbox 拒絕寫入 | 不會因 UI 自動批准而繞過限制 |

禁止路徑僅對可辨識的檔案批准請求有效，不能限制 shell 腳本的副作用；沒有 wildcard，例如 .env 不涵蓋 .env.local。符號連結與指向範圍外的請求轉人工。路徑／內容再驗證不能消除檢查與實際執行之間的檔案競態，不把 agent 審核宣稱為原子檔案隔離。

尚未加入：全域／對話級自訂規則、終端／部署／發布的可控執行器、其他審核 provider、補證據往返、Codex 拒絕理由的自動改方案鏈、費用報表與長期稽核資料庫。首版證據不足直接轉人工，避免等待正在批准中的執行 agent 回話。

## 驗證紀錄

- typecheck、正式 build、git diff --check 通過；完整測試 108 個檔案、2,271 項全部通過。
- 針對預設人工、規則放行、禁止路徑、人工接管、版本衝突、暫停、重啟持久化、跨根目錄／符號連結、缺 diff、模型失敗、錯 hash、檔案變動、證據失效、併發限制、單次結算與期限新增回歸。
- 以本機 Codex CLI 的 generate-json-schema 核對 FileUpdateChange、PatchChangeKind.move_path 與 FileChangeRequestApprovalParams.grantRoot。
- 真實 Claude SDK 合成審核：2026-09-21，6,219ms，allow，使用成本 US$0.009542。只審核合成 README 請求，沒有執行工具／寫檔／發布。先前 sandbox 內呼叫失敗，獲准的外部執行環境驗收成功。
- 真實 Electron UI：讀取預設無政策、編輯審核草稿、480×820 viewport、關閉後確認草稿未儲存；dialog clientWidth = scrollWidth = 446，無水平溢位。實際 app 與真實模型 smoke 分開驗證，沒有聲稱已讓真實開發任務進行端到端自動寫檔。
- adverse-review 技能的 collect helper 缺失依賴 /Users/me/.codex/src/collect.mjs，無法啟動。因此沒有多代理審查通過的結論；本次採程式檢查、協定核對、回歸與實機驗收。

## UI 檢查

| Before | After | Why |
| --- | --- | --- |
| 批准只有允許／拒絕 | 顯示規則檢查／審核／轉人工與原因 | 清楚知道目前在等誰 |
| 無授權管理入口 | 標題列「授權」，專案模式與全域暫停 | 使用者可設定及撤銷自動處理 |
| 無審核追溯 | 最近紀錄顯示對話、來源與規則版本 | 能區分規則、模型與人工決定 |
| 桌面設定選項平排 | 480px 垂直排列、內容可捲動 | 窄視窗仍可讀取與操作 |

截圖未收錄。

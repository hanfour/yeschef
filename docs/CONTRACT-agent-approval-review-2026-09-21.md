# Agent 審核授權契約

日期：2026-09-21。狀態：設計定義，尚未啟用。承接 PLAN-knowledge-delivery-permissions-2026-09-21.md。

## 1. 決策權與模式

使用者授權是上限；YesChef 主程序負責執行授權規則；審核 agent 只提供結構化判斷，不能自行新增權限、變更政策或執行待審操作。執行 agent 不能批准自己的請求。同一模型可以扮演不同角色，但審核必須使用獨立 context，不能沿用執行 agent 的對話當成審核 session。

模式：manual（人工）、rules（規則自動）、review（規則加 agent 審核）。使用者也可明確設定某範圍全部直接允許，這相當於規則，不是假裝每筆都有經過 agent 審核。新功能預設 manual。

政策效果：deny／ask-user／allow／review。review 本身是一種委託授權，明確限定可委託判斷的操作與資源；不是讓模型處理所有未匹配請求。未匹配的請求交給使用者。

固定判斷順序：

1. 驗證請求身分、工具參數、provider 能力、session 世代與有效期限；無法證明待執行內容或不支援的協定，不自動批准。
2. 執行環境硬限制：OS、外層 sandbox、失效憑證不由審核決定覆蓋。
3. 任一適用明確 deny → deny。下層授權不得蓋過上層 deny；使用者需明確修改那條政策。
4. 其餘規則依對話 > 專案 > 全域選最具體作用域；同作用域以使用者可見的 priority 排序，同順位效果衝突 → ask-user。
5. allow 直接通過；ask-user 交給人；review 執行審核；無匹配 → ask-user。
6. 決定執行前重查現行政策、請求內容與 session 世代；變動使舊決定失效。

## 2. 操作規則

| 操作 | 可授權的邊界 | 自動審核要取得的事實 |
| --- | --- | --- |
| 讀取／搜尋 | 專案、目錄、檔案範圍 | 實際路徑與工具種類 |
| 新增／編輯檔案 | 指定根目錄、worktree、排除路徑 | 完整 changes、新增／刪除／修改類型、差異、基準檔案版本 |
| 終端命令 | 獨立的命令執行授權、cwd、可用網路與檔案隔離 | 完整命令／argv、cwd、腳本與設定可用證據；不能只看指令名稱 |
| git commit | repo、branch、指定變更 | staged diff、hooks 的執行權限；commit 授權不包含 push |
| push／PR | 指定 repo／remote／branch、是否允許 force／merge | ref／SHA、目的地、發布內容；內容改變需重新審核 |
| Confluence／GitHub 文件發布 | 指定站台、repo／space／父頁、建立或更新 | 最終文件差異、外部頁面 ID、基準版本與連線權限 |
| 刪除／部署 | 各自獨立授權範圍 | 目標、影響範圍、操作參數與回復資訊 |

首版不提供「模型認為無害」的通用 shell 放行捷徑。即使是測試指令，也可能執行 repository script。解析不了的命令不降格當作單純寫檔；需匹配終端授權，否則交給人。文件發布走 connector 專用工具才能精確限制目的地；透過任意 shell 呼叫外部 API 必須另受終端／網路權限控制。

原始路徑、canonical path、worktree 根目錄都由主程序驗證，不能使用字串 startsWith 判斷從屬。不存在檔案需檢查最近實存父目錄、符號連結、相對路徑與 ..。多檔操作全部符合才可整筆放行。路徑檢查不等於原子檔案隔離；存在 check/use 競態時必須依賴 provider sandbox 或可控執行器，不能宣稱只靠 agent 已保證限制。

## 3. 審核輸入、輸出

主程序產生 ReviewRequest，至少包含：requestId、projectId、conversationId、provider、sessionGeneration、turnId（若有）、toolUseId、operation、原始參數摘要與 hash、主程序解析的資源／目的地、任務目的與其來源、policyVersion、適用 rule IDs、證據版本／hash、createdAt、deadline。

工具參數、diff、檔案與對話均是待審資料；其中的「忽略規則」「使用者已同意」不能當作授權來源。審核只取得必要資料，遮蔽 token／憑證；不把完整 transcript 或環境變數無條件發給另一模型。

審核結果使用嚴格 schema：

- verdict：allow／deny／needs-evidence／ask-user。
- requestId、requestHash、policyVersion：必須與現行請求一致。
- reasonCode、簡短理由、evidenceRefs、matchedRuleIds。
- needs-evidence 可列出需要的檔案／差異／版本資料；由主程序限制讀取範圍。
- deny 可附替代方案建議；不能直接修改待批准命令。

信心分數不是批准條件。缺欄位、未知 verdict、偽造證據引用、來源不完整或截斷且影響判斷 → ask-user。allow 只有在適用 review 授權範圍內才可被主程序採納。批准是一次性且綁定原始參數；任何修改都是新請求。

## 4. 自動交互與等待界線

審核 worker 獨立運作，不能使用一般 peer service 等待 busy 的執行 agent 回答。目前 peer/service.ts 的投遞需等 notifyIdle，而執行 agent 可能正等批准，直接套用會形成循環等待。

- 可以自動補證據：worker 請主程序讀取已授權的唯讀資料，再做一次審核。
- 必須改命令／計畫：先拒絕原工具操作，回傳可理解的理由；執行 agent 繼續後提出新請求。不能保持原批准 promise 未決，再要求同一執行串流回話。
- Claude 可沿用 deny message 傳遞理由。
- 目前 Codex adapter 的批准回覆只有 accept／decline，沒有通用理由投遞契約；UI 顯示原因，模型回饋介接需先驗證協定。未驗證前不能承諾 Codex 全自動來回改方案，不擅自注入 userInput 或中止回合。
- 替代方案經修改後重新匹配政策、重新審核，不沿用舊批准。

建議首版可配置預設：每筆審核 30 秒，最多補證據一次；同一工作操作修改最多兩輪；每個專案一個審核併發，佇列等待也計入 deadline。超時、額度耗盡、worker 不可用 → 交給人。人工等待保留目前最長 300 秒總批准期限，不因重試無限延長；期限用盡拒絕這次工具操作，明示「逾時」，不標成「使用者拒絕」。時間與費用設定需 UI 可見。

## 5. 介接方式

```text
Claude canUseTool ───────────┐
Codex command/file approval ├─> Provider adapter / Evidence store
YesChef connector tools ───┘                │
                                  ApprovalCoordinator（主程序）
                                             │
                            PolicyEngine ────┼──── allow / deny
                                             ├──── ReviewWorker
                                             └──── 人工批准卡
                                                       │
                              版本／hash 再驗證 → settle once
                                                       │
                                  原 provider 回覆 + 審核紀錄
```

### 現有程式的修改點

- src/main/approval.ts：目前 registry 負責 promise、300 秒 timer、單次 settle，並立即送 renderer。抽出可註冊／排程／結算的生命週期，讓 reviewing 和 awaiting-user 共用同一個 requestId；不是先跳卡再另寫一套自動批准。補上帶理由結算與取消入口。
- src/main/agent-host.ts：canUseTool 統一呼叫 coordinator；既有 autoAllow 要納入同一政策，避免繞過明確 deny。
- src/main/conversation.ts 與 codex/conversation.ts：注入同一 coordinator；保持對話關閉、取消、待決數與批准通知一致。
- src/main/codex/client.ts + mapper.ts：按 provider/session/turn/item 關聯 item/started 的 command／changes 證據；目前 fileChange 批准 input 只有 reason，不能據此自動批准寫檔。缺失／遲到／不完整證據不得猜測路徑。未知 server request 仍明確拒絕，不用通用 accept 兜底。
- src/main/ipc-bridge.ts + src/shared/ipc.ts：加入 review 狀態、政策管理、人工接管與歷史查詢；renderer 只能操作自身可管理的請求，不能提供可信 policyVersion 或自行宣告審核成功。
- 新增主程序 approval-policy、approval-coordinator、approval-evidence、approval-reviewer、approval-audit 模組。worker provider 可配置，但和被審核對話必須是不同 session。worker 不具寫檔、shell、外部發布或批准工具，只回 JSON；唯讀補證據由 coordinator 代理。

### 覆蓋率不是預設保證

批准 callback 不一定包含所有工具執行；SDK／provider 內已允許的操作可能不再詢問。實作要列出各 provider 的「已攔截」「由 sandbox 限制」「尚不支援」能力表。若使用者要求某類操作每次先審、但 provider 無法可靠攔截，設定不得假裝已生效；要拒絕啟用該保證或切換至可控工具路徑。取消、修改 policy、擴大 sandbox 的生效時間分別標明，不中止現有任務來偷換設定。

## 6. 狀態、撤銷與紀錄

狀態：received → checking → reviewing / awaiting-user → allowed / denied / cancelled / expired。終態只可到達一次。人工接管時先取消 worker；遲到結果丟棄。政策撤銷後尚未執行的允許須重新判定；已交給 provider 的操作不能保證撤回，必須明示「已開始執行」。

審核結果按完整請求與證據快照綁定，不跨 diff／命令／目的地快取 allow；使用者持久授權以規則處理。審核工作不寫入一般歷史清單、不建立可恢復的執行 session。重啟後不把舊的 pending 批准自動執行，記錄為取消。

UI 狀態列顯示自動批准模式，批准卡顯示規則檢查／審核中／等你確認。可查看提出者、審核者與模型版本、命中規則、理由、耗時／成本、最終決策與實際執行結果。保留暫停自動批准與單筆接管；允許不等於執行成功。紀錄有保留期限，不保存憑證與不必要原始內容。

## 7. 必要驗收

- 規則優先序、未匹配、review 範圍、明確 deny 無法被模型覆蓋。
- Claude／Codex 相同授權結果；fileChange 缺 diff、錯 item／turn／session、未知 RPC 不能被自動通過。
- 路徑跳脫、符號連結、多檔混合授權；shell 不誤分類為單純寫檔。
- 審核 JSON 錯誤、提示注入文字、補證據失敗、模型超時／成本上限均有明確結果。
- 同時人工回覆與 worker 回覆、政策撤銷、內容變動、對話切換／關閉、程序重啟：一次結算、不留永遠 pending。
- 執行 agent 等批准時不走依賴該 agent idle 的問答路徑；拒絕工具不誤用整個 turn 的 cancel。
- 真實 provider 冒煙測試確認攔截覆蓋、拒絕回饋、sandbox 約束及 UI 接管；測試環境不發布到真實外部目的地。

首版交付邊界：規則與人工接管、完整證據、獨立審核 worker。跨 agent 自動改方案按 provider 能力逐步啟用，不把尚未驗證的互動當成已支援功能。

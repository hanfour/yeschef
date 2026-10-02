# YesChef 自動主廚：第一版實作與驗證

日期：2026-09-21。入口為工作台頂端「主廚」；使用者交付文字目標，預設不必指定模型。原固定對話不轉換；新任務由獨立控制台建立。

## 已實作

- 自動、偏好模型＋備援、固定模型三種策略；允許模型池、執行次數與期限。
- Claude supportedModels 與 Codex model/list 動態清單；requested model 與實際 session 回報分開紀錄。
- 主廚透過 delegate_task 登錄子工作，平台序列建立真實對話分頁，再建立驗收者。工作者不能再次委派；共用既有 skills、專案授權、活動紀錄與 diff。
- 識別 provider／連線故障後，先確認舊執行者停止，再用 checkpoint 啟動其他候選。每單位最多三次執行，且受任務總次數及期限限制。
- 拒絕、取消、未知工具結果、背景工作及未確認停止不會觸發自動繞過。啟動競態與工作台重啟保留核對狀態，不自動重播不明操作。
- 主廚、子任務及驗收的 session 活動合併至任務 diff，共用任務起始 baseline。工作目錄重疊的受管理任務與普通 YesChef 輸入互斥。
- report_result 必須引用本任務成功工具事件；實作／測試單位不能只拿 task_progress 等控制工具當成成果證據。這是證據來源檢查，不是程式正確性的自動證明。

## 真實工作台驗證

獨立 Electron profile：`/private/tmp/yeschef-chef-e2e-data`。
測試專案：`/private/tmp/yeschef-chef-e2e-project`；未修改 Workspace 專案。

真實任務 `c613c8b8-2b24-4408-b243-5f12c945620c` 完成以下鏈：

| 階段 | 實際 session 回報模型 | 結果 |
| --- | --- | --- |
| 規劃 | claude-opus-5[1m] | 呼叫 delegate_task 建立一個 code 子單位 |
| 實作 | gpt-5.5 | 檔案工具建立 smoke.txt |
| 驗收 | claude-opus-5[1m] | Read 讀回並引用真實工具 ID 回報 |

三個執行者 shutdownConfirmed 均為 true；宿主另外直接讀取檔案，內容精確為 `CHEF_SMOKE_OK\n`。模型名稱是本次後端回報，不是能力排名或保證未來可用。

**驗證限制與發現：**首輪主廚使用了原測試禁止的唯讀 shell；Codex 沒有獨立 Read 工具，讀回由驗收者完成。故此輪證明跨 provider 委派、寫檔、驗收、紀錄及停止鏈成立，不能宣稱原測試全部限制通過。後續補強提示，要求委派以成果與限制描述，不假設跨 provider 工具名稱一致；工具能力不足必須回報阻塞。自然語言限制不等同工具層的硬性禁止，仍須依專案授權設定限制操作。

故障、拒絕、停止競態與重啟恢復使用自動測試模擬；沒有聲稱真實製造 provider 故障。

## UI 檢查

已檢視真實 Electron 桌面與 480px 窄視窗截圖，確認控制台可讀、可捲動，沒有水平溢出。

| Before | After | Why |
| --- | --- | --- |
| 分頁只能選固定 provider | 頂端主廚入口與自動模式 | 使用者交付目標，不必逐次指定模型 |
| 委派與接手散落在對話 | 任務、工作單位、實際模型與停止狀態集中顯示 | 可追查誰做了什麼 |
| 錯誤後缺少明確接續入口 | 保留進度、停止與接續控制，必要時要求核對 | 避免重複執行不明操作 |

截圖保存在 `/private/tmp/yeschef-chef-desktop.png`、`/private/tmp/yeschef-chef-mobile.png`；它們是本機驗證產物，不含真實專案內容。

## 檢查與第一版界線

- 完整測試：116 files / 2,316 tests passed；隨後新增 UI 與控制工具證據測試，主廚相關 3 files / 16 tests 全數通過。
- TypeScript、正式 build、git diff whitespace 檢查通過。
- 路由目前使用工作類型、provider 預設候選、模型池與本次失敗紀錄；尚無工具能力矩陣、品質／價格排名或跨任務健康統計。
- 清單成功不代表登入／額度／模型執行一定成功；真正啟動時仍可能失敗。
- 目前是序列委派；並行隔離工作樹、同模型退避重試、嚴格美元預算與附件型主廚目標尚未實作。成本只顯示 provider 回報值。
- workspace 互斥範圍是 YesChef 管理的模型輸入；不鎖作業系統上的外部編輯器或終端機。Claude 原生 Agent／Task 已停用，提示禁止 shell 啟動其他 agent，但這不是完整的 OS 程序隔離。
- report_result 的 summary 仍是模型判讀，使用者應以 diff、實際測試與原始工具結果驗收重要變更。

## 跨任務模型冷卻驗收（2026-10-02）

| 項目 | 結果 |
| --- | --- |
| 修前重現 | 主廚 service 測試將任務 A 的 404 分類為 `model-unavailable` 並改派成功；任務 B 第一個 worker 仍選 `gpt-6-sol`，預期的備援模型為 `gpt-5`。錯誤使用假 worker 模擬，沒有呼叫真實 Codex API。 |
| 修後主廚流程 | 任務 A 的模型 key 會影響接續任務的首次選擇，到期時間由 `endedAt` 計算，缺少時使用 `startedAt`。24 小時到期後可重新選用。同任務內的舊 key 仍會排除模型。 |
| 全候選被排除 | 任務維持既有 block 狀態與訊息「沒有可用且獲授權的候選模型；請檢查連線或模型池。」沒有啟動被排除模型。 |
| 主廚模型池 UI | 元件測試確認顯示帳號不支援與到期時間，且核取框仍能取消選取。 |
| TypeScript | `npm run typecheck` 通過。 |
| 完整 Vitest | `npx vitest run --configLoader runner --exclude tests/chef-view-tools.test.ts --exclude tests/grok-view-tools.test.ts --exclude tests/terminal-server.test.ts --exclude tests/view-tools-http-server.test.ts`：184 個測試檔通過、1 個略過；3,225 項通過、1 項略過。 |
| Electron 截圖 | 未驗收。`npm run verify screenshots` 的 build 與打包通過，但 Electron 啟動時以 `SIGABRT` 結束，沒有輸出 `.spike-out/ui/` 截圖。第二次啟動仍以相同結果結束，已停止重試。 |

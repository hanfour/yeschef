# 錯誤收集資料庫設定：驗收紀錄

日期：2026-10-01。對應規格 `docs/specs/2026-10-01-error-intake-design.md` §3。

## 1. 自動測試

| 項目 | 結果 | 證據 |
|---|---|---|
| 密碼加密保存、Keychain 不可用時拒絕保存、IPC 不回傳密碼或密文 | 通過 | `tests/error-intake-service.test.ts`、`tests/error-intake-shared.test.ts`、`tests/error-intake-ipc.test.ts` |
| 管理者權限檢查與缺少權限列表 | 通過 | `SHOW GRANTS FOR CURRENT_USER()` 欄位解析測試，資料庫層級權限不會冒充全域 `CREATE USER` |
| 專案代號、帳號名稱、重複代號與最小授權 | 通過 | `tests/error-intake-service.test.ts` |
| 清理排程、刪除筆數與失敗隔離 | 通過 | `tests/error-intake-service.test.ts` |
| 設定對話框、頂欄入口、preload IPC schema | 通過 | `tests/error-intake-manager.test.tsx`、`tests/app.test.tsx`、`tests/preload-bridge.test.ts` |
| 真實 MySQL 初始化、寫入帳號隔離與過期資料清理 | 通過 | 沙箱外以 Docker Percona 8.4 設定 `YESCHEF_ERROR_DB_TEST_URL` 執行，連跑兩次通過 |

## 2. 實機驗收

| # | 項目 | 結果 | 未完成原因與後續驗法 |
|---|---|---|---|
| 1 | 初始化與管理者權限不足提示 | 初始化通過；權限不足提示只有單元測試 | 整合測試與實機（§6）確認三張表與 `ei_yeschef` 建立；權限不足帳號的畫面操作未做 |
| 2 | 密碼不外洩 | 未驗收 | 自動測試確認設定檔只存密文，IPC 與安全錯誤不含密碼。Electron 實機檢查 renderer、主程序紀錄仍待執行 |
| 9 | 專案寫入帳號權限 | 通過 | 整合測試以寫入帳號連線，確認不能讀寫其他資料表、不能建表 |
| 10 | 設定畫面操作 | 通過 | 使用者實際操作連線並初始化成功；§6 的驗收程式以 CDP 操作同一畫面。過程中修正取消勾選 TLS 時畫面崩潰、初始化後啟用按鈕不會解除停用 |

## 3. 權限檢查方式

初始化使用管理者連線，但不先選定資料庫，執行 `SHOW GRANTS FOR CURRENT_USER()`，解析全域、資料庫與資料表範圍。檢查 `CREATE`、全域 `CREATE USER`、可授出的 `SELECT`、`INSERT`、`UPDATE`、`DELETE`，以及 migration 寫入 meta 所需的 `INSERT`。權限不足時回報缺少項目，檢查通過後才選擇設定的資料庫並執行 migration。

yeschef 與專案帳號若已存在會先移除同名帳號，再重建並只授予規格列出的資料表權限，避免保留既有額外授權。

代號 `yeschef` 與 `sidepane` 保留，因為寫入帳號會與 app 帳號 `ei_yeschef`（改名前建立的是 `ei_sidepane`）撞名。同一個 yeschef 專案建立寫入帳號後，目前不允許更換代號，以免留下仍可連線的舊帳號。這兩項規則需在第 3 步整合前確認。

更換資料庫主機、連接埠或資料庫名稱時會清除本機保存的 yeschef 與專案帳號密文，不會連到舊資料庫撤銷帳號。舊資料庫的帳號清理方式需在資料庫切換流程定義前確認。

## 4. 指令結果

| 指令 | 結果 |
|---|---|
| `npm run typecheck` | 通過，exit 0 |
| `npm run build` | 通過，exit 0。主行程保留 `mysql2/promise` 外部匯入，套件來源 alias 成功打包 |
| `npx vitest run tests/error-intake-service.test.ts tests/error-intake-shared.test.ts tests/error-intake-ipc.test.ts tests/error-intake-manager.test.tsx tests/error-intake-integration.test.ts tests/app.test.tsx tests/preload-bridge.test.ts` | 通過，6 個測試檔案、59 個測試通過，整合測試 1 項略過 |
| `npx vitest run --exclude tests/measure-memory.test.ts` | exit 1，165 個測試檔案通過、1 個略過；3,055 個測試通過、21 個失敗。失敗名稱：`tests/terminal-server.test.ts`、`tests/view-tools-http-server.test.ts`、`tests/grok-view-tools.test.ts`、`tests/chef-view-tools.test.ts` |

全套 Vitest 的 21 個失敗都遇到沙箱禁止綁定 `127.0.0.1` 的 `listen EPERM`。本次未啟動 Electron，設定畫面與 MySQL 仍按第 2 節標記未驗收。

## 5. §4 啟用錯誤收集

### 5.1 自動測試

| 項目 | 結果 | 證據 |
|---|---|---|
| 啟用前檢查、確認勾選、代號與套件來源、既有主廚任務失敗回復、政策沿用群組預設 | 通過 | `tests/error-intake-activation.test.ts`、`tests/error-intake-goal.test.ts` |
| 寫入帳號沿用、代號鎖定、資料庫初始化與 schema 版本檢查 | 通過 | `tests/error-intake-service.test.ts`、`tests/error-intake-manager.test.tsx` |
| env 檔路徑、symlink、git 忽略、保留既有內容與不回傳連線值 | 通過 | `tests/error-intake-tools.test.ts` |
| 查詢時間、專案條件、遮罩、不可信資料標示、`ei_yeschef` 帳號與錯誤 log 不含密碼 | 通過 | `tests/error-intake-service.test.ts`、`tests/error-intake-tools.test.ts`、`tests/chef-error-intake-tools.test.ts` |
| Claude、Codex、Grok 工具批准規則與用途限制 | 通過 | `tests/chef-error-intake-tools.test.ts`、`tests/codex-conversation.test.ts`；Grok 批准入口測試單獨執行 1 項通過 |
| 舊 `tasks.json` 沒有 `purpose` 欄位 | 通過 | `tests/chef-task-purpose.test.ts` |
| Renderer 顯示條件、確認勾選、啟用與複製 IPC | 通過 | `tests/error-intake-manager.test.tsx`、`tests/preload-bridge.test.ts` |
| 啟用後以專案寫入帳號新增錯誤並查詢 | 通過 | 沙箱外執行整合測試通過 |

### 5.2 指令結果

| 指令 | 結果 |
|---|---|
| `npm run typecheck` | 通過，exit 0 |
| 設定對話框與 theme 規則測試 | 通過，2 個測試檔案、20 個測試通過 |
| `npx vitest run --exclude tests/measure-memory.test.ts` | exit 1，171 個測試檔案通過、1 個略過；3,101 個測試通過、21 個失敗 |

Vitest 失敗名稱：`tests/chef-view-tools.test.ts`、`tests/grok-view-tools.test.ts`、`tests/terminal-server.test.ts`、`tests/view-tools-http-server.test.ts`。失敗原因為沙箱拒絕綁定 `127.0.0.1`，錯誤是 `listen EPERM`。

### 5.3 實機驗收

| # | 項目 | 結果 | 未完成原因與後續驗法 |
|---|---|---|---|
| 1 | 專案上啟用、建立寫入帳號並開主廚任務 | 通過 | 見 §6 |
| 2 | 確認密碼不出現在 renderer、任務目標、工具回傳、群組訊息與 log | 自動測試通過；實機未驗收 | 自動測試檢查 IPC、任務目標、工具回傳、群組里程碑與資料庫錯誤 log。Electron 實機檢查 renderer 與主程序紀錄仍待執行 |
| 3 | Claude、Codex、Grok 工具批准與實際 env 檔寫入 | Claude、Codex 通過；Grok 未驗收 | §6 中 Claude 與 Codex 主廚都呼叫過 `configure_error_intake_env` 並跳出批准卡片；Grok 未在實機跑過 |
| 4 | 啟用後查到錯誤資料庫的資料 | 通過 | 見 §6，主廚在 demo-app 實際觸發錯誤後以 `check_error_intake` 查到後端與瀏覽器的錯誤群 |

## 6. demo-app 實機驗收（規格 §11 #3 到 #8）

用 `npm run verify error-intake` 執行（`spikes/error-intake-acceptance*.ts`）。每一輪：

1. 重建測試資料庫 `error_intake_test`（Docker Percona 8.4，port 33307），從 `example/demo-app` 的 `origin/main` 開新的 worktree，複製目標專案後端的 `.env`，安裝依賴並產生 ORM client。
2. 以暫時的 user-data 啟動 yeschef，用畫面設定錯誤資料庫、填套件來源（本機 `npm pack` 檔）、對 worktree 按「啟用錯誤收集」。
3. 等主廚任務結束，批准卡片逐張記錄後放行；`configure_error_intake_env` 放行前確認 env 檔在 worktree 內且被 git 忽略。主廚會 push 分支並開 draft PR。
4. 驗收程式自己在 worktree 起 demo-app（API :3001、前端 :5021），不經主廚做交叉驗證。

### 6.1 有效的兩輪

| 項目 | 第二輪 | 第九輪 |
|---|---|---|
| 主廚任務 | 完成 | 完成 |
| draft PR | 已建立，詳細資料未收錄 | 已建立，詳細資料未收錄 |
| 主廚以 `check_error_intake` 查到錯誤 | 是 | 是（後端與瀏覽器各一群） |
| #4 後端 5xx：觸發 3 次 503 | 1 群、次數 3、樣本 3 | 1 群、次數 3、樣本 3 |
| #5 4xx 不收（401） | 筆數不變 | 筆數不變 |
| #6 瀏覽器未捕捉例外 | 收到 1 筆 | 收到 1 筆 |
| #7 遮罩（email、Bearer token、帶 `?key=` 的網址、10 位數字） | 資料庫找不到原始值 | 資料庫找不到原始值 |
| #8 超過 16 KB 的請求 | 丟棄 | 丟棄 |
| #8 同一來源 31 次請求 | 前 30 次 204、第 31 次 429 | 前 30 次 204、第 31 次 429 |

主廚的安裝方式兩輪一致：後端掛全域例外處理與關閉時收尾；接收端點掛在 `/error-intake`，因為 demo-app 的 Vite 與 nginx proxy 都會去掉 `/api`，前端仍送 `/api/error-intake`；`env.example` 只列變數名稱；以假 sink 寫測試。第九輪另外說明 demo-app 用 pnpm 的 `catalog:` 依賴，改用 pnpm 而非 npm 安裝。

第一輪（除錯用）主廚裝好的 worktree 另外單獨跑交叉驗證兩次，6 項全部通過。

### 6.2 過程中修正的問題

| 問題 | 修正 |
|---|---|
| 第一次設定時初始化成功後，「啟用錯誤收集」仍停用 | 資料庫 schema 版本改變時重讀專案狀態 |
| CommonJS 的 TypeScript 專案（demo-app 的 NestJS）import 套件報 TS1479 | 套件另外產生 `.d.cts`；建置改用 TypeScript 5，因 TypeScript 7 沒有 tsup 產生型別所需的 API |
| 安裝任務拆成約 7 個工作單位，8 次執行上限用完 | 安裝任務給 12 次 |
| Codex 主廚傳了 env 檔的絕對路徑，被拒絕後任務停住 | 專案內的絕對路徑一律接受並換成相對路徑 |
| 背景啟動的 Bash 一律標成「有背景工作」且永不清除，任務結束時被判定需要核對 | 記住背景工作 ID，`TaskStop`／`TaskOutput` 確認結束後移除 |
| 規劃者把 typecheck、lint、測試丟到背景後就結束本回合 | 主廚與工作者指示要求需要等結果的指令在前景執行 |
| 背景工作規則寫死 `TaskStop`，Codex 驗收者沒有這個工具而跳過實際驗證 | 停止方式依執行者給：Claude 用 `TaskStop`，其他用 `kill` |

驗收程式本身另外修了：macOS `/var` 符號連結造成路徑比對失敗、React 勾選框需用 click 觸發、初始化後欄位短暫不在畫面上、前端只聽 `localhost`、錯誤非同步寫入需等筆數穩定、接收端點路徑改從 worktree 讀出主廚的設定。

### 6.3 不算數的幾輪與限制

- 第三輪：主廚在 GitHub 上看到第二輪的 PR，直接沿用該分支，沒有從零安裝。之後每輪開始前關閉前一輪的 PR 並刪除分支。已關閉的 PR 仍查得到，主廚會去查，但第五輪之後的主廚都確認已關閉的 PR 沒有留下成果後從零安裝。
- 第四、六、七輪：停在「仍有背景工作或工具結果不明」，原因與修正見 6.2。
- 第五輪：Codex 傳絕對路徑被拒，見 6.2。
- 第八輪：Codex 驗收者沒有 `TaskStop`，見 6.2。
- 套件以本機打包檔安裝，demo-app 的 `package.json` 與 lockfile 記錄的是本機絕對路徑；PR 合併前要先把套件發佈到 npm。
- Grok 未在實機跑過。

## 7. 第 4 步實作自動驗收（2026-10-02）

| 項目 | 結果 |
|---|---|
| 型別檢查 | `npm run typecheck` 通過。 |
| 錯誤拉取、任務目標、狀態回寫與畫面測試 | `npx vitest run tests/error-pull.test.ts tests/chef-error-fix-writeback.test.ts tests/group-pane.test.tsx tests/error-intake-service.test.ts tests/error-intake-activation.test.ts tests/chef-service.test.ts tests/chef-task-purpose.test.ts tests/error-intake-integration.test.ts`：111 項通過，1 項略過。 |
| 完整 Vitest | `npx vitest run --exclude tests/measure-memory.test.ts`：3143 項通過，1 項略過，21 項因 loopback `listen EPERM` 失敗。受影響檔案：`tests/chef-view-tools.test.ts`、`tests/grok-view-tools.test.ts`、`tests/terminal-server.test.ts`、`tests/view-tools-http-server.test.ts`。 |
| MySQL 整合 | 略過。未設定 `YESCHEF_ERROR_DB_TEST_URL`。 |
| Electron 畫面操作與截圖 | 未驗收。此環境限制啟動 Electron。 |

## 8. 規格 §6「不開 PR」實機驗收程式（2026-10-02）

| 項目 | 結果 | 證據 |
|---|---|---|
| 型別檢查 | 通過 | `npm run typecheck`，exit 0。 |
| 樣本、報告解析、遠端分支與 PR 比較、工具拒絕規則 | 通過 | `npx vitest run tests/error-pull-acceptance-fixtures.test.ts tests/verify-runner.test.ts`：2 個測試檔案、29 項通過。 |
| App build 與驗收程式 bundle | 通過 | `npm run build` 與 `npx esbuild spikes/error-pull-acceptance.ts --bundle --platform=node --format=cjs --packages=external --outfile=.spike-out/error-pull-acceptance.cjs` 均 exit 0；未執行 bundle。 |
| Electron、MySQL 與 demo-app 實機流程 | 通過 | 見 §9 |

## 9. 規格 §6 實機驗收：交給主廚、不開 PR（2026-10-02）

用 `npm run verify error-pull` 執行。每一輪重建測試資料庫、從 `example/demo-app` 的 `origin/main` 開新 worktree，以畫面設定並啟用錯誤收集後停掉安裝任務，寫入兩個不是程式問題的錯誤群：外部認證服務的 API gateway 連線失敗、驗收程式以 `executeJavaScript` 注入的 TypeError。再由「拉錯誤」對話框勾選兩個群交給主廚。

執行前須設定 `TARGET_REPO`、`TARGET_GITHUB_REPO` 與 `TARGET_ENV_FILE`。環境檔路徑以 repo 根目錄為基準，驗收程式沒有預設的本機專案路徑。

| 項目 | 第五輪 | 第六輪 |
|---|---|---|
| 停掉安裝任務後工作目錄釋放，能開修錯誤任務 | 通過 | 通過 |
| 對話框選 `local`、勾選兩個群並交給主廚，群變成處理中並記下任務 ID | 通過 | 通過 |
| 任務 purpose 為 `error-fix`、狀態 completed | 通過 | 通過 |
| 報告兩個群各一行不開 PR 與原因（503：stack 指向的程式不存在、外部服務不可用；TypeError：驗收注入、沒有應用程式 frame） | 通過 | 通過 |
| 群維持 `in_progress`，status_note 含任務 ID 與原因 | 通過 | 通過 |
| 主廚沒有嘗試 commit、push、開 PR；遠端沒有新增 `fix/error-*` 分支或 PR | 通過 | 通過 |
| 任務目標含 `<error-data>` 與兩個群 ID，不含資料庫密碼或連線字串 | 通過 | 通過 |

過程中修正的 app 問題：

| 問題 | 修正 |
|---|---|
| 在設定對話框啟用後，群組分頁要切換專案才出現「拉錯誤」 | 啟用成功後送出狀態改變通知，群組分頁重讀 |
| 拉錯誤對話框第一次打開時載入兩次，第二次載入清空使用者剛勾的錯誤 | 只有使用者切換環境才重新查詢；重新載入時只拿掉已不在清單裡的勾選 |

「修好並開 PR」的路徑還沒有實機驗收，要等有真實的程式錯誤（例如 demo-app staging 啟用錯誤收集後）再驗。

## 10. 公開前清理檢查（2026-10-02）

| 項目 | 結果 | 證據 |
|---|---|---|
| 公開內容關鍵字掃描 | 通過 | 指定的兩條 `git grep` 指令均無輸出 |
| 驗收截圖 | 已移除 | 29 張截圖已刪除，文件引用改為「截圖未收錄」 |
| 目標專案設定 | 通過 | `TARGET_REPO`、`TARGET_GITHUB_REPO`、`TARGET_ENV_FILE` 必填；環境檔以目標 repo 根目錄為基準 |
| 根目錄 typecheck | 通過 | `npm run typecheck`，exit 0 |
| 根目錄 Vitest | 通過 | 180 個檔案、3,160 項通過，1 項略過；因沙箱限制排除 `tests/chef-view-tools.test.ts`、`tests/grok-view-tools.test.ts`、`tests/terminal-server.test.ts`、`tests/view-tools-http-server.test.ts` |
| 套件 typecheck 與 Vitest | 通過 | `npm run typecheck --prefix packages/error-intake` exit 0；測試 33 項通過、2 項略過 |
| Electron 與 loopback 實機驗收 | 未驗收 | 沙箱不能啟動 Electron 或綁定 loopback |

# 專案執行：一鍵啟動並在右側瀏覽器查看

日期：2026-10-05。狀態：已確認，實作中。

## 1. 目的

使用者要隨時打開專案的實際畫面操作，例如正在開發的網站。現在要自己開終端、找出啟動指令與連接埠、在右側瀏覽器輸入網址；服務也可能被 Agent 的指令停掉。實際經營一個專案時，這些都是手動完成的（找指令、複製資料、檔案變動就重啟、另寫規則避免工作者停掉服務）。

這份規格把它做成每個專案都能用的功能：專案設定一次啟動方式，之後按「執行」由 YesChef 啟動服務、等它準備好、在右側瀏覽器打開，並保護它不被 Agent 停掉。

名稱：介面用「執行」。「開啟預覽」已經是文件預覽（`PreviewPane`）的名稱，不重複使用。

## 2. 範圍

第一階段（本規格的實作範圍）：

- 啟動設定：偵測候選、使用者確認、每個專案保存一份。
- 執行、停止、重啟；狀態與紀錄。
- 準備好後在右側瀏覽器打開。
- 檔案變動自動重啟（每個專案可開關）。
- 保護：工具批准擋下停止受管服務的指令；服務非預期結束時偵測並自動重啟。

第二階段（另案）：

- 同一專案同時跑「開發中」與「固定版本」兩份（固定版本放在指定 commit 的 worktree，可選擇使用資料複本）。
- 主廚與工作者可查詢服務狀態、驗收時使用服務網址。

不做：

- 不安裝任何相依套件或工具；啟動指令失敗時顯示紀錄，由使用者處理。
- 不處理需要登入或互動輸入的啟動指令。
- 不做多服務編排（例如前後端兩個指令一起起）；第一階段每個專案一個服務。

## 3. 啟動設定

### 3.1 資料

存在 `<userData>/project-run/<projectId>.json`，與測試機設定相同的做法（不寫進專案資料夾，不會被 commit）。移除專案時一併刪除。

```ts
interface ProjectRunConfig {
  readonly version: 1
  readonly command: string          // 例如 "npm run dev"、".venv/bin/python server.py --port {port}"
  readonly cwd: string              // 相對於專案根目錄，預設 "."
  readonly port: number             // 服務的連接埠
  readonly url: string              // 打開的網址，可用 {port}，預設 "http://127.0.0.1:{port}/"
  readonly readyPath: string        // 準備好的判斷路徑，預設 "/"
  readonly env: Readonly<Record<string, string>>  // 額外環境變數，不放密碼（見 3.3）
  readonly portStrategy: 'fixed' | 'placeholder'  // placeholder：指令或 env 含 {port}，被佔用時可換埠
  readonly watch: { readonly enabled: boolean; readonly include: readonly string[]; readonly exclude: readonly string[] }
  readonly openInBrowser: boolean   // 準備好後在右側瀏覽器打開，預設 true
}
```

### 3.2 偵測候選

第一次按「執行」而沒有設定時，YesChef 讀專案檔案產生候選，使用者在對話框選一個或修改後保存。偵測只讀檔、不執行任何指令：

| 來源 | 候選 |
| --- | --- |
| `package.json` 的 `scripts.dev`、`start`、`preview`、`serve` | `<套件管理器> run <script>`；套件管理器依 lockfile 判斷（pnpm-lock.yaml、yarn.lock、bun.lockb、package-lock.json） |
| 指令中的 `--port N`、`-p N`、`PORT=N` | 連接埠 N |
| 常見工具預設埠：vite 5173、next 3000、astro 4321、webpack-dev-server 8080、django `manage.py runserver` 8000、flask 5000 | 對應連接埠 |
| `manage.py`、`app.py`、`server.py`、`main.py`（Python） | `<venv>/bin/python <檔名>`；有 `.venv` 或 `venv` 時用其中的 python |
| `Procfile` 的 `web:` 行 | 該指令 |
| README 中帶 `localhost:N`／`127.0.0.1:N` 的程式碼區塊 | 該指令與埠 |

每個候選標示來源（例如「package.json scripts.dev」）。找不到時讓使用者自行輸入。

偵測寫成純函式（輸入檔案內容，輸出候選清單），單元測試涵蓋上表每一列。

### 3.3 環境變數與密碼

`env` 只放非機密設定。指令需要的密碼請使用者放在專案自己的 `.env`（由專案的啟動程式讀取），YesChef 不保存、不顯示。

## 4. 執行

### 4.1 程序

- 由主行程以 `spawn` 啟動，`detached: true` 建立獨立的程序群組，透過使用者的登入 shell 執行（`$SHELL -lc '<command>'`），讓 PATH 與版本管理工具（volta、pyenv 等）和終端一致。
- 記錄 pid 與程序群組 id。停止時對整個群組送 SIGTERM，10 秒內未結束再送 SIGKILL，確認群組沒有成員才算停止。
- 標準輸出與錯誤寫進 `<userData>/project-run/logs/<projectId>.log`（超過 5 MB 輪替一份），並在記憶體保留最後 2000 行供畫面顯示。
- YesChef 結束時停止所有受管服務。

### 4.2 連接埠

啟動前檢查連接埠：

- 空著：直接啟動。
- 被本專案的受管服務佔用：視為已在執行，不重複啟動。
- 被其他程序佔用：顯示佔用者（`lsof` 的程序名稱與 pid）。`portStrategy` 為 `placeholder` 時提供「改用空著的埠」，以新埠替換 `{port}` 後啟動；為 `fixed` 時不啟動，請使用者處理。

### 4.3 準備好的判斷

每 500 毫秒對 `url` 的 `readyPath` 發 HTTP GET，回應狀態碼小於 500 即視為準備好；上限 90 秒（可設定）。逾時或程序先結束時，狀態為「啟動失敗」，畫面顯示紀錄最後 40 行。

### 4.4 狀態

`stopped`、`starting`、`running`、`restarting`、`failed`。狀態變化推送到畫面；專案分頁標示一個狀態點（執行中為綠色）。

### 4.5 在右側瀏覽器打開

準備好後，若 `openInBrowser` 為 true，用目前專案前景對話的瀏覽器打開 `url`（沿用 `createBrowserCommands` 的導覽與 `checkNavigateUrl` 檢查）。專案沒有對話分頁時，建立一個新的對話分頁（不啟動模型 session，直到使用者送出第一則訊息），再打開網址。

## 5. 檔案變動自動重啟

- `watch.enabled` 預設：偵測到的候選是前端開發伺服器（vite、next、astro、webpack-dev-server）時預設關閉，它們自帶熱更新；其他預設開啟。
- 監看 `cwd` 下符合 `include` 的檔案（預設依候選類型，例如 Python 為 `**/*.py`），排除 `exclude`（一律加上 `node_modules`、`.git`、`dist`、`build`、`.venv`、`__pycache__`、`.yeschef`）。
- 變動後等 1 秒沒有新變動才重啟（防抖），重啟期間狀態為 `restarting`。
- 重啟後瀏覽器不自動重新整理，畫面提示「服務已重啟」與一個重新整理按鈕。

## 6. 保護

### 6.1 擋下停止受管服務的指令

在工具批准的共同關卡（`permissions.registry()` 包住的 `requestApproval`，Claude、Codex 升權、Grok 都經過這裡）加一條規則：Bash 類工具的指令若會停止受管服務，直接拒絕並回覆「這是 YesChef 管理的執行中服務，請使用者在『執行』面板操作」。判斷包含：

- `kill`、`kill -9` 後接受管服務的 pid 或 `-<pgid>`。
- `pkill`、`killall` 後接的名稱符合受管服務的程序名稱或指令。
- 含受管服務連接埠的 `lsof`／`fuser` 並接 `kill`、`xargs kill`、`fuser -k`。
- Grok 的請求以 `rawInput` 取指令文字。

判斷寫成純函式（輸入指令文字與受管服務清單），測試涵蓋上列寫法與不應誤擋的寫法（例如只是查詢 `lsof -i :3000`）。

### 6.2 已知繞過與第二層

文字比對擋不住所有情況：專案自己的 `.claude/settings*.json` 若以 `permissions.allow` 放行 Bash，SDK 不會詢問；Codex 在沙箱內執行的指令不經批准；腳本也可以間接停止程序。因此加上第二層：

- 受管服務在使用者沒有按停止的情況下結束時，記錄結束時間與結束碼，並在專案群組發一則訊息（含當時正在執行的工作者名稱）。
- 自動重啟，5 分鐘內最多 3 次；超過則狀態為 `failed`，等使用者處理。

## 7. 畫面

- 標題列新增「執行」按鈕（在「測試機」旁），沒有選取專案時停用。
- 按下時：
  - 沒有設定 → 開啟設定對話框（候選清單、可編輯欄位、保存並執行）。
  - 已設定且已停止 → 直接執行。
  - 執行中 → 開啟執行面板（狀態、網址、停止、重啟、在右側打開、紀錄、編輯設定）。
- 執行面板的紀錄區顯示最後 200 行，可捲動，提供「開啟完整紀錄檔」。
- 文字沿用既有元件與語氣；繁體中文台灣用語。

## 8. 相容性

- `ProjectEntry` 不變；設定另存檔案，舊資料不需遷移。
- 沒有使用「執行」的專案，行為與現在完全相同。
- 新的批准規則只在有受管服務執行時生效，且只拒絕停止受管服務的指令。

## 9. 驗收

- 單元測試：候選偵測（3.2 每一列）、連接埠判斷、指令保護規則（6.1，含不應誤擋）、狀態機、重啟防抖、自動重啟次數上限。
- 整合測試（真實子程序）：用一支小型 HTTP 伺服器腳本當專案，驗證啟動、準備好判斷、停止後程序群組沒有殘留、連接埠被佔用時的處理、檔案變動重啟、非預期結束後自動重啟。
- 實機驗收（`npm run verify project-run`，兩次）：以暫時的 user-data 與暫時專案啟動 YesChef，按「執行」→ 偵測到候選 → 保存 → 右側瀏覽器打開服務頁面；修改檔案後服務重啟；請一個 Claude 對話執行停止服務的指令，被拒絕且服務仍在；從外部 kill 服務後自動重啟並在群組留下訊息；結束 YesChef 後服務停止。

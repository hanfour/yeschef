# 共用 Skills 管理驗收（2026-09-21）

## 結果

YesChef 標題列已新增 Skills 管理入口，可貼 GitHub URL、讀取候選、查看內容、選取安裝、檢查更新、啟用／停用與確認移除。原生 browser view 在管理視窗開啟時隱藏，不會覆蓋操作畫面。

實際共用庫已安裝並啟用 `emil-design-eng`，來源 `emilkowalski/skills`，commit `85e8e2363b713506e1d5b6e07a0eb2da66be1bc3`。同 repository 的 13 個 skills 可被列出，只安裝所選項目。先前使用者目錄及 `.claude/skills` 的手動安裝未被覆寫或刪除。

使用說明與限制見 [SHARED-SKILLS.md](SHARED-SKILLS.md)。

## 測試

- `npm run typecheck` 通過。
- 全套 `npm test`：104 files／2239 tests 通過。初次全套有一個既有翻譯秒數測試時序失敗，加入 React `act` 包住假時鐘推進後，全套通過；未更改翻譯產品行為。
- 後續加入 preload／App 整合及 Git blob 雜湊檢查，最後定向執行 skills-github、skills-service、skills-manager、preload-bridge、app：5 files／64 tests 全過，不重複累加為全套數量。
- `npm run build` 通過。實機曾發現 Zod 被 externalize，sandbox preload 無法 require；已明確將 Zod 打包進 preload，最終 IPC 正常。建置仍有 Zod 第三方 PURE 註解提醒。
- 安裝測試覆蓋固定版本讀取、資源保留、大小／串流限制、hash 不符、錯誤 URL／HTTP、失敗不破壞舊版本、名稱衝突、路徑跳脫、符號連結、巢狀 skills、並發管理序列化與壞狀態檔不覆寫。
- 載入測試覆蓋 Codex thread/start 及 resume 前註冊 roots、舊 API 明確失敗、兩個 Claude project factory 共用快照且不啟用 user 層權限設定。

## 真實原生載入

從實際 YesChef 共用庫取得快照，分別在 `/private/tmp/yeschef-skills-provider-projects/project-a` 與 `project-b` 執行原生清單查詢，沒有發送模型任務：

| Agent | 專案 A | 專案 B |
| --- | --- | --- |
| Codex CLI 0.154.0 | `skills/extraRoots/set` 後 `skills/list` 包含 enabled 的 `yeschef-shared:emil-design-eng`，path 指向 YesChef 快照 | 相同 |
| Claude SDK 0.3.258 | 本機 plugin＋project/local settings，`supportedCommands()` 包含 `yeschef-shared:emil-design-eng` | 相同 |

首次 probe 只比對裸 skill 名稱，誤判找不到；修正為原生 plugin 名稱空間後，上述四個組合均通過。來源 SKILL.md 本身沒有改名，兩種 agent 使用相同內容。這是原生發現驗證，不宣稱已在每個模型、每個歷史會話重新執行該 skill。

## 實際畫面與操作

在運行中的 YesChef Electron 操作真正的標題列／dialog／IPC：

1. 貼 `https://github.com/emilkowalski/skills.git`，列出 13 個候選，選 `emil-design-eng` 並安裝。
2. 已安裝卡顯示來源、`85e8e236`、啟用狀態及對話使用名稱。
3. 停用後再啟用、檢查更新顯示已是最新，最終保留啟用。
4. 非 GitHub URL 明確拒絕；既有安裝仍存在。
5. 確認移除後清單歸零，再由新 HTTPS 流程重新安裝成功。
6. 重啟工作台後已安裝項目仍保留；兩個既有專案（demo-app、chat-bot）保持原狀，重啟時皆無忙碌會話。
7. 480px 視窗內 dialog clientWidth／scrollWidth 同為 442px；未水平溢位。

| Before | After | Why |
| --- | --- | --- |
| 只能由 agent 手動安裝到各 provider 目錄 | 單一 Skills 入口與來源／版本卡 | 清楚知道哪些項目由 YesChef 共用管理 |
| 長 repository 清單拉得很長 | 候選清單有獨立捲動高度，標題與關閉鈕固定 | 容易完成選取並找到安裝操作 |
| 勾選等待磁碟寫入時短暫彈回 | 即時 pending 勾選，失敗回復 | 操作回饋與實際儲存結果一致 |

畫面遵循 emil-design-eng 的即時互動、明確狀態、低干擾動效與可讀性原則；沒有替常用鍵盤操作加入動畫。

截圖未收錄。

## 尚未涵蓋

私人 repository 認證、GitHub 以外來源、進行中對話熱替換、舊快照自動回收不在本輪。停用／移除僅作用於共用庫的新快照，不撤回已進入既有會話上下文的內容，也不管理使用者原有的個人／專案 skills。

## 2026-10-02 共用 Skills provider 擴充

新快照分成 `claude/`、`codex/`、`grok/`，Claude 與 Grok 各有 `.claude-plugin/plugin.json`，Codex 只包含 `skills/`。各執行者的 Markdown 依四個固定變數產生自己的內容，原始 package 維持不變。讀取舊格式快照時沿用根目錄 Claude plugin 與 `skills/` 路徑，該快照不提供 Grok plugin；下一次啟用、停用、安裝或移除會產生新格式。

安裝預覽按 skill 列出未知變數警告，並顯示三個執行者的叫用方式。Grok 對話啟動時才加 `--plugin-dir`，未啟用共用 Skills 時不帶此參數。repo 內的 Grok 程式、測試 fixture 與既有 runtime 規格沒有提供終端工具名稱；`rg -n -i 'run_terminal_command|shell_tool|terminal command|terminal_command|plugin-dir|pluginDir' src tests docs/specs` 只找到新規格列出的 `run_terminal_command`，因此先採此值，待控制端實機確認。

### 自動驗收

- `npm run typecheck`：通過，`tsc --noEmit` 結束碼 0。
- `npx vitest run --configLoader runner --exclude tests/chef-view-tools.test.ts --exclude tests/grok-view-tools.test.ts --exclude tests/terminal-server.test.ts --exclude tests/view-tools-http-server.test.ts`：181 個測試檔通過、1 個 skip；3174 個測試通過、1 個 skip，結束碼 0。
- 一般 `npx vitest run` 因 `node_modules` symlink 無法建立 `node_modules/.vite-temp`，回報 `EPERM`。改用上述 `--configLoader runner` 後全套指定測試成功。
- `git diff --check`：通過，沒有空白錯誤。

### 待實機驗收

本次環境不能啟動 Electron 或 Grok CLI，也不能執行 listen 型測試，未做 UI 操作或截圖。控制端仍需確認 Grok 的 `--plugin-dir` 實際載入、Grok 叫用寫法、`run_terminal_command` 工具名稱、使用者自己的 Grok skills 與 plugins 是否照常可用，以及三個執行者各重複兩次的共用 skill 載入與叫用流程。四個被排除的 listen 型測試為 `chef-view-tools`、`grok-view-tools`、`terminal-server` 與 `view-tools-http-server`。

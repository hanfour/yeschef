# YesChef 共用 Skills

按標題列的 **Skills**，貼上公開 GitHub repository 網址，按「讀取 Skills」。勾選要使用的項目，可先展開「查看 SKILL.md」，再按「安裝／更新選取項目」。

共用庫會顯示來源、固定 commit 版本與啟用狀態。所有專案的新 Codex／Claude 對話都能使用啟用的 skills；已在進行中的對話保留原有檔案版本。需要最新設定時，開一個新對話。

例如 `emil-design-eng` 的共用名稱為 `yeschef-shared:emil-design-eng`，可在對話中指定該名稱。使用者或專案原有的 skills 仍照原設定載入，共用庫只管理 YesChef 的命名空間。

## 管理操作

- **檢查更新**：讀取原來源與 ref。版本相同時顯示已是最新；有更新時顯示可檢視的內容，按安裝／更新後才套用。
- **啟用／停用**：決定新對話載入哪些 skills。操作立即反映勾選狀態，儲存失敗會恢復原狀並顯示錯誤。
- **移除**：確認後從共用庫移除。進行中的對話使用過的快照暫時保留，避免其引用的檔案突然消失。
- **重新整理**：重新讀取已安裝清單。

## 本版支援範圍

支援 `https://github.com/owner/repo`、`.git` 結尾，以及 `/tree/ref/skill-directory`。含斜線的 ref 須 URL 編碼，例如 `feature%2Fdesign`。目前僅支援公開 repository；遇 GitHub rate limit 或網路錯誤可稍後重試。

Skills 必須有 YAML frontmatter 的 `name` 與 `description`。不安裝含 hooks／allowed-tools／YAML 合併的 skill，不匯入 repository 的 hooks、MCP 或權限設定；腳本與參考檔可以隨 skill 保存，但安裝時不執行它們。執行期的工具批准仍由 YesChef 管理。

限制：單個 SKILL.md 256KB；單檔 2MB；單個 skill 1000 檔／10MB；一次選取總計 40MB；候選最多 100 個。符號連結、子模組、跳脫目錄、大小寫衝突與巢狀 SKILL.md 會拒絕。來源過大時可使用 tree URL 指定較小目錄。

## 載入方式與儲存

共用庫位於 Electron `userData/shared-skills`，不是使用者的全域 Codex／Claude 設定，也不向各專案複製檔案。

- `packages/<skill-id>/<commit>` 保留來源檔案。
- `revisions/<uuid>/skills` 是一次完整的啟用快照，旁邊只有 YesChef 產生的 `.claude-plugin/plugin.json`。
- `index.json` 用暫存檔＋rename 原子切換，失敗不發布半套版本。程序內管理操作依序執行。
- Codex 啟動 thread 前呼叫 `skills/extraRoots/set` 指向快照。舊 CLI 不支援時明確回報更新需求，不默默省略 skills。
- Claude 的 session options 注入本機 plugin 路徑，仍使用 `permissionMode: default` 與 `settingSources: project, local`。

下載只經限定的 GitHub API／raw HTTPS 來源，讀取指定 commit 的內容並核對大小及 Git blob 雜湊。不執行 git checkout、repository 安裝程序或遠端程式碼。

原生介面依據：[Codex App Server](https://developers.openai.com/codex/app-server/) 與 [Claude Agent SDK plugins](https://code.claude.com/docs/en/agent-sdk/plugins)。本機驗證版本為 Codex CLI 0.154.0、Claude Agent SDK 0.3.258。

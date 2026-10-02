# YesChef

桌面工作台：讓 Claude、Codex、Grok 在你的專案裡並排工作，由主廚把目標拆成工作、交給它們，最後驗收成果。

[English](README.md)

## 功能

- **每個專案各自的對話**：以分頁開 Claude、Codex 或 Grok 對話，每個對話有自己的瀏覽器窗格，agent 能看到並操作（點擊、輸入、截圖、讀取頁面）。
- **主廚任務**：交給主廚一個目標，它會規劃、把工作分給適合的執行者，確認每個宣稱完成的結果都引用了確實成功的工具呼叫，並在任務完成前加一道驗收，優先由不是做這份工作的執行者負責。
- **群組頻道**：同一專案的 agent 可以互相提問、回報進度，你可以閱讀也可以加入。
- **由你決定的批准**：修改檔案與執行指令會等你批准，除非你已授權這個專案的這類操作。每次決定都有紀錄。
- **終端、diff、文件**：以 tmux 執行的終端；每個對話改了什麼的 diff（包含巢狀的 repo）；附目錄的文件預覽。
- **測試機**：測試環境的登入資料存一次，agent 透過工具登入，看不到密碼。
- **錯誤收集**：設定一個 MySQL 資料庫，對專案啟用錯誤收集後，主廚會把 [`@yeschef/error-intake`](packages/error-intake) 安裝進專案並開 PR。之後可以在群組頻道把記錄到的錯誤拉出來，交給主廚修正。
- **共用 Skills**：從公開的 GitHub repo 安裝 skill 一次，Claude 與 Codex 對話都能使用。

## 狀態

YesChef 在 macOS 上開發與測試，目前以開發模式從原始碼執行，還沒有打包好的安裝檔。

## 需求

- macOS
- Node.js 24（錯誤收集套件也支援 Node 20）
- 終端分頁需要 [tmux](https://github.com/tmux/tmux)
- Claude 對話需要已登入的 [Claude Code](https://code.claude.com)
- 選用：Codex 對話需要 [Codex CLI](https://github.com/openai/codex)，Grok 對話需要 Grok CLI
- 選用：錯誤收集需要 MySQL 8

## 開始使用

```bash
git clone https://github.com/hanfour/yeschef.git
cd yeschef
npm install
npm run dev
```

從左側窗格加入專案資料夾，再開始對話或打開主廚。

## 開發

```bash
npm run typecheck
npm test
npm run verify -- --list   # 開真實視窗操作的端對端檢查
```

設計紀錄與驗收紀錄在 [`docs/`](docs)，規格在 [`docs/specs`](docs/specs)。

## 套件

| 套件 | 說明 |
| --- | --- |
| [`@yeschef/error-intake`](packages/error-intake) | 把 Express、NestJS、Next.js 應用的伺服器與瀏覽器錯誤記錄到 MySQL，分群並遮罩敏感資料，之後可以拉進 YesChef 修正。 |

## 授權

[MIT](LICENSE)

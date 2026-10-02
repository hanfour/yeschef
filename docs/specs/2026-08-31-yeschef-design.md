# yeschef 設計規格

日期：2026-08-31
狀態：待審
工作名稱：yeschef（可改）

## 1. 問題

在 Claude Code 裡工作時，有三件事會讓人想改開 Claude Desktop：

1. 讓 agent 操作 Chrome 做 E2E 真實測試
2. 產出的 `.md` / `.html` 要能直接預覽
3. 讓不同模型做腦力風暴，並排看分歧

但公司用 Claude Code 與 Codex 的 usage 做每月評量，所以離開 Claude Code 的工作不算數。

三件事在 Claude Code 裡其實都做得到（chrome-devtools MCP、Artifact、自建的 `/decide`），真正缺的是版面：Claude Desktop 是左邊 session、右邊瀏覽器或文件，而 Claude Code 是一個看不到東西的終端機。

VS Code 與 JetBrains 的 Claude Code 擴充提供了類似版面，但在 16 GB M1 上太吃記憶體。

## 2. 限制

| 限制 | 來源 | 影響 |
|---|---|---|
| usage 必須進 Claude Code Insights | 公司評量制度 | 左窗格只能跑真的 `claude` 二進位檔 |
| 記憶體預算緊 | 16 GB M1，兩個 `claude` 程序已佔約 1 GB | 淨增加不得超過 150 MB |
| 瀏覽器要與個人 Chrome 分離 | 不希望 agent 碰到日常分頁與登入狀態 | 獨立 partition |
| 人要能直接操作 agent 的瀏覽器 | 主要需求 | 同一個 WebContents 共用 |
| 只做 macOS | 使用者環境 | 不處理 Windows 與 Linux 建置 |

### 2.1 Insights 的實際資料流（已查證 2026-08-31）

`~/.claude/usage-data/ingest-jsonl.mjs` 掃描 `~/.claude/projects/**/*.jsonl`，那是 `claude` CLI 自己寫的 session 逐字稿，與哪個終端機在跑它無關。`render-full-report.mjs` 產出 `report.html`。

因此只要生的是真的 `claude` 二進位檔，統計照常。

排除規則同時作用在 session cwd 與實際碰到的檔案路徑，超過 50% 落在 `EXCLUDE_PATHS` 就整場不計。**設計限制：app 生 `claude` 時必須用使用者實際工作的專案目錄當 cwd，不可用 app 自身目錄。**

## 3. 不做什麼

### 3.1 被淘汰的方案

**視窗編排（不新增程序）。** 左邊沿用既有 iTerm2，右邊沿用 chrome-devtools-mcp 開的 Chrome，只做視窗並排加一個小型預覽伺服器。新增記憶體約 30 到 50 MB。淘汰理由：使用者選擇整合式外殼，且記憶體差距實際上接近打平（見 3.2）。

**原生外殼（SwiftUI + SwiftTerm + WKWebView）。** 總記憶體約 150 到 250 MB。淘汰理由：WKWebView 在 macOS 沒有 CDP，agent 無法驅動右窗格，需求只滿足一半。

### 3.2 記憶體帳

| 項目 | 現況 | 本設計 |
|---|---|---|
| 終端機 | iTerm2 313 MB | Electron 底層 200 到 300 MB |
| `claude` CLI | 480 到 530 MB | 不變 |
| 瀏覽器 | chrome-devtools-mcp 的 Chrome 350 到 700 MB | WebContentsView 350 到 700 MB |
| 淨變化 | | 約 −110 到 +10 MB |

瀏覽器那筆在兩種方案都要付。VS Code 的 600 MB 到 1.5 GB 來自擴充主機與各種 language server，不是 Electron 本身。

### 3.3 明確不做的功能

分頁管理、書籤、下載管理、瀏覽歷史、多視窗、擴充系統、雲端同步、多 LLM provider 適配層（agent 是 Claude Code，不需要）。

## 4. 架構

```
┌─ Electron 主程序 ─────────────────────────────────────┐
│                                                       │
│  ┌── 左窗格 ─────────┐  ┌── 右窗格 ────────────────┐  │
│  │ xterm.js          │  │ WebContentsView          │  │
│  │  └─ PTY 子程序    │  │  partition: persist:agent│  │
│  │     真的 claude   │  │  無 preload              │  │
│  │     cwd = 使用者  │  │  webContents.debugger    │  │
│  │     的專案目錄    │  │  （Electron 內建 CDP）   │  │
│  └───────────────────┘  └──────────────────────────┘  │
│                                                       │
│  MCP server（stdio）← claude CLI 連進來               │
└───────────────────────────────────────────────────────┘
```

### 4.1 四個架構決定

**左窗格跑真 `claude` 二進位檔，不用 Agent SDK 重寫介面。** 前提見 2.1。

**右窗格用 `WebContentsView`。** `BrowserView` 自 Electron 30 起 deprecated，`<webview>` 官方勸退且不保證未來版本存在。獨立 `persist:agent` partition，不與個人 Chrome 共用 cookie。不給 preload，內容由主程序主動取。

**agent 驅動右窗格用 `webContents.debugger`（Electron 內建 CDP）。** 不外掛第二個 Chromium，省下約 179 MB 發布檔與另一份 250 到 400 MB RAM。

**app 自建 MCP server，claude CLI 連入。** agent 呼叫的是「操作右窗格」而非「開一個新瀏覽器」。人與 agent 操作同一個 WebContents，不需要額外同步機制。

生程序時用 `claude --mcp-config <json>` 傳入本 app 的 MCP server 設定（已查證該旗標存在）。**不可加 `--strict-mcp-config`**，那會關掉使用者既有的 per-project MCP 設定（serena、chrome-devtools、context7 等）。

## 5. MCP 介面

| 工具 | 用途 |
|---|---|
| `view_navigate(url)` | 導航 |
| `view_snapshot(scope?)` | 回傳結構，預設只回可視範圍 |
| `view_screenshot()` | 結構不足時的備援 |
| `view_click(ref)` | 點擊 snapshot 提供的 ref |
| `view_type(ref, text)` | 輸入 |
| `view_press(key)` | 按鍵 |
| `view_eval(js)` | 逃生艙，E2E 需要 |
| `preview(path \| html)` | 顯示本地 `.md` / `.html`，檔案變動自動重載 |
| `request_handoff(reason)` | 阻塞式交還控制權 |

多模型並排輸出不是獨立工具，是 `preview(html)` 的一種內容。

### 5.0 ref 的生命週期

`view_snapshot` 回傳的每個 ref 綁定該次 snapshot 的 id。`view_click` / `view_type` 帶著 ref 呼叫時必須同時帶 snapshot id。

若使用者在兩次呼叫之間直接操作了頁面，該 snapshot 已失效，工具回傳明確錯誤要求重新 snapshot，而不是對可能已經換位置的元素盲點。這是人機共用同一個 WebContents 的直接後果，必須顯式處理。

### 5.1 snapshot 預設限定範圍

量測依據：1280×800 截圖固定 1,334 token；未過濾的無障礙樹在簡單頁上已 5,951 token，且隨節點數線性成長。限定範圍的實測效果是 16,006 token 降到 481。

因此 `view_snapshot()` 預設只回目前可視範圍，給 `scope` 選擇器才擴大。截圖是備援不是預設。

回傳格式是無障礙樹，每個可操作節點帶角色、可及名稱、與一個 ref。不回傳原始 DOM。

代價：agent 偶爾看不到畫面外的元素，需要多一次呼叫。

## 6. 人機交接

### 6.1 agent 交給人（阻塞式）

agent 呼叫 `request_handoff(reason)`，右窗格頂端出現橫幅與「我好了」按鈕，tool call 阻塞等待。使用者完成後點按鈕，工具回傳當下頁面狀態，agent 繼續。

適用：CAPTCHA、雙因素驗證、需要人判斷的分支。這是內建瀏覽器相對外掛 headless 的唯一結構性優勢。

逾時上限 10 分鐘。逾時後回傳當下的頁面狀態並標註「已逾時，使用者未按確認」，而不是回錯誤，因為常見情況是使用者已經做完只是忘了按按鈕。agent 收到後應先 snapshot 確認狀態再決定要不要繼續。

### 6.2 人插手，agent 自行發現

使用者可隨時直接在右窗格操作，不需事先宣告。app 記錄兩次 agent 操作之間的使用者互動，下一次 `view_snapshot` 回傳前綴一行摘要，例如「使用者在你上次操作後點了 3 次，目前網址已變成 X」。

## 7. 錯誤處理

| 情況 | 處置 |
|---|---|
| 跨站 iframe 未附著 | `Target.setAutoAttach` 加 `flatten: true`。snapshot 必須標出「有 N 個 iframe 未附著」，寧可讓 agent 知道自己看不到 |
| 頁面未就緒就操作 | `view_click` 後自動等網路靜默或逾時，逾時回錯誤而非回成功 |
| 右窗格被關閉 | 所有 view 工具回明確錯誤說明視窗不存在 |
| `claude` 子程序結束 | 保留終端機輸出，提供重啟，不自動重生 |
| MCP server 斷線 | 記錄並在 UI 顯示，不靜默失敗 |

## 8. 驗證計畫

三個 spike 全數通過才開始寫產品程式碼。合計約 6 天。

### Spike 1：外殼骨架與記憶體（2 天）

最小 Electron，左邊 xterm.js 加 PTY 跑真 `claude`，右邊 `WebContentsView` 載入一個重的網頁。

驗兩件事。TUI 可用性：plan mode、`ctrl+O`、貼多行、視窗 resize，畫面不得錯亂。記憶體：相對「iTerm2 加 chrome-devtools-mcp 的 Chrome」的淨變化，判準不超過 +150 MB。

### Spike 2：右窗格無焦點時的 CDP 輸入注入（2 天）

左右窗格在同一個 Electron 視窗內，使用者在左窗格打字時視窗聚焦但右窗格不聚焦。Electron 文件明載 `sendInputEvent` 需要焦點，CDP `Input.*` 是否繞得過去未經官方確認。

測三種狀態各 200 次：右窗格聚焦、使用者在左窗格打字、整個視窗被其他 app 遮蔽。

判準：後兩種狀態的注入成功率須達 99%。

未通過時的降級方案（現在就定，不留到事後）：agent 執行 view 工具期間，主程序主動把焦點移到右窗格並在左窗格顯示「agent 操作中」的遮罩，操作結束後把焦點還給左窗格。代價是 agent 跑的時候不能在左邊打字，但行為是可預期的，不會出現靜默失敗。

### Spike 3：跨站 OOPIF 的 CDP 覆蓋率（2 天）

Electron 強制 strict site isolation，金流與 SSO 登入框為跨站 OOPIF。單一 CDP session 會靜默看不到，agent 會誤判成功。

用 `Target.setAutoAttach` 加 `flatten: true` 對 5 個真實站量覆蓋率，門檻 95%。

## 9. 測試

MCP 工具層對一組固定的本地 HTML fixture 做端到端測試，不打外網，不需要 LLM 參與（直接呼叫工具、斷言回傳）。CI 可跑，且不因外部網站改版而失敗。

TUI 沒有合適的自動化方式，靠 Spike 1 的手動檢查與錄影。

## 10. 交付形式

v1 不簽章、不公證、不做安裝檔。`npm run build` 加本地執行。

省下約 7 人天的出貨管線、公證排隊的不可控風險（正常 5 到 15 分鐘，新帳號首次提交會被列為深度分析，2026 年有卡 24 到 72 小時的回報）、以及每年建置費用。

開源指的是公開 repo，不是把安裝檔交給陌生人。要讓他人安裝屬於 v2 決定。

## 11. 已知風險與未決事項

| 項目 | 狀態 |
|---|---|
| Spike 2 未通過時使用者不能邊跑邊打字 | 降級方案已定（見 §8），屬可接受的功能減損 |
| Spike 3 覆蓋率若低於門檻 | 未定。可能需要限制 E2E 情境不涵蓋跨站金流頁 |
| 專案名稱 | 工作名稱 yeschef，未定案 |
| 若專案置於 `~/Projects/` 並比照排除，開發它本身不計入評量 | 已知，屬使用者政策選擇 |

### 已解決（原列為未決）

- `claude` CLI 傳入 MCP 設定：`--mcp-config` 已確認存在，不可配 `--strict-mcp-config`
- `request_handoff` 逾時：10 分鐘，逾時回狀態不回錯誤
- `.md` 渲染器：markdown-it，需要時再加程式碼高亮與 mermaid 外掛
- snapshot 格式與 ref 生命週期：無障礙樹加 snapshot id 綁定

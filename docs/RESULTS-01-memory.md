# Spike 1 結果：記憶體與 TUI 可用性

量測日期：
機器：
量測方法：`ps -Ao rss,comm,command` 依命令列分組加總，穩定 60 秒後取值

## 區塊 1：記憶體

### 量測步驟

#### 基準線量測
1. 開啟 iTerm2，執行 `claude`（或任何使用 claude CLI 的方式）
2. 另外開啟 chrome-devtools MCP 的 Chrome（或用 cdp 工具啟動），導到一個複雜網頁
   - 建議使用 `https://www.notion.so` 或類似複雜頁面
3. 等 60 秒讓記憶體穩定
4. 執行 `npm run spike:memory`
5. 記下「基準線 iTerm2」與「基準線 chrome-devtools-mcp 的 Chrome」兩列的數字
6. **健全性檢查（本階段）**：確認「基準線 iTerm2」與「基準線 chrome-devtools-mcp 的 Chrome」兩列都**非 0 MB 且程序數 > 1**（若 Chrome 那列是 0 MB，可能是用 `--isolated` 啟動，改用常規 `chrome-devtools-mcp/chrome-profile` 重新量）。任一項是 0 MB 或個位數，表示比對字串失效，此次量測無效，先修腳本再量。這個階段 yeschef 還沒啟動，「yeschef」與「claude CLI」兩列必然是 0 MB，這是正常現象，不代表量測無效。

#### yeschef 量測
1. 關掉前面的 iTerm2 與 Chrome
2. 開啟 yeschef：`YESCHEF_PROJECT_DIR=$HOME/你的專案 npm run start`（把路徑換成你實際要工作的專案目錄；不可留空，留空 yeschef 不會 spawn claude，左窗格只會印出提示，見規格 §2.1）。也可以用同樣的環境變數直接開啟編譯後的應用
3. 在右格導到**同一個網頁**（與基準線相同的 URL）
4. 在左格執行 claude 並送出一個會產生輸出的問題
5. 等 60 秒讓記憶體穩定
6. 執行 `npm run spike:memory`
7. 記下所有四個組別的數字
8. **健全性檢查（本階段）**：確認「claude CLI」與「yeschef」兩列都**非 0 MB 且程序數 > 1**。任一項是 0 MB 或個位數，表示比對字串失效，此次量測無效，先修腳本再量。

不要寫死跟環境綁死的絕對數字區間（例如「數百 MB」「實測約 X 到 Y MB」）——這類數字會隨機器、Electron 版本、是否起 GPU 程序漂移，上一版文件寫的區間審查時已經對不上實測，判準一律用「非 0 且程序數 > 1」。

### 量測結果

| 組別 | RSS |
|---|---|
| 基準線 iTerm2 | ___ MB |
| 基準線 Chrome（chrome-devtools-mcp profile） | ___ MB |
| 基準線合計 | ___ MB |
| yeschef 全部程序（含 dev 工具） | ___ MB |
| 其中 electron-vite（dev 專用，打包後不存在） | ___ MB |
| claude CLI（兩種情境相同，不計入差額） | ___ MB |
| **淨變化（含 dev 工具鏈）** | **___ MB** |
| **淨變化（扣除 electron-vite，推估打包後的實際佔用）** | **___ MB** |

### 判準

判準 +150 MB **應以「扣除 electron-vite」那一列為準**，因為那才是產品實際出貨時的佔用。含 dev 工具鏈的數字一併記錄，供開發期參考。

- 扣除 electron-vite 的淨變化：通過 / 未通過
- 實際淨變化（含 dev 工具）（MB）：
- 實際淨變化（扣除 electron-vite）（MB）：

---

## 區塊 2：TUI 可用性檢查表

| # | 檢查項 | 結果 | 現象 |
|---|---|---|---|
| 1 | 左格出現 claude 的歡迎畫面，可以正常對話 | ✓ / ✗ | |
| 2 | 進 plan mode，框線與顏色正確，離開後不留殘影 | ✓ / ✗ | |
| 3 | 按 `ctrl+O` 展開思考內容，捲動正常 | ✓ / ✗ | |
| 4 | 貼上十行以上的文字，不會被逐行送出 | ✓ / ✗ | |
| 5 | 拉動視窗改變寬度，終端機重排且 claude 畫面跟著重繪不錯位 | ✓ / ✗ | |
| 6 | 在左格打字的同時，右格的網頁仍可用滑鼠點 | ✓ / ✗ | |
| 7 | 關閉視窗後 `ps aux \| grep claude` 確認子程序已被收掉 | ✓ / ✗ | |

---

## 區塊 3：外殼與隔離檢查表

| # | 檢查項 | 結果 | 現象 |
|---|---|---|---|
| 1 | 左右兩格各佔一半，中間沒有縫也沒有重疊 | ✓ / ✗ | |
| 2 | 拉動視窗大小，兩格跟著變，比例維持 0.5 | ✓ / ✗ | |
| 3 | 右格顯示 example.com 的內容 | ✓ / ✗ | |
| 4 | 在右格直接用滑鼠點連結，頁面會導航 | ✓ / ✗ | |
| 5 | partition 隔離：右格設的 cookie 不出現在日常 Chrome | ✓ / ✗ | |
| 6 | `titleBarStyle: 'hiddenInset'` 搭配兩個 view 都從 y:0 起算，macOS 紅綠燈按鈕是否疊在左窗格內容上 | ✓ / ✗ | |

### 第 5 項詳細做法（Cookie 隔離驗證）

1. 在 yeschef 右格導到 `https://example.com`
2. 暫時在 `src/main/index.ts` 中加入以下行（找到建立 `agentView` 的地方）：
   ```typescript
   agentView.webContents.openDevTools()
   ```
3. 重新啟動應用，右格會自動打開開發者工具
4. 在 DevTools Console 執行：
   ```javascript
   document.cookie = "probe=1"
   ```
5. 驗證隔離（按順序執行）：
   - 在 DevTools Console 執行 `document.cookie`，確認看到 `probe=1`
   - 關閉 yeschef
   - 開啟日常 Chrome 並導到 `https://example.com`，查看網站 Cookie（F12 → Application → Cookies），確認**沒有** `probe=1`
   - 重新開啟 yeschef，在 DevTools Console 執行 `document.cookie`，確認 `probe=1` **仍然存在**
6. 驗證完後刪掉 `openDevTools()` 那一行

### 第 6 項詳細做法（macOS 紅綠燈檢查）

1. 開啟 yeschef
2. 查看左上角 macOS 標題欄的紅綠燈按鈕
3. 確認按鈕**是否疊在左窗格內容上**（預期：應該在最上面，不應該被終端內容遮蓋）
4. 記錄觀察結果

---

## 區塊 4：審查累積的待確認項

| # | 項目 | 來源 / 背景 | 驗證步驟 | 結果 |
|---|---|---|---|---|
| 1 | node-pty 的原生模組跟目前 Electron 版本相容 | node-pty 1.1.0 走 N-API 有 prebuild，即使沒重建也可能會動，只在 Electron 升版後才露餡 | 跑 `npx electron-rebuild -f -w node-pty`，然後用區塊 1「yeschef 量測」步驟 2 的方式啟動 app，確認左窗格出得來、能正常對話。若 ABI 不符，`index.ts` 的 PTY 啟動失敗會被寫進終端機給人看（不是只進 console），可據此判斷 | ✓ / ✗ |
| 2 | renderer 是否真的畫得出畫面（先前只有程式碼層級確認） | 無 GUI 證據，需實測 | 啟動應用後檢查左窗格是否實際顯示終端內容，不只是代碼存在 | ✓ / ✗ |
| 3 | dev 模式重新載入時，是否出現假的「claude 已結束」訊息 | `did-finish-load` 重複觸發時舊世代 PtyHost 的 onExit closure 會誤報 | 1. `YESCHEF_PROJECT_DIR=$HOME/你的專案 npm run dev` 啟動 2. 在 renderer 觸發一次重新載入（通常是 Vite 的熱更新） 3. 檢查左窗格是否跳出「[claude 已結束，代碼 N]」訊息但 claude 其實還活著 | ✓ / ✗ |

### 第 3 項詳細操作步驟

1. 執行 `YESCHEF_PROJECT_DIR=$HOME/你的專案 npm run dev`，等待應用啟動
2. 在左格執行 `claude` 並開始互動
3. 修改 `src/` 中的任何文件（例如 `src/renderer/index.html` 加個空格）
4. 等待 Vite 偵測到變化並進行熱載入
5. **觀察左窗格**：檢查是否突然出現「[claude 已結束，代碼 N]」訊息
6. **驗證**：從日常 Terminal 執行 `ps aux | grep claude`，確認 claude 程序仍在運行（如果真的還在，表示訊息是假的）

---

## 結論

所有區塊檢查完成後，填入以下總結：

- 記憶體判準通過：
- TUI 可用性：___ / 7 項通過
- 外殼與隔離：___ / 6 項通過
- 審查累積項：___ / 3 項通過

### 決策

（根據上述數據，決定專案是否繼續推進）

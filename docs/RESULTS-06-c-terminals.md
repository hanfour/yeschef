# 子專案 C 終端機實機驗收結果

量測日期:2026-09-07
機器:macOS 26.6.2(Darwin 25.6.0)、arm64
Node 24.18.0 / Electron 44(Chrome 152)/ node-pty 1.1.0

## Task 0:node-pty 地基

| 項目 | 結果 |
|---|---|
| node-pty 版本 | 1.1.0(N-API prebuild) |
| 要不要 electron-rebuild | **不要**。node-pty 1.x 是 N-API,prebuild 的 `pty.node` 在 Electron 44 直接載入,沒有 ABI 錯 |
| 實際卡住的地方 | `prebuilds/darwin-arm64/spawn-helper` 的執行位元被 npm 的 allow-scripts 剝掉,`pty.spawn` 報 `posix_spawnp failed` |
| 修法 | `scripts/fix-node-pty.mjs` 對 spawn-helper `chmod 755`,掛 `postinstall` 與 `npm run rebuild:native`,install 後跑一次 |
| spike 結果 | 主行程用 node-pty spawn zsh、送 `echo PTY_OK\r`,console 得到 `[probe] contains PTY_OK: true` |
| grok 的 CLI 指令 | 待 Task 6 實機確認(快捷暫用 `grok`,不同就改 LeftPane.tsx 的 QUICK_LAUNCH 一行) |

electron.vite.config.ts 的 main 加了 `externalizeDepsPlugin()`,讓 node-pty 與 ws 不被 rollup 打包。

## Task 6:分頁與終端機實機驗收

量測方式:`YESCHEF_PROJECT_DIR=/tmp/yeschef-c electron . --remote-debugging-port=9333` 開實機,用 CDP 驅動左窗格(點快捷、切分頁、對 xterm 的 helper textarea 送 `Input.insertText` 與 Enter),用 `Page.captureScreenshot` 讀畫面(xterm 用 DOM renderer,`.xterm-rows` 的 innerText 讀不到,一律以截圖為準),用 `ps`／`lsof` 查程序與埠。

| 步驟 | 結果 | 佐證 |
|---|---|---|
| 1 app 開起來、左窗格 Claude 對話分頁 | ✓ | 分頁列有「Claude 對話」加 claude/codex/grok/zsh 四個快捷,composer placeholder 正常,Recents 載入,右窗格 about:blank(B 瀏覽器) |
| 2 開終端跑指令 | ✓ | 按 zsh:開終端分頁、xterm 掛載,打 `echo hi` 得到 `hi`;按 codex:分頁裡 codex 起來(顯示 Update available 選單與 Press enter to continue) |
| 3 resize reflow | ⚠️ 見下 | 全鏈已接線且會觸發,host 隨窗寬變動,但自動化下精確 col 數量測不穩 |
| 3 關分頁與清理 | ✓ | 開兩個終端(pty 2 個),關 codex 分頁 pty 剩 1、關 zsh 剩 0,`ps` 無孤兒;關掉 active 終端後切回 Claude 對話 |
| 4 只綁 127.0.0.1 | ✓ | terminal 埠 `lsof` 顯示 `127.0.0.1:<port>`;從本機 LAN IP 192.168.1.61 連該埠被拒,127.0.0.1 連得上 |
| 5 不回歸 | ✓（部分） | Claude 對話分頁正常;草稿保留驗證通過;右窗格瀏覽器活著。B 的 MCP 工具未再經 agent 回合實跑(C 未動 B 的程式) |

### terminal-server 端到端(直接 ws 驗)

用自己的 ws client 連 terminal 埠、送 `open` 再送 `input`,確認伺服器端 node-pty 端到端正常,與 renderer 無關:spawn zsh(cwd `/tmp/yeschef-c`)、`echo PROBE_OK` 有回顯;送 `resize {cols:205}` 後 `echo $COLUMNS` 得 `205`,pty.resize 確實更新 winsize。

### 分頁常駐(切走不卸載)

審查抓到 pane-area 原本用條件渲染,切分頁會卸載子樹:切到終端會清空 Composer 未送出的草稿、切終端會殺掉正在跑的 shell。已改成所有分頁常駐掛載、只切 hidden 可見度(commit 9a21ad5)。實機驗證:在 Claude composer 打草稿後切到 zsh 再切回,草稿完整還在;開兩個終端來回切,兩個 pty 都存活。

### resize reflow 的量測限制

reflow 全鏈是接線好的(Terminal 的 ResizeObserver 觸發 `fit.fit()` 加 `client.resize`,伺服器 `pty.resize` 已直接驗過)。實機改動窗格寬度時 `$COLUMNS` 確實會變(不是凍結),表示這條鏈會觸發。但此環境無法做乾淨的真實視窗縮放來定案精確 col 數:Electron 的 CDP 沒實作 `Browser.setWindowBounds`、`Emulation.setDeviceMetricsOverride` 不會觸發 ResizeObserver、AppleScript 取不到 Electron 的 AX window。用注入 CSS 改窗格寬度會觸發鏈,但 DOM renderer 的字元量測在快速連續 resize 加 p10k 非同步重繪下,量到的 col 數前後不一致。建議人工手動慢速縮放視窗看一次終端是否乾淨 reflow。

實機找到一個單元測試蓋不到的佈局 bug:`.pane-slot` 是 flex row 項目、預設 `min-width:auto`,不會縮到比 xterm 內容窄,視窗變窄時終端橫向溢出而非縮小。已加 `min-width: 0`(commit 1370c9b),host 之後隨窗寬正確縮放。

### grok 快捷

本機未安裝 grok CLI(claude、codex、zsh 都在),無法實跑確認 grok 的實際指令名稱。快捷維持送 `grok`;日後裝了不同 binary 名,改 `LeftPane.tsx` 的 `QUICK_LAUNCH` 一行即可。

### 小結

終端機核心(開、跑 CLI、輸入輸出、跨 model 用快捷、關閉清理、只綁 localhost)實機皆通過;分頁常駐與草稿保留已驗;resize 鏈已接線且會觸發,精確 reflow 待人工複驗;grok 快捷待安裝後確認。

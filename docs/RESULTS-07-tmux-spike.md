# tmux 混合可行性與 C 驗收補洞

量測日期:2026-09-07
機器:macOS 26.6.2(Darwin 25.6.0)、arm64
Electron 44(Chrome 152)/ node-pty 1.1.0 / tmux 3.6a / xterm DOM renderer

對應 roadmap(`docs/specs/2026-09-07-yeschef-roadmap.md`)第 0 項與第 4 項的可行性驗證。

## 1. tmux 混合:程序存活與接回

roadmap 第 4 項的核心假設是「程序存活交給 tmux,不自寫 daemon」。實測方式:在 yeschef 的終端分頁裡開 tmux session 並起一個每秒寫檔的心跳程序,然後關掉終端分頁(pty 被 kill),從外部觀察工作是否存活,再開新分頁 attach 回去。

| 檢查 | 結果 |
|---|---|
| tmux 在 yeschef 終端裡跑得起來 | ✓ `tmux ls` 顯示 `spike: 1 windows (attached)`,`$TMUX` 為 `/private/tmp/tmux-501/default,47264,0` |
| tmux 狀態列與顏色在 xterm 正常 | ✓ 底部綠色狀態列 `[spike] 0:zsh*` 正常;p10k 提示、藍綠配色都正確 |
| 關終端分頁後工作存活 | ✓ 關分頁前心跳 50 行,關後 6 秒 56 行仍在成長;electron 底下 zsh 子程序歸零(pty 確實死了) |
| tmux server 獨立於 Electron | ✓ tmux server 程序 47264 在 pty 死後繼續存在,session 自動轉為 detached |
| 新分頁接回同一 session | ✓ `tmux attach -t spike` 後 `tmux ls` 回到 `(attached)`,心跳全程未斷(最終 215 行) |
| 接回後畫面內容回來 | ✓ tmux 自己重繪,關分頁前的指令、job number `[1] 48136`、`$TMUX` 輸出都在 |

結論:tmux 混合成立。殺掉 yeschef 的終端 pty 不會殺掉工作,新分頁能接回同一個 session 並看到原本畫面。

一個直接影響規劃的推論:**接回不需要自己存 scrollback**。tmux 重繪已提供接回時的畫面連續性,roadmap 第 3 項(有限歷史保存)因此不是接回的前置,只服務「app 完全關閉後仍想讀舊內容」這個較弱的需求。

## 2. C 驗收補洞

| 項目 | 結果 |
|---|---|
| 中文輸入(輸入法送出後的文字) | ✓ `echo 中文輸入測試 繁體字 你好嗎` 與中英數混排都正確回顯,寬字元排版正常 |
| 多行貼上 | ✓ 三行貼上以 zsh 的 bracketed paste 反白顯示,停在提示等 Enter,不逐行自動執行;貼上的中文正常 |
| 記憶體 | 2 個終端分頁加 tmux attach 時,Electron 全樹 RSS 353 MB、主行程 108 MB |

## 3. 尚未驗、需要人工的項目

| 項目 | 為什麼機器測不了 | 怎麼驗 |
|---|---|---|
| 輸入法組字中的行為 | CDP 只能送出「已送出的文字」,注音或拼音組字中的候選視窗無法模擬 | 人工用注音打一段中文,看候選視窗位置與 xterm 游標是否對齊、送出後有無殘字 |
| resize reflow 的精確欄數 | 此環境無法做乾淨的真實視窗縮放(CDP 無 `Browser.setWindowBounds`、`Emulation` 不觸發 ResizeObserver、AppleScript 取不到 Electron 的 AX window) | 人工手動慢速縮放視窗,看終端有沒有乾淨 reflow,細節見 `docs/RESULTS-06-c-terminals.md` |
| grok 的實際 CLI 指令名稱 | 本機未安裝 grok | 裝了之後確認實際指令名稱,不同就改 `LeftPane.tsx` 的 `QUICK_LAUNCH` 一行。缺裝提示本身已實作並驗過(見第 5 節) |

## 4. 終端啟動延遲:先前的判斷是錯的

自動化測試中觀察到「開分頁後約 8 秒內打字不執行」,當時判斷為畫面空白、需要啟動中提示。實機再驗後更正:點下快捷後 0.4 秒截圖,p10k 的 instant prompt 已經畫出提示,畫面不是空白。那 8 秒是 p10k instant prompt 先畫提示、把輸入緩衝起來,等 zsh 讀完 .zshrc(nvm、volta、pyenv、rbenv shims)才重播執行,這是 p10k 的既定行為,使用者在自己的終端也是同樣體驗,不是 yeschef 的缺陷。

因此 roadmap 第 0 項的這一條由「修缺陷」降為「理解正確行為」。仍保留一個很輕的啟動中遮罩,只覆蓋第一筆輸出抵達前的空白(對沒有 instant prompt 的 shell 才明顯),成本是六行程式與一層 wrapper,實測版面未回歸。

## 5. 本輪實作的兩個改動

| 改動 | 做法 | 驗證 |
|---|---|---|
| 快捷指令缺裝提示 | `terminal-server.ts` 新增純函式 `findInPath`,open 帶 command 時查 PATH;查不到先送一行繁中 output 再照送指令(有 shell 別名時仍能執行) | 單元測試 7 條(含只查第一個詞、不阻擋送出);實機點 grok 顯示「[yeschef] PATH 中找不到 grok,若尚未安裝請先安裝。」後接 shell 自己的錯誤 |
| 終端啟動中遮罩 | `Terminal.tsx` 以「收到第一筆輸出」為訊號,之前蓋一層提示;`Terminal.css` 加 wrapper 並補 `min-width: 0` | 實機 host 800×833 與 slot 一致,版面未回歸;p10k 環境下遮罩約 0.2 秒後消失 |

順帶修一條既有的脆弱測試:`markdown-stream.test.ts` 的全前綴掃描單獨跑 2.7 秒,全套平行時會超過 vitest 預設 5 秒逾時,已明確給 30 秒並更新過時註解。

## 6. 對規劃的影響

- roadmap 第 4 項的 tmux 假設已驗證,可以照計畫走,不必自寫 daemon。
- roadmap 第 3 項(有限歷史保存)降級:不是接回的前置,只服務 app 完全關閉後讀舊內容。
- roadmap 第 0 項:缺裝提示已完成;啟動延遲一條更正為 p10k 的正常行為,不列為缺陷。剩下待人工驗的是輸入法組字與 resize 精確欄數。

## 7. 接線驗收(2026-09-09)

roadmap 第 4 項的 tmux 半邊接進 yeschef。每個終端分頁一個 tmux session,名字 `sp-<tabId 前 8 碼>`,
tabId 是狀態檔裡持久化的 UUID,所以重開 app 後同一個分頁拿到同一個名字。`open` 訊息多帶 `tabId`;
主行程 PATH 有 tmux 就 spawn `tmux new -A -s <名字>`,先用 `has-session` 判斷存不存在,只有新建時才送
快捷指令(接回既有 session 不重送,roadmap 第 3 項的「還原不自動重跑舊指令」)。沒有 tmux 時照舊起裸 shell,
先送一行提示。使用者按 × 關分頁或移除專案時,主行程 `kill-session`;socket 斷線不殺。

實機(macOS 26.6.2、tmux 3.6a、Electron 44):

| # | 檢查 | 結果 |
|---|---|---|
| 1 | 按 `zsh` 快捷開分頁 | `tmux ls` 出現 `sp-0a0896b0 … (attached)` |
| 2 | 從外部 `tmux send-keys` 打一個 MARKER,然後 `pkill` 掉整個 app | session 仍在(detached),`capture-pane` 看得到 MARKER |
| 3 | 重開 app | 分頁還原,`tmux ls` 回到 `(attached)`,pane 仍含同一個 MARKER,是同一個 session 不是新的 |
| 4 | 按分頁上的 × | `tmux ls` 不再列出該 session |
| 5 | 主程序 log | 0 個 Error |

單元測試:`tmuxSessionName`、有 tmux 新建／接回兩種、無 tmux 退回、缺 `tabId` 拒絕、`killTmuxSession`
失敗不丟;`projects-ipc` 關分頁與移除專案各通知一次,對話分頁不算。全套 58 檔 1210 個測試綠。

手機接續的前置:這台 Mac 的 Remote Login 目前是關的(`launchctl print system/com.openssh.sshd` 回
`state = not running`),沒裝 Tailscale。同一個 Wi-Fi 之下 `ssh <user>@H4.local` 就夠,不需要 Tailscale;
跨網路才回到 roadmap §2.3 的自持界線問題。

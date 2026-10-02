# 子專案 C:終端機與分頁左窗格

## 0. 這個子專案的位置

yeschef 目前有兩塊已合併進 main:A(Agent SDK 宿主,左窗格的 Claude 對話流)與 B(右窗格瀏覽器,agent 與人共用、agent 用 CDP 操作)。C 把左窗格從「只有 Claude 對話」改成「對話與終端機的分頁容器」,讓一個視窗裡能跑 claude、codex、grok 或任何 CLI,也能直接操作本機終端機。

D(preview 與 markdown 渲染)仍未做。手機遠端網頁 UI 是另一個獨立子專案,不在 C。

## 1. 前提

這個子專案來自實際使用後的發現:使用者每天用 Claude Code 網頁版,因為它的 UI/UX 較好,而且網頁版的 session 也算進公司的月評量(評量掃本地 `~/.claude/projects/**/*.jsonl`,網頁版也寫得到)。於是 yeschef 原本「不能離開 Claude Code」的唯一理由消失了。

追問後,網頁版取代不了、而使用者要的只有兩件:跨 model(claude、codex、grok 換著用)與直接操作本機終端機。這兩件正好是 A 當初為了換來漂亮對話 UI 而拿掉的東西:A 用 Agent SDK 的 `query()` 取代了 xterm.js/PTY,代價是鎖死在 Claude 一個 model、且沒有真終端機。

C 不推翻 A,而是把 A 收成分頁之一,旁邊擺終端分頁。終端機本身就跨 model,不需要為每個 model 寫適配層。

## 2. 範圍

### 2.1 C 包含

- 左窗格改成分頁容器:第一個分頁是現有的 Claude 對話(A 原封不動),其餘是終端分頁,尾端一個「+」開新終端機。
- web-first 的終端機子系統:主行程一個只綁 `127.0.0.1` 的 websocket 伺服器,每條連線配一個 node-pty;renderer 用 xterm 連上去。
- 開新終端機的快捷:claude、codex、grok、zsh 四個。按了就開一個 shell 並自動送那個指令。
- 終端分頁的生命週期:開、關、切換、視窗改大小時 xterm 與 pty 一起 resize、關分頁時 pty 收乾淨。
- terminal-server 邏輯的單元測試,加一個 Electron 實機 smoke。

### 2.2 C 不包含

手機或遠端的網頁 UI、Tailscale、A 的傳輸改成 websocket、右窗格瀏覽器的遠端顯示、終端機重開 app 後的還原、分割窗格、終端機的搜尋與捲動設定(用 xterm 預設)、終端機內容的持久化。這些之後再說,手機那條是獨立 spec。

### 2.3 已定案的取捨

| 項目 | 決定 |
|---|---|
| 跨 model 方式 | 終端機跑任何 CLI,不寫 model 適配層 |
| 終端機傳輸 | 一開始就走 websocket(不走 IPC),為之後的手機那條鋪路 |
| ws 伺服器範圍 | 只綁 `127.0.0.1`,只有本機程序連得到,這一版不做認證 |
| Recents 側欄 | 只在 Claude 對話分頁顯示;終端分頁時終端機占滿左窗格 |
| Claude 分頁 | 永遠是第一個分頁,不可關閉;終端分頁可關 |
| 終端機還原 | 不做,終端分頁是暫時的,關 app 就消失 |

## 3. 架構

### 3.1 三個架構決定

**終端機走 websocket,不走 IPC。** renderer 是 Electron 的 WebContentsView,本來可以用 IPC,但這樣手機瀏覽器之後接不上。改成主行程開一個 ws 伺服器、pty 掛在後面、renderer 用 xterm 連 `ws://127.0.0.1:<port>`,同一份 renderer 程式碼在 Electron 現在能用,手機那條之後把伺服器改綁 Tailscale 介面就接上。終端機走 websocket 本來就不比 IPC 難,這個前瞻選擇幾乎不花額外成本。

**左窗格是分頁容器,不是單一對話。** 分頁列在 title-bar 底下。Claude 對話分頁把現有的 App 內容(Recents 側欄加 Conversation 加 Composer)整塊放進去,不改它的邏輯。終端分頁各自是一個 xterm。切到哪個分頁就顯示哪個,終端分頁時不顯示 Recents 側欄。

**終端機天生跨 model,不寫適配層。** 每個終端分頁是 projectDir 下的一個 shell。快捷 claude/codex/grok/zsh 只是開 shell 後自動送一行指令,不是四種不同的整合。這是把「跨 model」這個特殊情況消掉:一個 shell 就通所有 CLI。

### 3.2 資料流

開新終端分頁:renderer 用一次性 IPC 問主行程要 ws 的 port(`terminal:endpoint`),連上 `ws://127.0.0.1:<port>`,送一則 `open`(帶 cols、rows、必填 projectId、選填 command)。主行程用 projectId 查專案登錄表取得 cwd,spawn 一個 node-pty(shell 用 `process.env.SHELL` 或 `zsh`),若 `open` 帶 command 就往 pty 寫一行那個指令。

之後:xterm 的按鍵送一則 `input` 給伺服器、寫進 pty;pty 的輸出當 `output` 送回、寫進 xterm。視窗改大小時 renderer 送一則 `resize`,伺服器對 pty 呼叫 resize。關分頁時 renderer 關 ws,伺服器收到後 kill pty;pty 自己結束時伺服器送一則 `exit` 再關 ws。

node-pty 的輸出與 xterm 的輸入都是字串,所以所有訊息都用 JSON text frame,不用 binary frame。只有「問 port」這一步走 IPC,終端機的資料全走 websocket。

port 的問法只在 app 開場做一次,取到的 ws base URL 往下傳給 Terminal 元件;Terminal 元件本身只認一個 ws URL,不碰 IPC。這樣手機那條之後把 URL 換成遠端來源就接上,Terminal 不必改。

## 4. 元件與檔案

新增相依:`node-pty`、`ws`、`@xterm/xterm`、`@xterm/addon-fit`。

- `src/main/terminal-server.ts`:ws 伺服器,綁 `127.0.0.1:0`(系統給一個空 port)。每條連線一個 pty:處理 `open`、`resize`、binary 輸入、關閉清理。對外提供實際 port 給 index.ts。
- `src/main/index.ts`:啟動時開 terminal-server,把 port 存起來給 IPC 回答。
- `src/main/ipc-bridge.ts`:加一個 `terminal:endpoint` 回 `{ port }`。
- `src/shared/ipc.ts`:加 `terminal:endpoint` 常數與回傳型別。
- `src/renderer/components/Terminal.tsx`:包 xterm 加 fit addon,連 ws,雙向接線,resize。
- `src/renderer/components/LeftPane.tsx`:分頁容器。Claude 分頁放現有 App 主體,終端分頁放 Terminal。分頁列、開、關、切換、快捷。
- `src/renderer/App.tsx`:現有主體抽成 Claude 分頁的內容,由 LeftPane 包起來。

A 的 `useConversation`、`useApprovals`、`useSessions` 與 B 的右窗格都不動。

## 5. 終端機 websocket 介面

連線:`ws://127.0.0.1:<port>`。一條連線對一個 pty。全部是 JSON text frame。

renderer 送伺服器:
- `{ type: 'open', cols: number, rows: number, projectId: string, command?: string }`:用 projectId 查登錄表取得 cwd 後 spawn pty;有 command 就往 pty 寫 `command + '\r'`。
- `{ type: 'input', data: string }`:pty 的輸入(xterm 的 onData 原樣送)。
- `{ type: 'resize', cols: number, rows: number }`。

伺服器送 renderer:
- `{ type: 'output', data: string }`:pty 的輸出,原樣寫進 xterm。
- `{ type: 'exit', code: number | null }`:pty 結束時送,送完關 ws。

第一則訊息必須是 `open`,在那之前收到別的訊息一律忽略。`open` 的 `projectId` 缺少、不是字串、或登錄表查不到時,記 log、送 `{ type: 'exit', code: 1 }` 後關連線,不退回任何預設目錄(D 規格 §6)。壞的或非預期的訊息(不是 JSON、缺 type、type 不認得)記 log 後忽略,不關連線。

pty spawn 參數:`name: 'xterm-color'`、`cwd` 取自登錄表中該 projectId 的 rootPath、`env: process.env`、cols/rows 取自 `open`。

## 6. 左窗格分頁模型

分頁模型改由 D 規格 §4.1 定義,主行程持有並持久化;以下保留 C 當時的設計供對照。

分頁狀態:`tabs: Tab[]`、`activeId`。`Tab` 是 `{ id: 'claude', kind: 'conversation' }` 或 `{ id: string, kind: 'terminal', title: string }`。

- Claude 分頁永遠在第一個、不可關。
- 「+」開一個 zsh 終端分頁;快捷 claude/codex/grok 開一個 zsh 並自動送該指令;quick-launch 的 grok 用其 CLI 名稱(安裝時確認實際指令,spike 時記進 RESULTS)。
- 關終端分頁:關 ws(伺服器 kill pty),移除分頁;若關的是 active 分頁,切回 Claude 分頁。
- 側欄:`activeId === 'claude'` 才顯示 Recents;終端分頁時左窗格只有終端機。
- 分頁標題:終端分頁預設用開場指令(codex、grok、zsh),使用者看得出哪個是哪個。

## 7. 錯誤處理與安全

**ws 伺服器只綁 `127.0.0.1`,這條是安全關鍵。** pty 就是一個有使用者完整權限的 shell,誰連得到這個 port 誰就有 shell。綁 localhost 讓只有本機程序連得到,所以這一版不需要認證。絕不綁 `0.0.0.0`;手機那條要遠端時,由那個獨立 spec 處理綁 Tailscale 介面與其信任模型,不在 C。

pty spawn 失敗:伺服器對該連線送一則 `exit`(code 非 0)後關 ws,renderer 在該分頁顯示一行錯誤,不影響其他分頁與 Claude 分頁。ws 連不上:Terminal 顯示一行「終端機連線失敗」,可關掉重開。renderer 或分頁關閉但 ws 沒正常關:伺服器在 socket close 事件 kill pty,不留孤兒程序。

## 8. 先驗地基:node-pty spike

`node-pty` 是原生模組,必須對著 Electron 的 Node ABI 編譯,配 electron-vite 的打包要先確認。這是最容易卡住的地方,所以第一步是一個丟棄式 spike,通過才寫產品程式碼:

- 主行程用 node-pty spawn `zsh`,renderer 用 xterm 顯示,打字有回應、`ls` 看得到輸出。
- 確認 electron-vite 把 node-pty 當外部原生模組處理(不打包進 bundle)、build 後仍能載入。
- 若 node-pty 在這個 Electron build 裝不起來,停下重新評估(備案:換 pty 函式庫,或用 child_process 加 script 模擬 pty)。

結果寫 `docs/RESULTS-06-c-terminals.md`,格式沿 `docs/RESULTS-05-*.md`,記下 node-pty 版本、electron-rebuild 的做法、grok 的實際 CLI 指令。

## 9. 測試與驗收

- terminal-server:用假 pty factory、假 socket 與假登錄表測 `open`/`resize`/輸入/`exit` 的訊息拆解、binary 與 text 的分工、projectId 缺少或查不到時的拒絕、socket close 時 kill pty 的清理。
- Terminal.tsx 的 xterm 接線與 node-pty 的真實行為單元測試蓋不到,由實機 smoke 蓋。
- 整體覆蓋率沿專案門檻(Stmts ≥ 93、Branch ≥ 86),terminal-server 是可測部分;`index.ts` 維持排除。

實機 smoke(照 B 的教訓,單元測試綠不代表實機可用):
1. 開一個終端分頁,跑 `echo hi`,看得到 `hi`。
2. 快捷 codex,分頁裡跑起 codex(或看得到它的提示)。
3. 視窗改大小,終端機跟著 reflow。
4. 關終端分頁,確認對應的 pty 程序被收掉(`ps` 沒有孤兒)。
5. 確認 ws 只在 `127.0.0.1`:從本機的區域網路 IP 連該 port 應該連不上。
6. Claude 分頁、右窗格瀏覽器(B)在有終端分頁的情況下行為不變。

結果寫進 `docs/RESULTS-06-c-terminals.md`。

## 10. 修訂紀錄

| 日期 | 章節 | 變更 | 依據 |
|---|---|---|---|
| 2026-09-07 | 全 | 初版 | brainstorming |
| 2026-09-08 | §3.2、§5、§9 | `open` 多一個必填 `projectId`,cwd 由主行程查登錄表決定;查不到就送 exit 並關連線 | 子專案 D 規格 §3.1、§3.2、§6 |
| 2026-09-08 | §4、§6、§9 | 分頁模型改由 D 規格 §4.1 定義,主行程持有並持久化;`useTerminals` 已刪除,§4 與 §9 的對應條目移除 | 子專案 D 規格 §4.1、Task 12 |

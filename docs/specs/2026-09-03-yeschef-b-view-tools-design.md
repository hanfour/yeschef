# yeschef B：右窗格工具 設計規格

日期：2026-09-03
狀態：待審
子專案：B（A 已於 2026-09-03 併入 main；D 文件面板未開始）

## 0. 這份規格取代了什麼

原規格 `docs/specs/2026-08-31-yeschef-design.md` 的以下段落被本文取代：

| 原規格段落 | 原本寫的 | 取代為 |
|---|---|---|
| §4.1 第四條 | app 自建 stdio MCP server，`claude --mcp-config` 連入 | in-process SDK MCP server，經 `query()` 的 `mcpServers` 掛入（§3） |
| §5 MCP 介面 | 九個工具 | 八個工具；`preview` 移到子專案 D（§5） |
| §5.0 ref 的生命週期 | ref 與 snapshot id 分開傳 | ref 自帶 snapshot 序號（§4） |
| §6.1 交接橫幅 | 右窗格頂端橫幅 | 左窗格對話流的交接卡，由 tool-use／tool-result 投影（§6.4） |
| §7 錯誤處理 | 五列 | 擴充為 §7 |
| §9 測試 | MCP 工具層對本地 fixture 端對端 | 三層測試與驗收判準（§8） |

原規格 §1 到 §3、§8 的 spike 結論、§10、§11 繼續有效。A 規格（`2026-09-01-yeschef-a-sdk-host-design.md`）全部有效，本文只新增，不改動 A 的任何介面。

## 1. 前提

| 事實 | 依據 |
|---|---|
| 右窗格無焦點時 CDP `Input.*` 注入可靠：三種焦點狀態各 200/200 | `docs/RESULTS-02-input-focus.md` |
| 跨站 iframe 遞迴附著覆蓋率 16/16 | `docs/RESULTS-03-oopif.md` |
| Agent SDK 0.3.258 提供 `createSdkMcpServer` 與 `tool()`，回傳的 `McpSdkServerConfigWithInstance` 可放進 `query()` 的 `mcpServers`；工具處理函式在呼叫端程序內執行 | `sdk.d.ts` 第 511、8474、1103 行 |
| Electron 44 的 `webContents` 有 `input-event`（滑鼠與鍵盤都到）與 `before-input-event` | `electron.d.ts` 第 17206 行 |
| `src/main/cdp.ts` 的 `CdpSession.send(method, params, sessionId?)` 已支援對子 session 下指令；`getAttachedTargets()`、`getRearmErrors()` 可查附著範圍 | 現有程式碼 |
| `canUseTool` 對每一個 MCP 工具呼叫都會被叫到，回 `allow` 就不出批准卡 | A 規格 §6 與 `agent-host.ts` 第 385 行 |

## 2. 範圍

### 2.1 B 包含

八個右窗格工具與其 MCP server、CDP session 常駐與 snapshot 失效偵測、使用者插手摘要、`request_handoff` 的交接卡與逾時、view 工具的批准政策、本地 fixture 的三層測試與實機驗收。

### 2.2 B 不包含

`preview(path | html)` 與 markdown 渲染（子專案 D）、多視窗、下載管理、右窗格的網址列或書籤 UI、任何往頁面注入持久 JS 的橋接。

### 2.3 使用者已定案的四個取捨

| 項目 | 決定 |
|---|---|
| 批准政策 | view 工具自動放行，只有 `view_eval` 走批准卡 |
| 範圍 | `preview` 不在 B，另開子專案 D |
| 交接按鈕位置 | 左窗格對話流的交接卡，不在右窗格疊橫幅 |
| snapshot 來源 | CDP `Accessibility` 域的 AX 樹，不往頁面注入 JS |

## 3. 架構

```
Electron 主程序
┌──────────────────────────────────────────────────────────────┐
│ agent-host ── query(options)                                 │
│   options.mcpServers.yeschef = createViewToolServer(...)    │
│   canUseTool：viewToolPolicy 先判，自動放行的不進批准卡        │
│                                                              │
│ src/main/view-tools/                                         │
│   server.ts      tool() × 8，zod 驗輸入，轉呼叫 controller    │
│   controller.ts  navigate／click／type／press／eval／screenshot│
│   snapshot.ts    AX 樹 → 可視節點 → 帶 ref 的文字（純函式）    │
│   refs.ts        ref 編碼與解析、RefTable                     │
│   settle.ts      網路靜默等待（純函式計數 + 注入時鐘）         │
│   watch.ts       失效偵測與插手計數                           │
│   handoff.ts     單一 pending、10 分鐘逾時、以 toolUseId 對應  │
│   policy.ts      viewToolPolicy(toolName) → 'allow' | 'ask'   │
│                                                              │
│ agent-view.ts（既有，不動）─ WebContentsView ─ cdp.ts（既有）  │
└──────────────────────────────────────────────────────────────┘
        ▲ events 通道不加新 kind：交接卡由既有 tool-use／tool-result 投影
        ▼ IPC：handoff:done { toolUseId }
renderer：HandoffCard（新）在對話流裡，樣式沿用 ApprovalCard
```

### 3.1 三個架構決定

MCP server 跑在主程序內。工具處理函式直接持有 `CdpSession`，不經 stdio、不序列化、不多開程序。代價是工具程式碼與 Electron 主程序同生命週期，一個工具卡死會佔住 agent 的一個 tool call，不會拖垮 UI（IPC 與 renderer 不在同一條 promise 鏈上）。

`view-tools/` 對外只有一個工廠 `createViewToolServer(deps)`，回傳 `{ server: McpSdkServerConfigWithInstance, handoff: HandoffPort, dispose(): Promise<void> }`。`deps` 是 `{ view: WebContentsView, cdp: CdpSession, clock: MergerClock, projectDir: string, logError }`。agent-host、ipc-bridge、session-options 都不認識 CDP；index.ts 負責把工廠結果接進 `SessionOptions.mcpServers` 與 ipc-bridge 的 handoff 通道。

批准政策放在自己的 `canUseTool` 裡，不用 SDK 的 `allowedTools`。`policy.ts` 是一個純函式：工具名以 `mcp__yeschef__` 開頭且不是 `mcp__yeschef__view_eval` 就回 `allow`，其他回 `ask` 交給既有流程。理由：`allowedTools` 對 MCP 名稱的萬用字元語意在 SDK 型別註解裡沒有說明，列七個全名會讓工具清單存在兩處；自家函式一條測試就能驗完。

### 3.2 資料流

```
agent tool_use ─▶ SDK ─▶ canUseTool(policy) ─▶ server.ts(zod) ─▶ controller.ts ─▶ cdp.send
                                                                        │
使用者滑鼠鍵盤 ─▶ agentView.webContents ─▶ watch.ts（input-event）───────┤ 計數／失效
CDP 事件（documentUpdated／frameNavigated）─▶ watch.ts ─────────────────┘
request_handoff 的 tool-use 事件 ─▶ fold ─▶ HandoffCard（pending）─▶ IPC handoff:done ─▶ handoff.ts resolve ─▶ tool-result 事件 ─▶ HandoffCard（done）
```

## 4. 資料結構

```ts
interface Snapshot {
  readonly id: number                 // 遞增序號，每次 view_snapshot 加一
  readonly takenAt: number
  readonly url: string
  readonly frames: readonly FrameSnapshot[]
  readonly unattachedFrames: number   // 有 iframe 但沒附著到的數量
  readonly truncated: number          // 超過 400 個節點時被截掉的數量
}
interface FrameSnapshot {
  readonly sessionId?: string         // 主 frame 為 undefined
  readonly nodes: readonly AxNode[]
}
interface AxNode {
  readonly ref: string                // 's12-e7'
  readonly role: string
  readonly name: string
  readonly value?: string
  readonly bounds: Rect
  readonly states: readonly string[]  // disabled／checked／expanded／focused 等
}
interface Rect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
interface RefTable {
  readonly snapshotId: number
  readonly invalidatedBy?: 'documentUpdated' | 'navigated' | 'userInput'
  readonly entries: ReadonlyMap<string, { readonly sessionId?: string; readonly backendNodeId: number }>
}
interface InterventionLog {
  readonly clicks: number
  readonly keys: number
  readonly navigations: number
  readonly fromUrl: string
}
interface HandoffPending {
  readonly toolUseId: string
  readonly reason: string
  readonly askedAt: number
}
interface HandoffPort {
  expect(toolUseId: string): void   // canUseTool 放行 request_handoff 時呼叫
  done(toolUseId: string): void     // ipc-bridge 收到 handoff:done 時呼叫
}
```

ref 格式 `s<snapshotId>-e<nodeIndex>`。工具收到 ref 先比對 snapshotId 是否等於目前 RefTable 的 `snapshotId`：不等回「已過期」，等於但 `entries` 裡沒有回「不存在」。RefTable 只保留最新一份 snapshot；失效時換成 `entries` 為空、`invalidatedBy` 記下原因的新表，下一次錯誤訊息用它說明。

可操作角色白名單：button、link、textbox、searchbox、combobox、checkbox、radio、switch、slider、tab、menuitem、option、listbox、spinbutton。其他角色（heading、paragraph、image、region 等）保留在 snapshot 文字裡當結構提示但不配 ref。

可視範圍判定：節點 `DOM.getBoxModel` 的 border 四點與 viewport 矩形有交集即算可視。`scope: 'full'` 略過這個判定。

## 5. 工具介面

八個工具掛在 MCP server `yeschef` 下，模型看到的名稱是 `mcp__yeschef__view_navigate` 等。回傳一律是 MCP `text` content（`view_screenshot` 例外，回 `image`），格式固定。

| 工具 | 輸入（zod） | 成功回傳 | 後續等待 |
|---|---|---|---|
| `view_navigate` | `url: string`（http／https／file） | `已到 <最終 url>，標題 <title>` | `Page.loadEventFired` 再加網路靜默 500ms，合計上限 8 秒 |
| `view_snapshot` | `scope?: 'viewport' \| 'full'`（預設 viewport） | 插手摘要一行（有互動才出現）、`[iframe 未附著 N 個]`（N > 0 才出現）、每節點一行 `s12-e7 button "送出" (disabled)`、截斷提示（有才出現） | 無 |
| `view_screenshot` | 無 | PNG，可視範圍，寬超過 1280 縮到 1280 | 無 |
| `view_click` | `ref: string` | `已點擊 <role> "<name>"`；導航時多一行 `網址變為 <url>` | 網路靜默 500ms，上限 5 秒 |
| `view_type` | `ref: string, text: string, clear?: boolean, submit?: boolean` | `已輸入 N 字元到 <role> "<name>"` | `submit` 為 true 時同 click |
| `view_press` | `key: string`（白名單：Enter、Tab、Escape、Backspace、Delete、ArrowUp／Down／Left／Right、Home、End、PageUp、PageDown、Space） | `已按 <key>` | 網路靜默 500ms，上限 5 秒 |
| `view_eval` | `expression: string` | `Runtime.evaluate` 結果 JSON，超過 8 KB 截斷並標示 | 無 |
| `request_handoff` | `reason: string` | `使用者已完成，目前網址 <url>` 或 `已逾時 10 分鐘，使用者未按確認，目前網址 <url>` | 阻塞到按鈕或逾時 |

執行方式：

- `view_click`：`DOM.getBoxModel` 取 border 中心點，`Input.dispatchMouseEvent` 送 mousePressed 與 mouseReleased 各一次。點擊前先 `DOM.scrollIntoViewIfNeeded`。
- `view_type`：`DOM.focus` 後 `Input.insertText`；`clear` 為 true 時先送 Meta+A 與 Backspace 的 keyDown／keyUp 清掉既有內容；`submit` 為 true 時最後送 Enter 的 keyDown／keyUp。
- `view_press`：`Input.dispatchKeyEvent` keyDown 與 keyUp，`key`、`code`、`windowsVirtualKeyCode` 三欄由白名單表查出。
- `view_eval`：`Runtime.evaluate` 帶 `returnByValue: true`、`awaitPromise: true`，只在主 frame 執行。
- 每個工具開始前 `watch.ts` 標記 `agentActing = true`，結束（含錯誤）後還原，期間收到的 `input-event` 不計入插手。

等待策略由 `settle.ts` 統一：`Network.requestWillBeSent` 加一、`loadingFinished`／`loadingFailed` 減一，在飛數連續 500ms 為零算靜默。到上限回錯誤 `頁面在 N 秒內未靜默，請 snapshot 確認狀態`（`view_navigate` 為 `頁面在 8 秒內未載入完成，目前網址 <url>`）；動作本身已送出，agent 用 snapshot 決定下一步。

`view_snapshot` 兩種 scope 都以 400 個節點為上限，超過截斷並在尾端加一行 `（還有 N 個節點未列出，請縮小範圍或捲動後重拍）`。

## 6. 人機共用同一個 WebContents

### 6.1 CDP session 常駐

app 啟動時對 agentView 呼叫一次 `attachCdp`，啟用 `Page`、`DOM`、`Network`、`Accessibility` 四個域並 `Target.setAutoAttach`（`flatten: true`，沿用 cdp.ts 的遞迴 re-arm）。不隨 tool call 附著與卸除：那會讓 `Network` 在飛計數與 `documentUpdated` 監聽有空窗，使用者在空窗期的操作偵測不到。`dispose()` 時卸除。

### 6.2 snapshot 失效

三個觸發任一發生就清空 RefTable：

| 觸發 | 來源 | 原因字串 |
|---|---|---|
| 任何 frame 的 `DOM.documentUpdated` | CDP 事件 | `documentUpdated` |
| 主 frame 的 `Page.frameNavigated` | CDP 事件 | `navigated` |
| 使用者的 `input-event`（`agentActing` 為 false 時） | `webContents` 事件 | `userInput` |

DOM 局部變動不算失效：backendNodeId 對同一節點穩定，節點被移除時 `DOM.getBoxModel` 回錯，工具回 `ref s12-e7 指向的元素已不在頁面上，請重新 snapshot`。

### 6.3 插手摘要

`InterventionLog` 由 `watch.ts` 累計：`input-event` 的 `mouseDown` 計 clicks、`keyDown` 計 keys、`Page.frameNavigated`（主 frame，且非 agent 導航）計 navigations。`view_snapshot` 回傳的第一行：`使用者在你上次操作後點了 3 次、按了 12 個鍵，網址從 <fromUrl> 變成 <url>`；三個計數都為零時省略這行。回傳後歸零並把 `fromUrl` 設為目前網址。

### 6.4 交接

交接卡不需要新的事件種類。`request_handoff` 的 `tool-use` 事件（`name` 為 `mcp__yeschef__request_handoff`）本來就會進對話流，fold 把它投影成 HandoffBlock：對應的 `tool-result` 還沒到就是 pending（顯示理由、已等待時間、「我好了」按鈕），到了就是 done（顯示結果那一行文字）。live 與重載歷史走同一條路，app 中途關閉造成只有 tool-use 沒有 tool-result 的，重載後顯示為「未完成」。

主程序這邊：`canUseTool` 對 `request_handoff` 放行時把 `toolUseID` 交給 `handoff.ts`，工具處理函式隨後建立以這個 id 為 key 的 `HandoffPending`。使用者按下按鈕時 renderer 送 IPC `handoff:done { toolUseId }`，主程序比對 id 後 resolve；id 對不上（過期的卡片）就忽略並 `logError`。

規則：
- 同時只允許一筆 pending。第二筆進來回錯誤 `已有一筆交接等待中（<reason>），請等使用者完成`。
- 逾時 10 分鐘用注入的 `MergerClock`，逾時 resolve 為 `outcome: 'timeout'`，工具回狀態不回錯誤（原規格 §6.1 的理由不變：常見情況是使用者做完了忘了按）。
- session 收尾（`teardown`）時 pending 以 `outcome: 'session-ended'` resolve，工具回 `對話已結束`。
- 已等待時間由 renderer 從卡片出現那一刻起算（沿用 `relative-time.ts`），重載歷史的卡片不顯示等待時間。

## 7. 錯誤處理與安全

| 情況 | 處置 |
|---|---|
| 右窗格 webContents 已銷毀 | 八個工具進門先查 `isDestroyed()`，回 `右窗格不存在` |
| CDP 指令失敗（`CdpError`） | 訊息翻成一句中文並附 code；`cdp.send` 逾時 10 秒 |
| 跨站 iframe 未附著 | snapshot 前綴 `[iframe 未附著 N 個]`，N 由 frame 樹的 iframe 數減 `getAttachedTargets()` 數，`getRearmErrors()` 非空時另加一行 |
| 非 http／https／file 的網址 | zod 進門擋下，回 `只接受 http、https、file 開頭的網址` |
| `file://` 不在 `YESCHEF_PROJECT_DIR` 底下 | 回 `只允許開啟 <projectDir> 底下的本地檔案` |
| `view_eval` 丟例外 | 回 `exceptionDetails.text`，`isError: true` |
| session 收尾時 tool call 仍在等待 | `AbortSignal` 從 agent-host 的 teardown 傳進 controller，等待立即中止，回 `對話已結束` |
| 等待逾時（§5 的 5 秒或 8 秒） | 動作已送出，回 `isError: true` 的逾時訊息，不重送 |
| 工具處理函式拋出未預期例外 | server.ts 外層 catch 轉 `isError` 文字並 `logError`，SDK 端不會收到 rejected promise |
| ref 格式錯 | `ref 格式應為 s<數字>-e<數字>` |
| ref 過期 | `snapshot s12 已過期（原因：<原因字串>），請先呼叫 view_snapshot` |
| ref 不存在 | `snapshot s12 沒有 e99 這個節點` |

所有錯誤都是 MCP `isError: true` 加一句繁體中文，說清楚下一步該做什麼。`request_handoff` 的逾時是狀態不是錯誤（§6.4）。

安全立場：agent 只能透過八個工具碰右窗格；工具內只用 CDP，不注入持久 JS；`view_eval` 每次都走批准卡，卡片顯示完整表達式；`persist:agent` partition 與使用者 Chrome 的隔離不變；`agent-view.ts` 的 `setWindowOpenHandler` 繼續把新視窗改為原地導航。

## 8. 測試與驗收

### 8.1 三層

| 層 | 工具 | 測什麼 |
|---|---|---|
| 純函式 | vitest | AX 樹過濾與 ref 編號（`Accessibility.getFullAXTree` 真實回傳存成 fixture）、可視判定、插手摘要文字、ref 解析與過期判斷、`settle.ts` 計數（假事件流加 manualClock）、handoff 逾時與單一 pending、`policy.ts` |
| MCP 層 | vitest | 對 `createViewToolServer` 注入假的 `CdpSession`（記錄 method 與 params、回預錄結果）與假的 `WebContentsView`，八個工具各測成功、進門驗證失敗、CDP 失敗三條路 |
| 實機 | `npm run build` 後 `npx electron . --remote-debugging-port=9333`，以 CDP `Runtime.evaluate` 檢查結果 | 本地 HTML fixture：表單、兩個本地 port 模擬跨站 iframe、SPA 局部更新、`target=_blank`；逐工具約 25 項；一場完整流程：開 fixture、snapshot、填表、送出、request_handoff、人按「我好了」、agent 再 snapshot 看到人的改動 |

### 8.2 判準

- 純函式與 MCP 層全綠，整體覆蓋率不低於 A 併入時的 Stmts 93／Branch 86。
- 實機 25 項至少 23 項 ✓，且 `view_click`、`view_type`、`request_handoff` 三項必須 ✓。
- 結果寫 `docs/RESULTS-05-b-view-tools.md`，格式沿 RESULTS-04。

## 9. 現有程式碼的變動點

| 檔案 | 變動 |
|---|---|
| `src/main/agent-view.ts`、`src/main/cdp.ts` | 不動 |
| `src/main/session-args.ts` | `SessionOptions` 加 `mcpServers?: Record<string, McpSdkServerConfigWithInstance>` |
| `src/main/session-options.ts` | 工廠多收一個 `mcpServers`，每次產出的 options 帶上 |
| `src/main/agent-host.ts` | `canUseTool` 先問 `viewToolPolicy`，`allow` 就直接回，不進 approvals；放行 `request_handoff` 時把 `toolUseID` 交給 handoff；teardown 時通知 view-tools 的 `AbortSignal` |
| `src/shared/events.ts` | 不動 |
| `src/shared/fold.ts` | `tool-use` 的 `name` 為 `mcp__yeschef__request_handoff` 時投影成 HandoffBlock，其 `tool-result` 到達時轉 done |
| `src/shared/ipc.ts` | 新增 `handoff:done` 通道與 parse 函式 |
| `src/main/ipc-bridge.ts` | 接 `handoff:done`，轉給 `HandoffPort.done(toolUseId)` |
| `src/preload/bridge.ts` | `api.handoffDone(toolUseId)` |
| `src/renderer/components/HandoffCard.tsx` | 新元件，樣式沿用 ApprovalCard |
| `src/main/index.ts` | 啟動時 `attachCdp(agentView.webContents)`、`createViewToolServer`、接進 session-options 與 ipc-bridge；`INITIAL_AGENT_URL` 改為 `about:blank` |

## 10. 已知風險與未決事項

| 項目 | 狀態 |
|---|---|
| `Accessibility.getFullAXTree` 在數千節點的頁面上的耗時未量 | 實機驗收加一項量測：MDN 首頁與 GitHub PR 頁各 5 次，超過 1 秒就改 `Accessibility.queryAXTree` 分段取 |
| `input-event` 是否涵蓋觸控板捲動 | 捲動不計入插手（捲動不改 DOM 也不改 backendNodeId），不影響正確性 |
| SPA 局部更新後 ref 指向已被替換的同位置新節點 | backendNodeId 不同會讓 `getBoxModel` 回錯，工具回「元素已不在頁面上」；agent 重拍即可 |
| `view_type` 對 contenteditable 與自訂輸入元件 | `Input.insertText` 對 contenteditable 有效；自訂元件靠 focus 後的 keydown 監聽，實機驗收列一項 |
| 跨站 iframe 內的 `DOM.getBoxModel` 座標是相對該 frame 的 viewport | 點擊前用 `DOM.getFrameOwner` 取 iframe 元素的位置加上偏移；實機驗收兩個 port 的 fixture 就是為了測這條 |
| 專案名稱 yeschef 未定案 | 沿原規格 §11 |

## 11. 修訂紀錄

| 日期 | 章節 | 修訂 | 依據 |
|---|---|---|---|
| 2026-09-03 | 全文 | 初版 | 原規格 §4 到 §9、A 規格 §2.2 與 §10、RESULTS-02／03 |
| 2026-09-03 | §4 | `AxNode.ref` 原為必填 → 改選填：只有可操作角色配 ref，heading／image 沒有 | 契約 §5、裁決 18 |
| 2026-09-03 | §4 | `AxNode` 加 `backendNodeId`、`sessionId`：`view_click`／`view_type` 要拿 backendNodeId 對該 frame 的 session 下 CDP 指令 | 契約 §5、裁決 18 |
| 2026-09-03 | §4 | `RefTable.entries` 的值原為 `{ sessionId?, backendNodeId }` → 加 `role`、`name`：回傳文字 `已點擊 <role> "<name>"` 要用 | 契約 §5、裁決 18 |
| 2026-09-03 | §4 | `Snapshot` 加 `title`、`scope`，`FrameSnapshot` 加 `frameId`、`url`：snapshot 文字的 `[page] <title> <url>` 與 `[iframe k] <url>` 要用 | 契約 §5、裁決 18 |
| 2026-09-03 | §4 | `HandoffPort`（`expect`／`done`）→ 由 `ViewTools`（`server`／`autoAllow`／`handoffDone`／`abortPending`／`dispose`）取代：`expect()` 不需要，toolUseId 由工具 handler 的 `extra` 直接取 | 裁決 3、8 |
| 2026-09-03 | §4 | ref 的 `e<n>` 原文未訂起始值（範例是 `s12-e7`）→ 定為從 0 起（`s12-e0`），structural 節點不佔號 | 裁決 22 |
| 2026-09-03 | §5 | `view_type` 的 clear 原為「送 Meta+A 與 Backspace 的 keyDown／keyUp」→ keyDown `a` 要帶 `commands: ['selectAll']`：macOS 的 Meta+A 不會進 renderer 的編輯指令 | 裁決 12 |
| 2026-09-03 | §6.1 | 原文「啟用 `Page`、`DOM`、`Network`、`Accessibility` 四個域」→ `Page`／`Runtime` 由 cdp.ts 在 root 啟用，`DOM`／`Network`／`Accessibility` 由 watch.ts 在 root 與每個 iframe session 啟用；OOPIF session 不需 `Page.enable` | 裁決 5、24 |
| 2026-09-03 | §6.3 | 插手摘要原文只有一種句型 → 三種變體：網址變、網址相同時改成 `網址仍是 <url>`、`navigations` 為 0 且網址相同時省略網址那段，避免出現「網址從 A 變成 A」 | 裁決 15 |
| 2026-09-03 | §6.4、§9 | 原文「fold 把 `tool-use` 投影成 HandoffBlock」→ `fold.ts` 不動，renderer 以 `block.name === REQUEST_HANDOFF_TOOL` 判斷，卡片走 `Turn`／`Conversation` 新增的 `renderToolOverride` | 裁決 2 |
| 2026-09-03 | §6.4、§9 | 原文「`canUseTool` 放行 `request_handoff` 時把 `toolUseID` 交給 `handoff.ts`」→ toolUseId 改由工具 handler 的 `extra._meta['claudecode/toolUseId']` 取（探針已證實）；`agent-host.ts` 只多一個純政策的 `autoAllow?` dep，不認識 handoff | 裁決 3、8 |
| 2026-09-03 | §6.4 | 原文「id 對不上（過期的卡片）就忽略並 `logError`」→ 改記進 `earlyDone` FIFO（上限 8），之後同 id 的 `begin()` 立即回 `done`：按鈕按一次就停用，早到的 done 不該讓 agent 白等 10 分鐘 | 裁決 31 |
| 2026-09-03 | §7 | 原文「非 http／https／file 的網址由 zod 進門擋下」→ zod shape 只宣告型別，值檢查在 controller，錯誤訊息才會是 `errors.ts` `MSG` 表的字 | 裁決 10 |
| 2026-09-03 | §7 | 原文「`view_eval` 丟例外回 `exceptionDetails.text`」→ 先用 `exceptionDetails.exception?.description`，沒有才用 `.text` | 裁決 28 |
| 2026-09-03 | §7 | 原文「`AbortSignal` 從 agent-host 的 teardown 傳進 controller」→ 改由 `ipc-bridge.ts` 在 `interrupt-query`／`teardown-query` effect 之前呼叫 `viewTools.abortPending`，server.ts 內部再用 AbortController 傳給 controller | 裁決 11 |
| 2026-09-03 | §7 | 原文「未附著 N 由 frame 樹的 iframe 數減 `getAttachedTargets()` 數」→ N 是 AX 樹抓不到的 frame 數（root 與每個 iframe target 的 `Page.getFrameTree` 聯集減去有 AX 樹的） | 裁決 6 |
| 2026-09-03 | §7 | 原文「`cdp.send` 逾時 10 秒」→ 逾時改在 controller 的 `call()` 做，`cdp.ts` 不加逾時邏輯 | 裁決 14 |
| 2026-09-03 | §8.1 | 原文「兩個本地 port 模擬跨站 iframe」→ 同一 host 不同 port 是同一個 site，Chromium 不會切成 OOPIF；改成 `localhost` 主頁加 `127.0.0.1` iframe | 裁決 34 |
| 2026-09-03 | §9 | 原文「`src/main/cdp.ts` 不動」→ 加 `onEvent`、`AttachedTargetInfo.sessionId`、`attachCdp(wc, opts?)`：`CdpSession` 原本沒有事件訂閱，watch 與 settle 需要 CDP 事件 | 裁決 1 |
| 2026-09-03 | §9 | 原文 `SessionOptions` 的 `mcpServers?: Record<string, McpSdkServerConfigWithInstance>` → `Readonly<Record<string, McpServerConfig>>`（SDK `Options.mcpServers` 的型別），且沒給 `mcpServers` 時 options 連這個 key 都不出現 | 契約 §11.1 |
| 2026-09-03 | §9 | 原文「`ipc-bridge.ts` 轉給 `HandoffPort.done(toolUseId)`」→ 轉給 `ViewToolHooks.handoffDone(toolUseId)`；沒有 view tools 時只 `logError` | 裁決 3、契約 §11.4 |
| 2026-09-03 | §9 | 原文「`HandoffCard.tsx` 樣式沿用 ApprovalCard」→ 自己一份 `HandoffCard.css`，`ApprovalCard.css` 不動 | 契約 §12、裁決 25 |

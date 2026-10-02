# 每個對話一個瀏覽器,加上網址列

- 日期:2026-09-21
- 狀態:已實作,驗收見 docs/RESULTS-34-per-conversation-browser.md
- 後續:測試機設定與 `view_login`(另一份規格,依賴本規格的獨立 partition);Apple design 全面審視(再下一份)

## 1. 要解決什麼

右窗格現在只有一個 `agentView`(`src/main/agent-view.ts`),partition 是 `persist:agent`,所有專案、所有對話共用。
兩個後果:

1. 不是前景的對話呼叫瀏覽器工具,`view-tools/server.ts` 的前景守衛直接回 `MSG.browserBusy`。
   主廚派出去的 worker 與背景對話都沒辦法自己開頁面驗收,只能等人把它切到前景。
2. 右窗格沒有網址列。人想手動開一個網址、回上一頁、重新整理,都做不到。

這份規格把結構改成每個對話擁有自己的瀏覽器,右窗格顯示前景對話的那一個,並加上網址列。

## 2. 已決定的事

| 題目 | 決定 |
|---|---|
| 「每個 agent」在程式裡是什麼 | 每個對話。主廚的 worker 也是用 `openConversationTab` 開的對話分頁,自動涵蓋 |
| 登入狀態怎麼隔離 | 每個對話一個記憶體內 partition `agent:<conversationId>`,不加 `persist:`。對話之間 cookie 與 localStorage 不互通,對話關閉就清掉 |
| 怎麼查看某個 agent 的瀏覽器 | 右窗格跟著前景對話。點哪個對話分頁就看到那個對話的瀏覽器 |
| view 什麼時候建立 | 第一次用到才建立:agent 第一次呼叫瀏覽器工具,或人第一次在該對話的網址列按 Enter |
| view 數量上限 | 這一版仍不設。量測(docs/RESULTS-34-per-conversation-browser.md)顯示固定頁每個 session 約增加 113000 KB;同一種頁面兩次量測的差距,`about:blank` 是 32 KB(相對 0.03%),固定頁是 5 KB(相對 0.004%),數字穩定,個位數 session 時用量可控。之後同時運作的對話數常態變多,再依當時的實際使用量決定上限 |

## 3. 資料關係

```
對話 (conversationId)
  └─ BrowserSession            ← 第一次用到才有
       ├─ view   WebContentsView, partition = agent:<conversationId>
       └─ tools  ViewTools(controller、settle、watcher、handoff 各一份)
```

CDP session 由 `startViewTools` 內部持有,不是 `BrowserSession` 的欄位;`dispose()` 一併收掉,不另外露出。
專案目錄也不是欄位:每次用到都用 conversationId 查目前所屬專案的 `rootPath`(§4.4),不在 session 建立時綁定。

前景對話的 session 被顯示,其餘的 view 藏著但照常運作(`setBackgroundThrottling(false)` 沿用)。

現在的結構是一個 view、一條 CDP、N 個對話共用,前景守衛是為了這個結構加的。每個對話各有一份之後,
`forProject(isActive)` 這一層、`MSG.browserBusy` 的前景判斷、切換前景時的 `abortPending`,三樣一起刪掉。

## 4. 主行程

### 4.1 新檔 `src/main/browser-sessions.ts`

一張 `Map<conversationId, BrowserSession>`,四個操作:

| 操作 | 行為 |
|---|---|
| `ensure(id)` | 有就回傳;沒有就建 view、`addChildView`、附著 CDP、建 `ViewTools`。同一個 id 同時被呼叫兩次時共用同一個 promise,不會建兩份 |
| `get(id)` | 只查,不建 |
| `show(id \| null)` | 把目前顯示的 view 藏起來,改顯示 `id` 的 view;`id` 沒有 session 或是 `null` 時全部藏起來 |
| `dispose(id)` | `ViewTools.dispose()`、CDP detach、`removeChildView`、`webContents.close()`,從表裡移除。正在顯示的話先藏。呼叫時 session 還在建立中,先等建立完成;那次建立其實已經成功的話,照上面步驟收掉,不留半建好的紀錄在表裡 |

它是唯一呼叫 `addChildView` 與 `removeChildView` 的地方。`index.ts` 裡建立 `agentView`、`startViewTools`、
`did-navigate` 監聽的那幾段已經搬進來,`index.ts` 目前 591 行。

瀏覽器的壽命跟著對話分頁,不跟著 slot:`closeSlot`、`disposeSlot` 都不動瀏覽器。`ipc-bridge.ts` 的 projects
訂閱比較前後兩次狀態,對話分頁從狀態裡消失時(關閉分頁、專案被移除)才呼叫 `sessions.dispose(id)`。專案被
重新指定資料夾、主廚 worker 停止,都只重建或收掉 slot,分頁還在,瀏覽器留著。

### 4.2 `createAgentView` 多收一個 partition 參數

其餘設定不動:不給 preload、`sandbox: true`、`contextIsolation: true`、window-open 過白名單後原地導航。
`AGENT_PARTITION` 常數改成 `agentPartitionFor(conversationId)`,回傳 `agent:<conversationId>`。

### 4.3 MCP server 與 view 的建立時間不同

`sessionOptions.mcpServers` 要求對話啟動時 server 就存在,但 view 要等第一次用到。做法:每個對話啟動時建一份
薄的 server,它的 `invoke` 第一步是 `await sessions.ensure(conversationId)`,拿到 session 後轉給該 session 的
`ViewTools.invoke`。Codex 走的 `invoke` 路徑用同一個入口。

`ensure` 失敗(CDP 附著逾時、view 建立失敗)時,這次工具呼叫回一句錯誤訊息給模型,下一次呼叫會重試。
現在的行為是啟動時失敗就整個 app 的右窗格工具停用(裁決 17),改完後影響範圍縮到單一對話的單一次呼叫。

`createConversationViewServer` 收的 `resolve` 每次工具呼叫都會執行一次,不是只有第一次;正確性靠
`ensure` 自己 idempotent:已經建好的 session 直接回傳既有那一份,不會每次呼叫都重建。

### 4.4 專案範圍檢查跟著對話自己的工作目錄

`view_navigate` 與 window-open 的 `file://` 範圍檢查原本用 `activeProjectDir()`,也就是前景專案的根目錄。
背景對話可以操作之後,查範圍的對話不一定是前景那一個,用前景專案的根目錄等於把範圍開放到別的對話身上,
worktree 底下的對話甚至看得到整個專案主目錄與其他 worktree。

改成用 conversationId 查這個對話自己的工作目錄:有 worktree 就只到 worktree,沒有才是所屬專案的
`rootPath`。`src/main/projects-state.ts` 新增 `conversationDir(state, conversationId)` 負責這個查詢,每次
用到都重查,不在 session 建立時綁定,專案被重新指定資料夾也不用另外同步。`ViewToolDeps.activeProjectDir`
改名為 `projectDir`。

### 4.5 顯示

`createBrowserPlacement` 的 `view` 參數現在是固定的一個。改成傳入一個轉接物件,它實作同一個 `PlaceableView` 介面,
內部記著「目前顯示的 view」:

- `setBounds`、`setVisible` 轉給目前顯示的 view;沒有的話什麼都不做。
- `sessions.show(id)` 換目標時,先對舊的 `setVisible(false)`,再讓 placement 對新的套用一次目前的矩形。

`createBrowserPlacement` 本身與它的測試不用改。

`ipc-bridge.ts` 的 `switchTo` 多呼叫一次 `sessions.show(nextId)`,並刪掉 `prev.runtime?.viewTools?.abortPending(MSG.browserBusy)`。
瀏覽器什麼時候收掉見 §4.1:跟著對話分頁,不是 `disposeSlot`。

### 4.6 lastUrl 改成每個對話一份

`tabSchema` 加 `lastUrl: z.string().nullable().optional()`。optional 讓舊的狀態檔照常讀得進來,`schemaVersion` 不用升。
`did-navigate` 與主框架的 `did-navigate-in-page` 寫進該對話的分頁,`shouldRemember` 的判斷沿用。

專案層級的 `lastUrl` 欄位保留在 schema 裡,不再寫入。讀取時,專案裡 `sortOrder` 最小的對話分頁如果沒有自己的 `lastUrl`,
就拿專案層級的值當預設;其他分頁不繼承。

重啟後不主動重建 view。有 `lastUrl` 但沒有 session 的對話,網址列預填那個網址,按 Enter 才載入(§5.3)。

### 4.7 舊的 `persist:agent` 資料

留在磁碟上不動,這份規格不清它。

## 5. 網址列

### 5.1 元件

`src/renderer/components/BrowserBar.tsx`,放在 `PanelGroup` 的分頁列下方、`.panel-body` 上方,只在瀏覽器分頁是作用中分頁時出現。
`.panel-body` 的矩形由 `useReportBounds` 量,網址列佔掉的高度自動反映在回報的矩形裡,原生 view 不會蓋到它。

內容由左到右:上一頁、下一頁、重新整理(載入中時變成停止)、網址輸入框。輸入框取得焦點時全選,按 Enter 導航,按 Esc 還原成目前網址。

`BrowserBar` 依前景對話 id 當 `key` 重新掛載,切換對話時整個元件重建一次,還沒送出的輸入內容與顯示中的
錯誤不會帶到另一個對話。

### 5.2 IPC

| 名稱 | 方向 | 內容 |
|---|---|---|
| `browser:command` | renderer → main | `{ kind: 'navigate', url: string }` 或 `{ kind: 'back' \| 'forward' \| 'reload' \| 'stop' }`。一律作用在前景對話。用 invoke,回傳 `{ ok: true }` 或 `{ ok: false, message }` |
| `browser:state` | main → renderer | `{ conversationId, url, title, loading, canGoBack, canGoForward }`。來源是 `did-navigate`、`did-navigate-in-page`、`did-start-loading`、`did-stop-loading`、`page-title-updated` |
| `browser:sessions` | main → renderer | `{ conversationId, busy }[]`。`busy` 是該 session 有進行中的工具呼叫 |
| `browser:get` | renderer → main | renderer 重新載入後取回全部 session 的狀態,回傳 `{ states, sessions }` |

`browser:command` 跟 `layout:browser-bounds` 一樣檢查 `event.sender` 是左邊的 renderer,payload 用手寫的
guard(`parseBrowserCommand`,跟 `src/shared/ipc.ts` 其他 parser 同一種寫法,靠 `isRecord` 逐欄位檢查,不是
zod)驗,格式不對就記錯誤並丟掉。`navigate` 會呼叫 `ensure`,其餘四個在沒有 session 時不做事。

`browser:state` 每個 session 都推,renderer 只顯示前景對話那一份;切換對話時 renderer 手上已經有新前景的最新狀態,
網址列不會閃一下舊網址。

renderer 記著最近一次 `browser:sessions` 推送當下還活著的對話 id 集合;還沒收過推送時是 null。`browser:get`
的快照回來得晚,`states` 只採用這個集合以內的對話,`sessions` 只在集合是 null(還沒收過推送)時才採用快照那一份,
不然快照會把推送已經判定「session 沒了」的對話重新放回來。

### 5.3 輸入正規化

放在 `src/shared/` 的純函式,renderer 顯示錯誤與 main 實際導航用同一份:

1. 去頭尾空白。空字串不做事。
2. `localhost`、`127.0.0.1`、`[::1]` 開頭(可帶 port 與路徑)的補 `http://`。排在協定判斷之前,因為
   `localhost:3000` 的形狀跟協定一樣。
3. `協定://` 形式的,以及 `about:`、`javascript:`、`data:`、`blob:`、`mailto:` 開頭的,原樣往下,由白名單
   決定放不放行。
4. 其餘含 `.` 且沒有空白的補 `https://`。
5. 都不符合的回錯誤「這不是網址」,顯示在輸入框下方。不做搜尋引擎轉址。

正規化之後過 `checkNavigateUrl(url, projectDir)`,跟 `view_navigate` 同一份協定白名單與專案範圍限制。被擋下的原因顯示在輸入框下方。

### 5.4 空狀態

前景對話沒有 session 時,原生 view 全部藏著,`.panel-body` 顯示 React 畫的空狀態:

- 沒有 `lastUrl`:一句「這個對話還沒開過瀏覽器」。
- 有 `lastUrl`:「上次停在 <網址>」與一個「開啟」按鈕,網址列預填同一個網址。

## 6. 哪些對話有瀏覽器

對話分頁與專案列依 `browser:sessions` 顯示地球圖示(`Icon name="globe"` 已經有)。`busy` 時圖示套用
`LeftPane.css` 新加的 `@keyframes tab-browser-pulse` 讓透明度閃動;`theme.css` 既有的
`prefers-reduced-motion` 規則會停掉這個動態。
主廚的 worker 在背景開頁面驗收時,人從圖示看得出來,點那個分頁就看到它當下的畫面。專案列只在該專案有瀏覽器正在被操作時顯示。

## 7. 不會變的東西

- 八個瀏覽器工具的名稱、參數、回傳格式。
- `view_eval` 與 `view_navigate` 的批准規則(`view-tools/policy.ts`)。
- Codex 的 `dynamicTools` 接法。
- `request_handoff`:交接卡本來就在對話裡。背景對話要求接手時,人點那個對話,右窗格就是它的瀏覽器。
  `handoff:done` 在 `ipc-bridge.ts` 走 `withActive`,交給前景對話的 `core.handoffDone`,再到該對話自己的 session 的 handoff。
  人按「完成」時那個對話一定是前景,這條路不用改。
- controller 以下的實作(`controller-*.ts`、`settle.ts`、`watch.ts`、`snapshot*.ts`、`frame-offset.ts`)。

會變的一件:`MSG.browserBusy` 已刪除。

## 8. 錯誤處理

| 情況 | 處理 |
|---|---|
| `ensure` 失敗 | 工具呼叫回錯誤訊息給模型;網址列導航則在輸入框下方顯示。`logError` 記完整原因。不留半建好的 session 在表裡 |
| 對話關閉時還有進行中的工具呼叫 | 沿用 `abortAll(runtime, MSG.sessionEnded, true)` |
| view 的 renderer 行程當掉(`render-process-gone`) | `dispose` 那個 session,`browser:sessions` 更新。下一次工具呼叫或網址列導航會重新 `ensure` |
| 視窗關閉 | 逐一 `dispose` 全部 session,排在 `bridge.dispose()` 之後 |
| `browser:command` 在沒有前景對話時送來 | 不做事 |

## 9. 測試

### 9.1 單元測試(先寫)

- `browser-sessions`:用假的 view、假的 attach。`ensure` 同 id 併發只建一次;`ensure` 失敗後表裡沒有殘留、下次會重試;
  `show` 的先藏後顯順序;`dispose` 正在顯示的 session 會先藏;`dispose` 後 `get` 回 `undefined`。
- 轉接物件:沒有目標時 `setBounds` 不丟例外;換目標後舊的收到 `setVisible(false)`。
- 網址正規化:§5.3 五條規則各一組,含 `localhost:3000/path`、`example.com`、`hello world`、`javascript:alert(1)`(被白名單擋下)。
- IPC parser:`browser:command` 的五種 kind、缺欄位、多餘欄位、`url` 不是字串。
- schema:沒有 `lastUrl` 的舊分頁讀得進來;專案層級 `lastUrl` 當第一個對話預設值。
- `ipc-bridge`:切換前景不再中止舊對話的瀏覽器呼叫;對話分頁從 projects 狀態消失時(關閉分頁、專案被移除)會
  `dispose` 對應的 session,重新指定資料夾與主廚 worker 停止都不會。
- 範圍檢查:背景對話的 `view_navigate` 用自己專案的 `rootPath`,不是前景專案的。

### 9.2 實機驗收

八項目前的狀態見 docs/RESULTS-34-per-conversation-browser.md。

1. 開兩個對話,各自叫 agent 導航到不同頁面,兩邊都成功,沒有人收到 `瀏覽器正由前景對話使用`。
2. 在對話甲的頁面設一個 cookie,對話乙開同一個網域讀不到。
3. 切換對話分頁,右窗格的頁面與網址列一起換,網址列沒有出現舊對話的網址。
4. 手動在網址列輸入 `localhost:<port>`、`example.com`、一串中文,分別是載入、載入、顯示錯誤。
5. 上一頁、下一頁、重新整理、停止各按一次。
6. 關閉一個有瀏覽器的對話,用 `ps` 確認它的 renderer 行程消失。
7. 讓主廚派一個 worker 去開頁面,分頁上出現地球圖示,點進去看到它的畫面。
8. 重啟 app,有 `lastUrl` 的對話顯示「上次停在」的空狀態,按開啟後載入。

### 9.3 記憶體量測

一份可重複執行的腳本,量 0、1、3、6 個 session 時 YesChef 全部行程的 RSS 總和,頁面分 `about:blank` 與一個固定的真實頁面兩組,
每組跑兩次。結果寫進 `docs/RESULTS-*.md`,報每個 session 的平均增量。是否要加上限、上限多少,看這份數字決定。

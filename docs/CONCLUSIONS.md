# 結論索引

從 RESULTS 與 specs 抽出來、經過實測或型別檔核對的結論。已推翻的留在表上並指向取代它的那一列,
之後不會有人再從逐字稿或舊文件裡把它當成事實。

維護規則:RESULTS 新增或推翻一條結論時,同一個 commit 更新這張表。狀態只有兩種:成立、已推翻。
「未驗證」的東西不進這張表,那是規格的待辦,不是結論。

## 成本與 context

| 結論 | 狀態 | 依據 |
|---|---|---|
| yeschef 的 input 有 90.5% 到 94% 走快取讀取,未快取每輪只有 2 個 token;成本成長來自快取讀取量隨 context 線性增加 | 成立 | RESULTS-10 §1 |
| 第三方內容壓縮(headroom)會把快取讀佔比從 94% 拉到 59% 到 83%,連直通模式也掉;不採用 | 成立 | RESULTS-10 §2 |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 在 SDK 這條路上沒有作用 | 已推翻,見下一列 | RESULTS-10 初版 |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 有效:值夾在下限 100,000,門檻 = rawMaxTokens − 29,384,地板 70,616;實機在 70,354 觸發壓縮掉到 27,775 | 成立 | RESULTS-10 §3 |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 在本機沒有作用 | 成立 | RESULTS-10 §3 |
| auto-compact 在 SDK 模式下是開的,`isAutoCompactEnabled` 為 true,預設門檻 970,616 | 成立 | RESULTS-10 §3 |
| E 規格 §7 否決挪動 auto-compact 的理由「我們的門檻已經在它前面」 | 已推翻 | RESULTS-10 §3,規格已更正 |
| 壓縮摘要看不見、不能編輯 | 一半已推翻:摘要以 user message 注入對話,看得見;用之前不能編輯仍成立 | RESULTS-10 §3 |
| 壓縮摘要的旗標兩條路徑名字不同:live 是 `isSynthetic`,歷史是 `isCompactSummary`;SDK 型別檔只列前者 | 成立 | RESULTS-10 §3 |

## 批准與權限

| 結論 | 狀態 | 依據 |
|---|---|---|
| 讀取類 Bash 不經批准卡,是使用者層 `permissions.defaultMode: "auto"` 蓋過 `permissionMode: 'default'` 造成的 | 已推翻,見下一列 | RESULTS-08 |
| 讀取類 Bash 不經批准卡,是 `permissionMode: 'default'` 自己的行為;`settingSources` 改變不了 | 成立 | RESULTS-09 |
| `canUseTool` 只處理要問使用者的請求,攔不到設定已放行的工具 | 成立 | RESULTS-09,sdk.d.ts:4771 |
| `settingSources: ['project', 'local']` 讓使用者層的 hook 與 `permissions.allow` 不再進 yeschef 的 session;CLAUDE.md 仍載入 | 成立 | RESULTS-09 第 4、5 項 |
| `settingSources: []` 會連 CLAUDE.md 一起關掉 | 成立 | sdk.d.ts:2059 |
| 破壞性指令(`rm`)在 `'default'` 下會問,批准卡全程走得通 | 成立 | RESULTS-08 第 3 項、RESULTS-09 第 3 項 |
| 前景時已送到 renderer 的批准,切走再切回拿不回卡片,只能等 30 秒逾時 | 已修:renderer 的 pending 改成 registry 的鏡像,切專案只換過濾條件 | RESULTS-08 對規劃的影響、RESULTS-09 追加 |
| 批准在背景對話到達時扣在主行程,renderer 的卡數是 0(不是收著不顯示);分頁與專案格同時亮記號,切回該對話後 412 毫秒出現卡片 | 成立 | RESULTS-12 第 3 項 |

## 右窗格與 CDP

| 結論 | 狀態 | 依據 |
|---|---|---|
| CDP `Input.*` 在右窗格無焦點、整個視窗失焦時注入都可靠,三種狀態 200/200 | 成立 | RESULTS-02 現行結論 |
| 跨站 iframe 的 CDP 附著覆蓋率 16/16,分母來自 `Target.getTargets()` 重建的 frame 樹 | 成立 | RESULTS-03 現行結論 |
| 頁面內 JS 計數 iframe 的量測方法失準:穿不透 shadow DOM,且 `Target.getTargets()` 回整個 browser context | 成立 | RESULTS-03 錯誤 1、2 |
| `startViewTools()` 必須在 `loadAgentPage()` 之後,否則 CDP 附著必定逾時 | 成立 | RESULTS-05 §D 1 |
| OOPIF 的請求 requestId 跨 session 相同,結束事件由子 session 送;settle 的在飛集合不能用 `${sessionId}:${requestId}` 當鍵 | 成立,推翻契約裁決 30 的假設 | RESULTS-05 §D 2 |
| `window.open` 原本不經協定白名單與專案範圍限制 | 成立,已修 | RESULTS-09 第 6 項 |
| `checkNavigateUrl` 刻意不解 symlink,專案內指向外部的 symlink 仍會通過 | 成立,已知取捨 | urls.ts:19 註解 |
| 多專案共用同一個 `persist:agent` partition,不是 cookie 或登入狀態的隔離 | 成立 | agent-view.ts:3 |

## Recents 與 session

| 結論 | 狀態 | 依據 |
|---|---|---|
| 「本專案」Recents 原本是全域最新 100 筆的子集合,冷門專案會顯示空清單 | 成立,已修 | RESULTS-09 |
| SDK `listSessions({ dir })` 在來源端過濾並涵蓋 git worktree;962 場 session 時 32 ms,抓全部要 1188 ms | 成立 | RESULTS-09 |
| 搬走資料夾再 resume,新回合 cwd 會換,但逐字稿仍續寫回舊路徑 | 成立 | RESULTS-08 對規劃的影響 |
| `recordSession` 只跟最後一筆去重,同一 sessionId 隔著別的 session 再出現會重複 | 成立,已修 | RESULTS-08 觀察、RESULTS-09 |
| 新 Claude session 的逐字稿會進 `~/.claude/projects`,Insights 歸屬成立 | 成立 | RESULTS-04 §B,roadmap §1 |
| 一個專案的多個對話分頁各自是獨立的 session:兩條 thread、兩個 sessionId、兩份 transcript,畫面不互串 | 成立 | RESULTS-12 第 1、2 項 |
| 狀態檔版本 1 升到版本 2 實機成立:`linkId` 取 `sessionId`、`provider` 補 `claude`、`models` 補空,`.bak.0` 保留原檔,升版後舊 thread 照常接上 | 成立 | RESULTS-12 第 5 項 |
| 對話分頁的標籤序號取現有標籤的最大值加一,關掉中間的分頁再開不會撞名 | 成立 | RESULTS-12 第 4 項 |

## 多模型

| 結論 | 狀態 | 依據 |
|---|---|---|
| codex app-server(0.153.4)裸跑就是 stdio JSON-RPC;請求缺 `jsonrpc: "2.0"` 時完全不回、無錯誤訊息 | 成立 | RESULTS-11 |
| `thread/start.dynamicTools` 可用,前提是 `initialize` 宣告 `capabilities.experimentalApi: true`;宿主提供的 `ask_peer` 被 codex 呼叫、回覆進入最終答案,來回 12 秒 | 成立 | RESULTS-11 |
| `item/tool/call` 是 server 對 client 的請求,回覆前 turn 不結束,逾時由宿主管 | 成立 | RESULTS-11 |
| `item/commandExecution/requestApproval` 的方法名與時機經實跑確認:`approvalPolicy: 'untrusted'` 下 codex 會送它,回 `{ decision: 'accept' }` 指令就執行;不回或回錯誤,codex 記成 `Rejected("rejected by user")` | 成立 | 5b 實機驗收的獨立探針 |
| `thread/start` 不指定 `sandbox` 時預設 `{ type: 'readOnly', networkAccess: false }`,codex 會連批准都不問就拒絕檔案編輯;要 `sandbox: 'workspace-write'` | 成立,已修 | 5b 實機驗收、RESULTS-13 §2.2 |
| codex 未登入時 `thread/start` 照樣成功,是後面的 turn 收到上游 401 才失敗;錯誤從 `turn/completed` 的 `turn.error.message` 來,不是從 `thread/start` | 成立,推翻 5b 規格 §6 的假設 | RESULTS-13 §2.3 |
| `fold` 對沒有 `messageId` 的 `tool-use` 一律畫成未知事件(`fold.ts:509`);adapter 產生的工具事件一定要帶 `messageId` | 成立,已修 | 5b 實機驗收 |
| codex `model/list` 列出的模型不代表上游帳號能用:透過轉接站時 gpt-6-astra 在清單裡,實際 `turn/start` 回 404「not supported by any configured account」。錯誤只在第一個回合出現 | 成立 | RESULTS-39 §4 |
| codex app-server 起的對話會繼承使用者全域的 `model_reasoning_effort`;全域是 `max` 時,不支援 max 的模型(gpt-5.5)第一個回合就回 400 `unsupported_value`。要在 `turn/start` 明確帶 `effort` | 成立,已修 | RESULTS-39 §4 |
| `model/list` 的每個模型帶 `supportedReasoningEfforts` 與 `defaultReasoningEffort`;`config/read` 回傳有效設定,含 `model_reasoning_effort` | 成立 | codex-cli 0.158.0 實測 |

## 終端與程序存活

| 結論 | 狀態 | 依據 |
|---|---|---|
| tmux 混合成立:殺掉 yeschef 的 pty 不殺工作,新分頁 `attach` 回同一 session 並看到原畫面 | 成立 | RESULTS-07 §1 |
| 接回不需要自己存 scrollback,tmux 重繪已提供畫面連續性 | 成立 | RESULTS-07 §1 |
| 終端開分頁後約 8 秒打字不執行 | 已推翻:那是 p10k instant prompt 的既定行為,不是缺陷 | RESULTS-07 §4 |
| 終端 WebSocket 只綁 loopback 但無身分驗證;Origin 規則不是認證 | 已修:每次啟動產生 token,`verifyClient` 以 `timingSafeEqual` 比對,缺或錯一律 401;endpoint 只回給主視窗。實機對無 token、錯 token、Origin null 三種連線都回 401 | roadmap §5、RESULTS-09、fix/terminal-ws-token |
| pty 生命週期綁 WebSocket 綁 React effect,元件卸載或 renderer 重載就殺 shell | 已改:pty 起的是 tmux client,殺的是 client,session 活在 tmux server;沒有 tmux 時仍是舊行為 | RESULTS-07 §7 |
| 終端分頁與 tmux session 一對一,名字 `sp-<tabId 前 8 碼>`;殺 app 後接回同一個 session,關分頁才 kill-session | 成立 | RESULTS-07 §7 |
| `.pane-slot` 缺 `min-width: 0` 時視窗變窄終端會橫向溢出 | 成立,已修 | RESULTS-06 |
| 精確的 resize 欄數、輸入法組字中的行為,此環境測不了 | 成立,待人工 | RESULTS-06、RESULTS-07 §3 |

## 記憶體

| 結論 | 狀態 | 依據 |
|---|---|---|
| 2 個專案各 1 終端加 6 回合對話,Electron 全樹 617 MB;第 3 個專案多 80 MB | 成立 | RESULTS-08 記憶體 |
| 2 個終端加 tmux attach,全樹 353 MB、主行程 108 MB | 成立 | RESULTS-07 §2 |
| 多對話的記憶體上限由「同時活著的 SDK 子行程數」決定,不是對話分頁數:背景對話回合一結束就 sleep 收掉子行程。1 個對話 820 MB、3 個對話各跑過 1 回合 828 MB,行程數都是 6 | 成立 | RESULTS-12 §2 |
| Agent SDK 的 CLI 子行程單一 269 MB,是全樹 RSS 裡最大的一塊 | 成立 | RESULTS-12 §2 |
| RESULTS-01 的結論欄位沒有填 | 空白 | RESULTS-01 §結論 |

## 量測方法

| 結論 | 狀態 | 依據 |
|---|---|---|
| 「沒觀察到現象」不能拿來推論機制;能直接讀的值要先讀再設計實驗 | 成立 | RESULTS-10 §3 |
| 環境變數不能當「設定有沒有載入」的判準,子程序會直接繼承父程序的環境 | 成立 | RESULTS-09 對規劃的影響 |
| 量測中途改 fixture 會讓那一組失去比較基礎 | 成立 | RESULTS-10 §4 |
| 背景服務要記 pid,`pkill -f` 比對指令列會殺不到 | 成立 | RESULTS-10 §4 |
| 用 CDP 找 renderer 要比對 `out/renderer/index.html`,只比對 `index.html` 會在右窗格開同名檔時抓錯 | 成立 | RESULTS-09 對規劃的影響 |
| 用 `npx electron .` 起 app 時 `$!` 是 npm 外殼的 pid,SIGTERM 要送給 Electron 主行程 | 成立 | RESULTS-08 對規劃的影響 |
| 單元測試全綠不能代替實機驗收:`index.ts` 在覆蓋率排除清單,啟動順序沒有自動化測試 | 成立 | RESULTS-05 §D 1 |
| 兩層之間的契約要有跨層測試:5b 的 mapper 單元測試驗的是 `Event` 的形狀,驗不到 fold 拿到那個形狀會畫成什麼。少一個欄位就讓每個工具呼叫變成未知事件,1370 條測試全綠也照樣漏掉 | 成立 | 5b 實機驗收 |
| 判斷非同步流程結束不能用「一段時間沒有變化」:模型 thinking 階段不動 DOM,穩定門檻會提早觸發並判成失敗。要等它結束時才出現的標記 | 成立 | RESULTS-12 §3 |
| 比較記憶體要固定同一個 app 實例與同樣的回合狀態,否則量到的是兩邊對話量的差 | 成立 | RESULTS-12 §3 |
| Electron 的 `--user-data-dir` 同時決定 `app.getPath('userData')`,驗收時可以事前擺好狀態檔,不必經過原生資料夾選擇器 | 成立 | RESULTS-12 §0 |
| 背景對話的 sleep 與外部注入之間有競態:`onBusyChange(false)` 觸發的當下 sleep 還沒 dispatch,輸入排進 effects 鏈之後才發現 session 已經不是 live,那則輸入就被丟掉。人自己打字碰不到(人只能對前景對話打字),機器注入會碰到 | 成立,已修 | 5a 實機驗收 |
| 程序內 MCP server 的工具結果是內容陣列,`events.ts` 的 `rawOutputEvents` 只認字串與物件,所以 yeschef 自己的每個 MCP 工具呼叫都會多畫一個「未知事件」 | 成立,未修 | 5a 實機驗收 |
| 驗收前先確認「對方真的在忙」再動作:用 renderer 已經有的 `busyTabIds`,不要用「我覺得它應該還在跑」 | 成立 | 5a 實機驗收 |
| 每個對話核心有自己一份批准登錄表,`requestId` 各自產生。把「批准卡畫得出來」與「按下去會生效」當成同一件事,是跨層的盲點:兩端各自審過都對,中間那條界線沒有人驗 | 成立,已修 | 5a2 實機驗收 |
| renderer 只在事件發生的那一刻收到狀態的,視窗一重載就永久消失。凡是「只推不拉」的狀態都要配一條拉取入口(`projects:get` 有、`peer:get` 與 `approvals:get` 是這一階段補的) | 成立,已修 | 5a2 實機驗收 |
| 計時器用「每秒加一」在背景分頁會被節流而永久落後;要顯示經過時間就記起始時間戳、每次重算 | 成立,已修 | 5a2 實機驗收 |
| React hook 裡「先切專案再切分頁」的第二個呼叫會用到閉包裡的舊值。跨目標的動作要把目標當參數傳,不要靠前一個動作改變閉包 | 成立,已修 | 5a2 實機驗收 |
| grid 項目的 `min-width` 預設是 `auto`,`1fr` 那格不會縮到比內容還窄:一段長的行內程式碼就把整條對話撐出水平捲軸。內容欄一律寫 `minmax(0, 1fr)`,flex 版本是 `min-width: 0` | 成立,已修 | 版面缺陷,實測視窗 800 文件 1627 |
| 深色背景只畫在應用的根節點上不夠:一旦水平溢位,捲出去的那一塊是瀏覽器預設的白色。`html` 與 `body` 也要上同一個底色 | 成立,已修 | 同上 |
| 兩側的工具名稱不一樣(程序內 MCP 有前綴、codex 的 dynamic tool 是裸名),凡是比對工具名稱的地方都要兩種都認。漏一處就是那一側的功能靜默不存在 | 成立,已修 | 5c 最終審查 |
| 一件已知未修的小事會長出第二個後果:codex 的 `userMessage` 畫成未知事件本來只是多兩個空標記,5c 之後它讓同伴提問那一輪的角色標籤退回「你」 | 成立,已修 | 5c 實機驗收 |
| codex 的 item 種類會隨它的能力增加(`userMessage`、`imageView`、`sleep`、`webSearch` 是四次分別撞到的),mapper 認不得就畫成空的未知事件。一種一種追是錯的做法:預設路徑改成「以 type 命名的工具區塊」,新種類不必等我們補也看得懂 | 成立,已修 | 用 yeschef 跑 mirage 的工作 |
| 要知道對方到底有幾種東西,去問它的 schema 而不是一次撞一種:`codex app-server generate-json-schema` 的 `ThreadItem` 列了 19 種,我們專門畫的只有 10 種 | 成立 | 同上 |
| 畫面上還沒有任何地方畫得出圖片,右窗格的截圖工具也一樣。codex 的 `imageView` 目前只畫路徑 | 未修 | 同上 |
| 同一份清單寫在兩個地方就會漂移:主廚內部工具的自動放行名單漏了 `say_to_group`,另一份有;單元測試兩邊各自對,實機才看到批准卡 | 成立,已修 | RESULTS-39 §4 |
| `ws` 8.21.3 的 `send` 成功時 callback 收到 `null`,不是 `undefined`;用 `=== undefined` 判斷成功會把每個送出都當失敗 | 成立 | 群組驗收 spike 實測 |
| macOS 的 `mktemp` 給 `/var/folders/...`,`git rev-parse --show-toplevel` 回 `/private/var/folders/...`;`path.resolve` 不解 symlink,比對前要先 `realpath` | 成立 | 群組驗收 spike 實測 |
| 用 DOM 計數「送出前」的回合數,分頁還沒掛載時讀到 0,前後量法不一致會誤判。前後都要用同一個不依賴掛載的來源(持久化事件或 session 紀錄) | 成立 | RESULTS-39 §3 |
| 讓 LLM 自己判斷「做不到」來製造卡住的情境不穩定:同一個目標兩次跑,一次直接回報 blocked,一次先去做別的事再說要回報。驗收的判斷要能容許模型換順序,或先排除干擾它的輸入 | 成立 | RESULTS-39 §4 |

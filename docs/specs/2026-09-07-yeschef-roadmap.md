# yeschef 完整規劃

Claude 與 codex(gpt-6-astra)共同分析。這份取代 `2026-09-07-orca-adoptable-design.md` 裡關於 daemon、Tailscale、採用順序的結論(見第 7 節更正)。

## 0. 這份文件要回答什麼

立項前提消解、Orca 已做得更多之後,yeschef 還要不要做、做到哪、用什麼架構、按什麼順序。兩個模型獨立分析後綜合,結論以判斷呈現。

## 1. 誠實定位

值得繼續,但當成有成本上限的個人工具,不要做成另一個 Orca。

誠實定位:給自己用的繁中、單機、多 CLI 工作台,以專案整理終端,能就近預覽產物,並從手機接回工作。Claude 用量歸屬已是相容性驗收條件(實測確認會進 `~/.claude/projects`),不再是立項理由。繁中與簡單構成個人使用價值,但不足以合理化整套 agent 平台的維護成本。

範圍限單人、macOS、單台主機。不做跨機同步、完整手機 IDE。平行 orchestration 只做限定形式:兩個 session、阻塞式問答、檔案信箱、單機(2026-09-09 使用者裁決,見第 9 節;原文寫「不做平行 orchestration」)。繁中只保證在外殼,CLI 本身的英文介面不翻。已投入 A/B/C 的成本不能當作繼續擴張的理由;接下來要證明的是 projects、預覽、手機接續是否讓你每天更願意用它。

## 2. 三個要先對齊的現實

### 2.1 A+B+C 不等於整合工作流

C 的跨 model 只在終端層。B 的右窗格瀏覽器工具是 SDK 內嵌 MCP,只接 Claude;你在終端裡啟動的 codex、grok 不會自動接上這些瀏覽器工具。這要當成明確限制寫進契約,不能把 A、B、C 的功能相加就宣稱已成整合工作流。

### 2.2 「桌機關著也能用」要拆成四種

| 情況 | 誰做得到 |
|---|---|
| 關左窗格分頁 | 常駐 session 就行(tmux 或 daemon) |
| 退出 Electron、主機仍醒 | 常駐 session 就行 |
| 主機睡眠 | 沒有方案能讓睡眠中的主機繼續運算 |
| 主機關機 | 沒有方案能跨關機存活 |

你先前裁決 A 路的理由是「桌機關著也能用」。若指的是睡眠或關機,任何方案(含 Orca)都給不了;能給的是「退出 app、主機醒著時手機接回」。這條要先定義清楚,否則規格承諾做不到的事。

已定案(2026-09-07 使用者裁決):走 tmux 混合(不自寫 daemon);app 常駐即可、不追求關 app;真正在意的情況是主機睡眠。

主機睡眠的處理:睡眠中 CPU 停止,沒有方案能在睡眠主機上運算或服務連線,所以不做「睡眠中仍可用」。正解是讓主機在需要遠端時不要睡:yeschef 常駐,偵測到手機已連線或 agent 正在執行時,用 Electron 的 `powerSaveBlocker`(`prevent-app-suspension`;或 macOS `caffeinate`)擋系統睡眠;沒有遠端連線也沒有執行中工作時放它正常睡,不耗電池。誠實界線:擋睡眠時筆電較耗電;離電源且關蓋這類作業系統強制睡眠仍會發生,那時手機只能等主機醒。這個「按需擋睡眠」列進 roadmap 第 4 項。

### 2.3 自持與 Tailscale 的界線

前一份 spec 寫 Tailscale「零雲、零 relay」是錯的。Tailscale 在打不通直連時會經第三方 DERP 中繼加密流量。若你的自持底線是「第三方看不到內容」,Tailscale 的端對端加密可接受;若底線是「連密文與控制服務都不得經第三方」,預設 Tailscale 不符,要另付自管網路與可達性的成本。手機那條的傳輸選型要照這條底線重定。

## 3. 架構修正:不自寫 daemon,用 tmux 承接程序存活

### 3.1 自寫 daemon 的真成本

現在的終端伺服器是「一條 socket 建一個 pty,斷線就 kill」(`src/main/terminal-server.ts`)。要做到程序持續執行,得改成獨立 session、attach/detach、明確終止、畫面同步、流量控制、版本相容。這不是把檔案搬到背景行程,而是重寫 Orca 花最多次數迭代的那一塊。`daemonProtocolVersion=36` 只證明版本編號,不證明架構好壞,但持久 session 本身確實是這套裡最難做穩的。

### 3.2 tmux 混合路線

程序存活交給 tmux:它已提供 detach 後繼續執行與重新 attach,yeschef 的 pty 先承接一個 tmux client。projects 自己做。手機先用既有 SSH 終端驗證接續是否好用,再決定要不要做繁中網頁介面。

這仍有背景服務,但最難的程序持有不由你重寫。代價:多一個相依、巢狀終端行為、尺寸處理,必須用真實 CLI 驗證。只有 tmux 混合遇到具體、反覆的阻礙,才升級成自寫 daemon(見 roadmap 第 5 項)。

### 3.3 這重新檢視你的 A 路裁決

先前定案「A 路自寫 daemon」。兩個模型獨立分析都建議改成 tmux 混合:同樣拿到「退出 app 工作仍在、手機接回」的價值,不必自寫最難的程序持有層。這是要你再定一次的決策點。

## 4. 修正後的 roadmap(價值優先,基礎設施最後)

原「序列化 → daemon → 手機」把價值最不確定的手機放在成本最高的地基之後。改成下列順序。這是完整規劃,不是全部塞進四週。

| 順序與相依 | 最小可交付 | 驗收與停止點 |
|---|---|---|
| 0. 定契約、補 C 驗收 | 定義關窗／退出／睡眠行為與自持界線;補 resize、中文輸入、多行貼上、CLI 缺裝提示;終端就緒前顯示啟動中狀態 | 真實 claude/codex 操作正常;grok 未裝就標示;量測常用配置記憶體。991 測試綠不能代替這些。已驗:中文輸入、多行貼上、記憶體(`docs/RESULTS-07-tmux-spike.md`);待人工:輸入法組字、resize 精確欄數 |
| 1. Projects(依賴 0) | 資料夾選擇、最近專案、終端歸屬、標題、啟動 cwd、分頁清單;CLI 與 SDK session 分開辨識 | 切兩個 repo 不殺工作、不串 cwd;資料夾搬移可重新定位;新 Claude session 經真實月評量流程確認歸屬 |
| 2. D 最小版(依賴 1) | 手動選專案內 `.md`／`.html`、預覽、自動重載、返回瀏覽器;沿用現有渲染 | 真實 agent 改檔後能讀;相對圖片正常;Markdown 清理未信任 HTML,HTML 預覽不能碰 Node、終端憑證或專案外檔 |
| 3. 有限歷史保存(依賴 1,已降級) | 有容量上限的終端快照、定期原子寫入、清歷史;還原時標示歷史與程序狀態 | 正常退出可還原;強制中止至多遺失約定時間窗;單檔損毀不拖垮專案;還原不自動重跑舊指令。實測 tmux 重繪已提供接回的畫面連續性,此項不是接回前置,只服務「app 完全關閉後仍想讀舊內容」 |
| 4. 存活與手機可行性(依賴 0、1,可早於 3 試作) | tmux 持有工作、yeschef attach;手機用既有 SSH 終端接同一 session;手機連線或 agent 執行中時用 `powerSaveBlocker` 按需擋主機睡眠,閒置放行 | 退出 Electron 後工作仍在;手機能看結果、答權限、Ctrl-C;擋睡眠只在有遠端或有工作時生效、閒置會正常睡;斷網重連、橫直向與桌手機切換可用。手機實際不好用就停 |
| 5. 有條件自建 daemon(依賴 4 證明必要) | 只有 tmux 混合遇到具體阻礙才做;本機 session registry、headless 狀態、attach/detach/terminate、單一輸入控制者、協定版本 | 關窗與重啟 UI 不殺工作;重連無遺漏重複;慢 client 不吃爆記憶體;可裝可停可升級可移除;daemon 崩潰不假裝原程序還在 |
| 6. 手機網頁版(依賴 4 與選定後端) | 薄網頁閘道或 daemon 遠端入口;專案／session 清單、終端、特殊鍵、控制權切換 | 真機中文輸入、貼上、鍵盤遮擋、鎖屏恢復、網路切換過;登入、裝置撤銷、Origin、HTTPS/WSS 與網路存取限制過;未知 client 不能開 shell |
| 7. 工作流整合收尾(依使用證據) | CLI 若確實需要 B/D 才加標準 MCP 入口;再考慮等待批准狀態、搜尋、進階預覽 | claude/codex 各完成一次「產出 → 預覽 → 修正」;桌面未開時瀏覽器工具明確回報不可用;每個新增能力都有實際使用理由 |

三個相依關係更正:

- Projects 不依賴 daemon,也不依賴 scrollback。它先解決工作歸屬與返回入口;project 切換還牽動 SDK cwd、瀏覽器工具的路徑範圍、預覽 watch,不是只把 C 的分頁狀態多包一層。
- 磁碟歷史不是遠端重連的必要前置。重連要的是可信的當前終端狀態加上 snapshot 到後續輸出的連續性;renderer 關閉時存一次 buffer 保證不了。用 tmux 就優先靠它的重繪,不要再養第二套會互相衝突的狀態。
- 手機第一版只接終端。A 的對話、B 的 Chromium、人機交接不會因 pty 移到常駐層就自動遠端化;一起搬過去,範圍就接近重做 Orca。

WebGL 不列架構前置。目前只有 resize 量測不穩的紀錄,沒有它能解決根因的證據。先修正並驗證尺寸、字型與隱藏分頁行為,再依效能量測決定是否換。

## 5. 最大的五個風險

| 風險 | 緩解 |
|---|---|
| 策略:為了繁中與簡單,最後維護一套更複雜的平台 | 四週設停損,以真實使用頻率與減少的切換成本決定續做,不以功能完成數判斷 |
| 可靠性:把歷史畫面誤當程序續存,或重連時漏輸出、重送輸入 | 優先用既有的 session 工具(tmux),明定歷史／存活／終止狀態,對斷線與重啟做故障驗收 |
| 安全:手機入口把本機權限 shell 變成網路服務 | 認證先於遠端開放;現有允許 `null`／`file:` 的 Origin 規則不能當身分驗證;隔離預覽內容與終端憑證 |
| 維護:SDK、Electron/CDP、CLI TUI、daemon、手機多套生命週期 | 凍結 A 擴充、遠端只含終端、為背景服務提供明確啟停與版本檢查 |
| 可用性與資源:筆電睡眠、手機鍵盤、常駐成本抵銷便利 | 第一週就用真手機真網路測,量測記憶體,接受主機須醒著,不承諾隨時可用 |

## 6. 四週怎麼走

- 第一週:補 C 驗收(roadmap 0),並試通 tmux 與手機 SSH 接續(roadmap 4 的可行性)。
- 第二週:完成 projects(roadmap 1)。
- 第三週:交付 D 最小版與有限歷史(roadmap 2、3)。
- 第四週:只拿它做真實工作、修阻礙。

沒有反覆出現、既有工具解不了的卡點,就不啟動自寫 daemon;使用價值不足就停在可用的 C＋projects＋preview。

## 7. 對前一份 spec 的更正

`2026-09-07-orca-adoptable-design.md` 第 4.5.3 的下列結論被本文件取代:

- 「走 A 路自寫 daemon」改為「先走 tmux 混合,daemon 列為有條件、需證明必要的後段」。
- 「Tailscale 零雲、零 relay」是錯的:Tailscale 可能經第三方 DERP 中繼(加密),自持底線要重定(第 2.3 節)。
- 採用順序改為價值優先:D 預覽往前拉、daemon 往後推(第 4 節)。
- Projects 不依賴 daemon 或 scrollback。
- WebGL 不是架構前置。

## 8. 分工與依據

- 分析:Claude(Opus)與 codex(gpt-6-astra,low)各自獨立分析後綜合。tmux 混合、A+B+C 非整合、睡眠／關機拆解、Tailscale DERP、D 往前拉,主要來自 codex 的獨立分析。
- 事實依據:實測 Orca 1.4.197、yeschef repo 的 A/B/C 規格與 RESULTS、`src/main/terminal-server.ts` 現況。
- 外部參考:tmux 手冊(man.openbsd.org/tmux)、Tailscale 流量路由說明(tailscale.com/docs/concepts/traffic-routing-through-tailscale)。

## 9. 修訂紀錄

| 日期 | 變更 | 依據 |
|---|---|---|
| 2026-09-07 | 初版:Claude 與 codex gpt-6-astra 共同分析 | 見第 8 節 |
| 2026-09-07 | 使用者裁決:採 tmux 混合(不自寫 daemon);app 常駐即可;主機睡眠以 powerSaveBlocker 按需擋睡眠處理,不做睡眠中服務 | 使用者裁決 |
| 2026-09-07 | tmux 可行性實測通過,第 4 項假設成立;第 3 項降級為非接回前置;第 0 項新增終端啟動中狀態;中文輸入與多行貼上已驗過 | `docs/RESULTS-07-tmux-spike.md` |
| 2026-09-08 | 子專案 E 暫停:使用者確認 E 的動機是成本,而 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 已把穩定狀態的 context 從 97 萬壓到 7 萬(已接進 yeschef,對話裡有壓縮分隔線)。E 剩下的價值(交接檔可改、跨模型可攜、分段歷史)使用者表示都不是主要需求。第 4 節的表不列 E;真實使用一週後若出現「壓縮後接續品質不夠」再重開,範圍改為品質不是成本 | `docs/RESULTS-10-context-cost.md`、`docs/CONCLUSIONS.md` |
| 2026-09-08 | 第四週「只拿它做真實工作」從未發生,所有子專案都在推測需求下完成。決定停止加功能,先真實使用一週再依阻礙選第 2 項(預覽)、第 4 項(tmux 持有)或 E | 使用者裁決 |
| 2026-09-09 | 使用者提出六項需求後重新定位。#1 異地使用縮小為第 4 項原本的範圍(tmux 持有加手機 SSH 接終端,不接左窗格);#5 多模型互動放大為限定形式的平行 orchestration:兩個 session 之間用檔案信箱與 `ask_peer` 工具做阻塞式問答,Claude 對 Claude 先做,codex 靠 app-server 的 `dynamicTools`(實驗性,先 spike)。§1 的「不做平行 orchestration」改為限定形式。順序:第 4 項 tmux 接線與手機實測 → codex `dynamicTools` spike → #5 規格 | 使用者裁決 |
| 2026-09-09 | 第 4 項 tmux 半邊完成並實機驗過:分頁與 session 一對一、殺 app 接回、關分頁才殺。手機 SSH 實測待使用者開 Remote Login 後進行;`powerSaveBlocker` 未做 | `docs/RESULTS-07-tmux-spike.md` §7 |
| 2026-09-09 | 第 2 步 codex `dynamicTools` spike 通過:宿主提供的 `ask_peer` 被呼叫、回覆進入答案。方案 B 的 codex 半邊成立,進入第 3 步寫 #5 規格 | `docs/RESULTS-11-codex-dynamic-tools.md` |
| 2026-09-09 | 子專案 P 規格完成(`2026-09-09-yeschef-peer-design.md`)。自查發現同專案兩個 Claude session 需要 D 沒做的多對話執行期(D2),使用者裁決順序改為 5b codex adapter → 5c Claude 對 codex,D2 與 5a 延後。實作委派 codex gpt-6-astra | 使用者裁決 |
| 2026-09-09 | 更正前一列:`agent:events`、`session:state` 與 renderer 的 view 都是每專案一份,同一專案的第二個對話不論是 Claude 還是 codex 都需要 D2。順序改為 D2 → 5b → 5c;5a 在 D2 之後依需求 | 5b 設計時發現 |
| 2026-09-09 | 子專案 D2 完成並實機驗收通過(六項全過)。實作由 codex gpt-6-astra 逐 task 完成,Claude 逐 task 審查;11 個 commit,60 檔 1276 條測試綠。下一步是 5b codex 對話分頁 | `docs/RESULTS-12-d2-acceptance.md` |
| 2026-09-10 | 子專案 5b 完成並實機驗收通過(六項全過)。23 個 commit,64 檔 1377 條測試綠。驗收抓到五個單元測試與六輪審查都沒抓到的缺陷(工具呼叫畫成未知事件、唯讀沙箱、未登入訊息、codex 分頁沒有新對話入口、換對話時舊事件殘留),全部已修。下一步是 5c(Claude 對 codex 的 `ask_peer`) | `docs/RESULTS-13-5b-acceptance.md` |
| 2026-09-10 | 5c 沒辦法單獨做:P 規格 §8 把信箱、兩個工具、注入、逾時、死鎖、重啟取消全放在 5a,5c 只是「codex 那邊也接上這兩個工具」。5a 拆成兩個計畫:先做機制與工具(兩個 Claude 對話互相問答),再做畫面與人的介入,最後 5c 接 codex | 寫 5a 計畫時裁決 |
| 2026-09-10 | 子專案 5a 第一階段完成並實機驗收(六項:五項通過,第三項抓到缺陷、修掉後重驗通過)。16 個 commit,67 檔 1458 條測試綠。缺陷是背景對話 sleep 與注入之間的競態,提問被丟掉、提問方等滿 10 分鐘。這一階段 codex 對話還不會被登錄成可提問對象。下一步是 5a 第二階段(畫面與人的介入) | `docs/RESULTS-14-5a-acceptance.md` |
| 2026-09-10 | 子專案 5a 第二階段完成並實機驗收通過(七項全過)。15 個 commit,74 檔 1566 條測試綠。整支審查抓到一條七個 Task 各自審查都沒抓到的阻擋項:別的對話的批准卡按下去不會有作用(批准回覆一律送前景對話,但每個核心的 requestId 各自產生)。批准逾時 30 秒改 5 分鐘,並補上 `peer:get` 與 `approvals:get` 兩條拉取入口。下一步是 5c(codex 那邊也接上兩個工具) | `docs/RESULTS-15-5a2-acceptance.md` |
| 2026-09-10 | 子專案 5c 完成並實機驗收通過(六項全過,兩個方向)。5 個 commit,74 檔 1603 條測試綠。接線前先用獨立探針問過協定三件事(`thread/resume` 收 dynamicTools、兩個工具能並存、工具回失敗時錯誤文字進到模型的答案),沒有猜。驗收抓到 codex 那側的同伴提問角色標成「你」(mapper 沒處理 `userMessage`,RESULTS-13 §5 記過但沒修);最終審查另外抓到提問方那側的兩顆按鈕在 codex 不會出現。同伴問答自此在 Claude 與 codex 兩個方向都跑通 | `docs/RESULTS-17-5c-acceptance.md`、`docs/RESULTS-16-5c-probe.md` |
| 2026-09-10 | 版面缺陷修正:`.turn` 的 grid 內容欄沒有寫 `minmax(0, 1fr)`,一段長的行內程式碼就把整條對話撐出水平捲軸(實測視窗 800、文件 1627),而深色底只畫在應用根節點上,捲出去是白的。三處都修並實測 | `docs/CONCLUSIONS.md` |
| 2026-09-12 | 第 4 項後半 `powerSaveBlocker` 完成並實機驗收(四項全過)。訊號只有「任何對話在忙」,手機連線訊號等 SSH 實測後再加。同日開始批次清債(RESULTS-14 到 21 的已知缺陷)與第 7 項(codex 對話接 view 工具)的協定探針 | `docs/RESULTS-23-sleep-guard.md` |
| 2026-09-12 | 批次清債完成並併入(RESULTS-25):MCP 工具結果的未知事件、歷史檢視的花費、沒切到前景的對話不在同伴清單、預覽重試。整支審查抓到回合結束時同步注入被 sleep 打斷的競態,已修。同日 codex 對話的歷史清單完成(RESULTS-24):用 app-server 的 `thread/list` 與 `thread/items/list`,不解析 jsonl;整支審查抓到開歷史時吞輸入,已修 | `docs/RESULTS-25-debts-a.md`、`docs/RESULTS-24-codex-history.md` |
| 2026-09-12 | 第 7 項的核心完成並併入(RESULTS-26):codex 對話經 app-server 的 `dynamicTools` 拿到右窗格八個工具,批准、白名單、rootPath、前景互斥、切走中止全部沿用主行程既有零件;設計前用探針實測九個協定問題(RESULTS-22)。§2.1「codex 接不上瀏覽器工具」的限制自此解除。新增的攻擊面:`view_navigate` 到任意 http/https 不需批准,`workspace-write` 沙箱下的 codex 因此有一條把資料編進 URL 送出去的管道,與 Claude 同政策,要不要對 codex 收緊另議 | `docs/RESULTS-26-codex-view-tools.md` |
| 2026-09-13 | codex 的 `view_navigate` 改為要批准(沙箱裡沒有網路,view 工具不該替它開免批准外連;Claude 不變)。降速「只在 agent 有動作時關」量過不做(執行中切換不更新 `visibilityState`)。分隔條完成(RESULTS-28):spike 證實越界後 renderer 收不到事件,靠 renderer 佔滿視窗、拖曳期間藏瀏覽器做到;真滑鼠驗收抓到合成事件抓不到的 `lostpointercapture` 收尾問題,兩個把手都修。非人工的待辦至此清空;剩手機 SSH、輸入法組字、resize 欄數三項要使用者動手 | `docs/RESULTS-28-panel-divider.md`、`docs/specs/2026-09-11-shell-regions-design.md` §3 |
| 2026-09-15 | 第 4 項全部完成(RESULTS-29):使用者開 Remote Login 後用 iPhone Termius 接同一個 tmux session 並打字成功;遠端 client 接著時擋睡眠、離開後放行(用 `tmux list-clients` 的 pid 減掉 yeschef 自己的)。手機 app 的 Ctrl 鍵送不出,離開靠 `tmux detach`。沒驗到:手機答權限、Ctrl-C、橫直向 | `docs/RESULTS-29-phone-ssh.md` |


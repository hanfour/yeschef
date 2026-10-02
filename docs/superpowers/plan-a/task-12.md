### Task 12: 整合驗收（端對端手動檢查清單）

這是整份計畫的最後一個 task，不寫新功能。它存在的理由是裁決 18：每個 task 的手動檢查只能包含該 task commit 當下就能操作的項目，所以「要整個 app 跑起來才驗得到」的項目全部被推到這裡。前面每個 task 都只驗了自己那一層，沒有人驗過這些零件裝在一起會怎樣。

本 task 做三件事：

1. 逐項執行下面 A 到 H 八組檢查，每一項填 `✓ / ✗` 與「現象」欄。
2. 對發現的缺陷做一次分流：20 行以內且不改任何介面的修正在本 task 直接做並補上單元測試；其餘記進待辦，不硬修。判準寫在 Step 9。
3. 產出 `docs/RESULTS-04-a-sdk-host.md`，體例照 `docs/RESULTS-01-memory.md`（量測日期、機器、量測方法、步驟、結果表、判準）。

**不重複已經驗過的項目。** Task 8 的 Step 10已經驗完 preload 的暴露面五項與壞 payload 兩項，Task 10 的手動清單（Step 6 之後的「手動檢查清單」一節）已經驗完批准卡片的鍵盤操作，Task 11 的手動清單（Step 7 之後的「手動檢查清單」一節）已經驗完 Recents 的三項。本清單只在需要「整條路徑一起動」時引用它們，寫成「Task 11 清單第 3 項在此重跑一次」，不抄內容。

Task 8 Step 10 區塊 2 的十項與區塊 3 的三項在本清單被拆進三組，對照如下，任何一項都沒有被丟掉：

| 原出處 | 原項目 | 本清單位置 |
|---|---|---|
| 區塊 2 第 1、2 項 | 逐字出現、長回覆完整 | C1、C2 |
| 區塊 2 第 3、4、5 項 | 批准卡片內嵌、允許、拒絕 | D1、D2、D3 |
| 區塊 2 第 6 到 10 項 | Recents 五項 | E1 到 E5 |
| 區塊 3 第 1 項 | 批准中關視窗無殘留 | D5 |
| 區塊 3 第 2 項 | 批准中切換 session | D6 |
| 區塊 3 第 5 項 | 批准逾時 | D4 |

**Files:**
- Create: `docs/RESULTS-04-a-sdk-host.md`（本 task 的唯一必產出）
- Modify: 視 Step 9 的分流結果而定，事前無法列舉。每一筆修改都要在 `RESULTS-04` 的「本 task 做掉的修正」一節留下檔案與行數

**Interfaces:**
- Consumes: 全部十一個 task 的產出。本 task 不定義新介面，也不得修改任何既有介面（Step 9 的判準第二條）
- Produces: `docs/RESULTS-04-a-sdk-host.md`

本 task 沒有新的單元測試，突變測試不適用。若 Step 9 做了修正，該修正必須附一條會因它變綠的測試，那條測試照 Global Constraints 做突變驗證。

---

- [ ] **Step 0: 準備環境與報告範本**

先建 `docs/RESULTS-04-a-sdk-host.md` 的範本再開始跑，理由是清單有三十九項，跑到一半才開檔案會漏記現象。範本的完整內容見 Step 10。

環境準備四件事：

```bash
# 1. 確認在正確的分支且工作區乾淨
git status
git branch --show-current   # 預期 feat/a-sdk-host

# 2. 準備兩個目錄：本次要用的專案目錄，以及一個「別的專案」（B3、E1 要用）
ls -d "$HOME/Projects/你的專案"
ls -t ~/.claude/projects | head -20   # 先看一眼現況，B 組要比對前後差異

# 3. 記下起始狀態，B1 用它判斷哪個目錄是新出現的
ls -t ~/.claude/projects > /tmp/projects-before.txt

# 4. 確認 API key 可用（F 組會故意弄壞它，先確認壞掉之前是好的）
echo "${ANTHROPIC_API_KEY:0:8}..."
```

啟動指令固定為：

```bash
YESCHEF_PROJECT_DIR="$HOME/Projects/你的專案" npm run dev
```

`npm run dev` 在 dev 模式會自動開 DevTools（Task 8 Step 6b 的 `loadRenderer`），A、C、D、E、F 幾組要看主程序 log 的地方都在啟動這個終端機的視窗裡看，要看 renderer 錯誤的地方在 DevTools 的 console 看。兩處都要看，只看一邊會把「畫面沒反應」誤判成「功能沒做」。

在報告的表頭記下：量測日期、機器（`sw_vers -productVersion`、`uname -m`、記憶體大小）、Node 與 Electron 版本（`node -v`、`npx electron -v`）、`@anthropic-ai/claude-agent-sdk` 版本（`npm ls @anthropic-ai/claude-agent-sdk`）。這些數字之後對不上時要靠它們判斷是環境變了還是程式壞了。

---

- [ ] **Step 1: A 組，啟動與守門（5 項）**

守門的實作在 Task 1 Step 3 的 `buildSessionOptions`，呼叫點在 Task 8 Step 6b 的 `requireProjectDir`（啟動時空跑一次）與 `createSessionOptionsFactory`。這一組驗的是「設錯環境變數時會不會是靜默失敗」，規格 §3.2（第 89 行）說明了為什麼要擋：`YESCHEF_PROJECT_DIR` 決定新對話開在哪，也就是 Insights 的歸屬。

每一項都是啟動一次、看終端機、關掉，不需要進到 UI。

| # | 操作 | 預期 | 結果 | 現象 |
|---|---|---|---|---|
| A1 | 不設環境變數：`unset YESCHEF_PROJECT_DIR; npm run dev`，然後 `echo $?` | 終端機印出 `[yeschef] 未設定環境變數 YESCHEF_PROJECT_DIR` 加三行怎麼設的指示；沒有任何視窗閃出來；exit code 是 1 | ✓ / ✗ | |
| A2 | 設成不存在的目錄：`YESCHEF_PROJECT_DIR=/nope/nope npm run dev` | 印出 `YESCHEF_PROJECT_DIR 的值不可用：projectDir 不存在：/nope/nope`；exit code 1 | ✓ / ✗ | |
| A2b | 設成 app 自身目錄：`YESCHEF_PROJECT_DIR=$PWD npm run dev` | 印出「不可為 app 自身目錄或其子目錄」與「逐字稿會落在被 Insights 排除的路徑下」；exit code 1 | ✓ / ✗ | |
| A3 | 設成 symlink：`ln -s "$HOME/Projects/你的專案" /tmp/proj-link`，用 `/tmp/proj-link` 啟動，送一則訊息，然後看新產生的 `.jsonl` 第一列的 `cwd` 與它所在的目錄名 | `cwd` 是 realpath 後的 `$HOME/Projects/你的專案`，檔案落在該路徑編碼的目錄下，不是 `-private-tmp-proj-link`。見下方註記 | ✓ / ✗ | |
| A4 | `npm run build` 之後 `ls -l out/preload/bridge.cjs`，再 `YESCHEF_PROJECT_DIR=... npm run start` | build 成功；`bridge.cjs` 存在且大小不是 0（Task 0 的空殼是 0 到數十位元組，Task 8 填完之後應該是數 KB）；`start` 開得起來，左窗格是對話介面不是白畫面 | ✓ / ✗ | |

A1 到 A2b 的三項共同要驗的是「不是白畫面」：如果看到視窗先開出來、左窗格空白、終端機沒有訊息，代表守衛的位置跑到 `createWindow` 之後了，那是 Step 6b 明確排除的順序。

`exit code` 的取法：`npm run dev` 會被 npm 包一層，用 `npm run dev; echo "exit=$?"` 看到的可能是 npm 的 code 而不是 Electron 的。要確認 Electron 自己的 code，改看終端機是否出現 `ELIFECYCLE` 加 `Command failed with exit code 1`，或直接跑 `npx electron-vite dev; echo "exit=$?"`。兩種都記進現象欄。

A3 的依據：Task 1 的 `buildSessionOptions` 回傳 `cwd: input.projectDir`，是使用者給的原字串，`realpathSync.native()` 只用在守衛的比對。symlink 路徑會原樣交給 SDK 當 spawn 的 cwd，但 CLI 讀的是 `process.cwd()`，而 macOS 的 `getcwd(3)` 回傳的是解析過符號連結的實體路徑（本機驗證：`cd /tmp && node -p process.cwd()` 印 `/private/tmp`）。所以逐字稿的 `cwd` 欄位與所在目錄都會是 realpath，與 Task 1 傳什麼字串無關。這一項若是 ✗，代表 CLI 的行為與上述不同，把實際的 `cwd` 值與目錄名寫進現象欄，分流交給 Step 9。

---

- [ ] **Step 2: B 組，Insights 歸屬（3 項加 1 個負面案例）**

這一組是整個專案存在的理由。規格 §1（第 23 行）第一條已查證事實是「Agent SDK 會寫逐字稿到 `~/.claude/projects/`，路徑與 CLI 一致，Insights 讀得到」；規格 §2.3（第 50 行）把 Recents 列為堪用門檻。如果 yeschef 的對話沒有落在正確的專案目錄下，前面十一個 task 做的每一件事都不算數，而且這是靜默失敗，畫面上一切正常。

目錄的編碼規則：專案路徑的每一個 `/` 換成 `-`。實機確認過（本機 `~/.claude/projects` 底下 39 個目錄，例如 `/private/tmp` 對應 `-private-tmp`）。不要自己算，用 `ls -t` 看哪個目錄剛被更新最準。

| # | 操作 | 預期 | 結果 | 現象 |
|---|---|---|---|---|
| B1 | 用 `YESCHEF_PROJECT_DIR="$HOME/Projects/你的專案"` 啟動，完成一則來回對話（問一句、等它答完）。關掉之後跑 `ls -t ~/.claude/projects \| head -3` 與 `diff /tmp/projects-before.txt <(ls -t ~/.claude/projects)` | 最上面那個目錄是 `$HOME/Projects/你的專案` 的 `/` 換 `-` 版本；該目錄下 `ls -t \| head -1` 是一個剛產生的 `.jsonl` | ✓ / ✗ | |
| B2 | 對 B1 的那個 `.jsonl` 跑 `head -1 檔案 \| jq -r .cwd`，另外跑 `realpath "$HOME/Projects/你的專案"` | 兩者相等 | ✓ / ✗ | |
| B3 | 重新啟動（環境變數維持 B1 的值），在 Recents 點一條屬於**別的專案**的歷史對話，輸入一句話接續它。等它答完之後看該 session 的 `.jsonl` 新增的列 | 新增的列落在那個專案的目錄，`jq -r .cwd` 是那個專案的路徑，不是 `YESCHEF_PROJECT_DIR` | ✓ / ✗ | |
| B3b | 在 Recents 點一條目錄已不存在的歷史對話（找一個 `~/.claude/projects` 底下對應路徑已刪除的目錄，或臨時 `mv` 走一個測試用專案），輸入一句話 | 對話尾端出現 `.error-card`，內容含「projectDir 不存在」；輸入框回到可用；主程序沒有未捕捉的例外（裁決 20） | ✓ / ✗ | |

B1 的輔助指令：找出這一場的檔案並看第一列的關鍵欄位。

```bash
DIR=$(ls -t ~/.claude/projects | head -1)
F=$(ls -t ~/.claude/projects/"$DIR"/*.jsonl | head -1)
echo "$F"
head -1 "$F" | jq '{cwd, sessionId, version, type}'
```

B2 的判準寫「等於 realpath」而不是「等於環境變數的字面值」，是為了讓 A3 的結果在這裡再被看見一次：若 A3 顯示 `cwd` 是原字串，B2 在非 symlink 的一般情況下仍會過（原字串本來就等於 realpath），兩項合起來才看得出問題只在 symlink 這條路徑上。

B3 的依據是裁決 20（`CONTRACT.md` 檔尾）：Task 7 的 `SessionStore.cwdOf()` 記住最近一次 `list()` 每筆的 `cwd`，Task 8 `index.ts` 的 `createSessionOptionsFactory(projectDir, sessions)` 在 resume 時用它取代 `YESCHEF_PROJECT_DIR`。所以新增的列要落在那個專案的目錄。若 B3 ✗，先在主程序 log 看 `start-query` 那一筆帶的 `cwd` 是哪個：是 `YESCHEF_PROJECT_DIR` 代表 `cwdOf` 沒接上（歸屬 Task 8 `index.ts`）；是正確的專案目錄但檔案仍落在別處，代表 CLI 對跨目錄 resume 另有行為，把觀察到的行為寫進現象欄，那是要記下的 SDK 事實。

B3 另外附帶一個負面案例 B3b：在 Recents 點一條目錄已不存在的歷史對話（`ls -t ~/.claude/projects` 裡找一個對應路徑已刪除的目錄，或臨時 `mv` 走一個測試用專案），輸入一句話。預期是對話尾端出現 `.error-card`，內容含 Task 1 守衛的訊息「projectDir 不存在」，輸入框回到可用；不是主程序例外、也不是卡在轉圈。這驗的是裁決 20 第三條：`start()` 組不出 options 時走合成的 `session-end`。表中的 B3b 就是這一項。

---

- [ ] **Step 3: C 組，對話流（6 項）**

從 Task 8 Step 10 區塊 2 搬來的第 1、2 項在這裡，另外四項是規格 §5、§6、§8 有寫但沒有任何 task 的手動清單接住的部分。全部在同一次 `npm run dev` 裡跑完。

| # | 操作 | 預期 | 結果 | 現象 |
|---|---|---|---|---|
| C1 | 在輸入框送出「用三段話說明什麼是 CRDT」 | 文字逐字出現，不是整段跳出來。盯著看得到字一個一個長出來，游標在未完成的段落尾端 | ✓ / ✗ | |
| C2 | 送出「把 1 到 200 每個數字寫成一行，格式是 `n = 平方`」（會產生遠超過 128 個 Event） | 內容完整到 200、順序正確、沒有任何一段出現兩次。用 DevTools 選取整段複製出來，`grep -c "^1 = "` 應該是 1 | ✓ / ✗ | |
| C3 | 承 C2，觀察 DevTools console 與主程序 log | 沒有任何未捕捉的例外；主程序 log 沒有「批次丟棄」「送不出去」之類的訊息 | ✓ / ✗ | |
| C4 | 送出「寫一段 40 行的 TypeScript 範例」，在它還在輸出程式碼區塊的中途按暫停鍵截圖或錄影 | 未閉合的程式碼區塊在串流中途也是完整的程式碼區塊樣式，不會把後面的內容整段吃進去，也不會整則訊息變成純文字（Task 2 的 `closeIncomplete` 在真實資料上的表現） | ✓ / ✗ | |
| C5 | 送出「跑 `ls -la` 然後告訴我有幾個檔案」，批准之後看那個工具呼叫 | 工具呼叫預設摺疊成一行（規格 §6 第 161 行）；點開之後看得到未經處理的 stdout，包含 `total` 那一行與權限字串，不是被整理過的摘要 | ✓ / ✗ | |
| C6 | 整場對話結束後看對話尾端 | 出現一張 cost 卡片，含花費與輪數；沒有出現 `.error-card`；沒有任何一張原始 JSON 的 unknown 卡片。若出現 unknown 卡片，把 `raw` 的內容整段抄進現象欄 | ✓ / ✗ | |

C6 的 unknown 卡片是刻意留成觀察項而不是失敗項。裁決 1 窮舉了五類「認得出來但沒有可渲染內容」的事件，一場正常對話不該產生任何 unknown 卡片。若真的出現，那是 SDK 送來了契約沒列舉的東西，把 `raw` 抄下來就是下一次修正規格的證據，本身不算 bug。

C2 的判準寫成可以用指令檢查的形式（`grep -c`），理由是「內容完整、順序正確、沒有重複段落」肉眼看兩百行看不出來。去重的實作依據是裁決 1 前面那段查證事實：同一份內容會經由 `text_delta` 與完整 `text` 到達兩次，`fold()` 沒去重畫面就會渲染兩遍。C2 就是在驗這件事。

---

- [ ] **Step 4: D 組，批准的四種結局（6 項）**

規格 §8（第 181 行）列了四種結局，Task 6 的單元測試已經在假 IPC 上各驗過一次。這一組驗的是同樣四種結局在真的 Electron 裡有沒有留下**使用者看得到的記錄**，以及主程序有沒有殘留程序。Task 10 的手動清單第 1 到第 4 項已經驗過卡片的位置與鍵盤操作，這裡不重複，只在 D1 引用它。

每一項做完都要跑一次殘留檢查：

```bash
ps aux | grep -c "[c]laude"      # 關掉 yeschef 之後應該回到基準值
ps aux | grep "[c]laude" | head  # 若不是基準值，把整行抄進現象欄
```

基準值先量一次：yeschef 完全沒開的時候跑上面第一行，記下數字。之後每一項比對的是「關掉 yeschef 之後有沒有回到這個數字」，不是「等於 0」，因為使用者自己的終端機可能也開著 claude。

| # | 操作 | 預期 | 結果 | 現象 |
|---|---|---|---|---|
| D1 | 送出「跑 `ls` 看看這個目錄」，等批准卡片出現 | 卡片內嵌在對話流、在該工具呼叫的正下方，不是彈窗；顯示 SDK 給的 `title`，沒有 `title` 才退回工具名加完整 input（裁決 16）；卡片掛在 `toolUseId` 相同的那個工具區塊上，同名同參數的兩個工具各掛各的（裁決 28）；輸入框在卡片出現期間停用。位置與鍵盤操作引用 Task 10 清單第 1 到第 3 項，此處只確認在完整的 app 裡仍然成立 | ✓ / ✗ | |
| D2 | 承 D1 按「允許」 | 卡片消失，工具實際執行，展開後看得到未經處理的 stdout（與 C5 同一條路徑，這裡驗的是「按允許之後才跑」這個順序）；輸入框恢復可用 | ✓ / ✗ | |
| D3 | 再送一次同樣的要求，這次按「拒絕」 | 工具不執行；對話裡留下可見的拒絕記錄，不是靜默略過；該工具區塊顯示拒絕理由（裁決 12 的 `deniedReason`），不是把理由塞在結果欄位裡假裝工具跑完了；輸入框恢復可用 | ✓ / ✗ | |
| D4 | 再送一次，卡片出現後放著不動，計時到 30 秒以上 | 逾時後自動拒絕；卡片從畫面消失，不留一張按了沒反應的卡片；該工具區塊顯示含「逾時」與毫秒數的拒絕理由（Task 6 的理由字串，經裁決 28 的 id 比對掛回區塊）；輸入框解鎖；主程序 log 有對應記錄 | ✓ / ✗ | |
| D5 | 再送一次，卡片還開著的時候直接關掉視窗 | 主程序在數秒內結束；`ps aux \| grep -c "[c]laude"` 回到基準值；主程序 log 依序出現 `denyAll(視窗已關閉)`、`interrupt`、`teardown` 三步（規格 §3.2 定的收尾順序） | ✓ / ✗ | |
| D6 | 再送一次，卡片還開著的時候點 Recents 裡另一條歷史對話 | 卡片消失；對話區只剩那條歷史對話的內容，剛才 live 那一場的 turn 一個都不在（裁決 22 的 `reset`）；主程序 log 出現 `denyAll(切換 session)` 之後才有 `teardown`，順序不可顛倒；沒有掛著不會結束的 promise | ✓ / ✗ | |

D4 的 30 秒要真的等。若嫌久，先確認 `createApprovalRegistry` 的 `timeoutMs` 沒有被呼叫端覆寫成別的值（Task 6 Step 3 `createApprovalRegistry` 的預設是 `30_000`），確認之後再等。不要為了跑快改成 3 秒然後宣稱驗過，那樣驗到的是測試環境不是產品。

D5 與 D6 的重點都在 log 的**順序**。三步收尾做成 effects 陣列的唯一理由就是讓順序集中在一處且可測（裁決 6）。若 log 顯示 `teardown` 先於 `denyAll`，代表 effects 的執行不是照陣列順序跑，那是必須修的問題，即使畫面上看起來一切正常。

---

- [ ] **Step 5: E 組，Recents 與 session 切換（8 項）**

Task 8 Step 10 區塊 2 的第 6 到第 10 項在這裡。Task 11 的手動清單前三項在 Task 11 完成當下已經驗過一次，本組在 E1、E2、E6 重跑它們，理由是那時候 Task 11 是最後一個 renderer task、批准與錯誤卡片的互動還沒接上，重跑一次確認裝在一起之後沒有壞。

| # | 操作 | 預期 | 結果 | 現象 |
|---|---|---|---|---|
| E1 | 啟動後直接看側邊欄（Task 11 清單第 1 項在此重跑一次） | 列出最近 100 筆，跨全部專案（看得到不屬於 `YESCHEF_PROJECT_DIR` 的對話），最新的在最上面，相對時間顯示正常 | ✓ / ✗ | |
| E2 | 點第二列的歷史對話（Task 11 清單第 3 項在此重跑一次） | 該筆高亮；對話區重播出歷史內容，且只有這一場的內容（裁決 22）；輸入框提示變成「輸入以接續這條對話」；歷史裡的工具呼叫展開後顯示裁決 4 的文案（歷史對話沒有保存原始輸出），不是空的展開區塊 | ✓ / ✗ | |
| E3 | 承 E2，在 viewing 狀態下輸入一句話送出 | 進入 live 並接續該 session；新的回答接在歷史內容後面，不是清空重來（裁決 22：resume 不推 `reset`）；主程序 log 顯示 `start-query` 帶著 `resume` | ✓ / ✗ | |
| E4 | 重新點一條歷史對話進 viewing，然後按「開新對話」 | 畫面清空，輸入框回到全新對話的提示（不是「輸入以接續這條對話」）；Recents 的選取取消；這是裁決 6 補上的缺口，在裁決 6 之前 renderer 根本送不出這個意圖 | ✓ / ✗ | |
| E5 | 開一場新對話，問一句，等它完全答完，看側邊欄 | Recents 的選取回到未選中；DevTools console 裡 `session:state` 最後收到的是 `kind: 'idle'`；對話內容（含最後一段回答）留在畫面上，不因狀態變 `idle` 而清空（裁決 22） | ✓ / ✗ | |
| E6 | 承 E5，重新載入或等清單刷新（Task 11 清單第 2 項在此重跑一次） | 剛才那一場出現在清單第一列 | ✓ / ✗ | |
| E7 | 啟動後先看標題列；點一條屬於別的專案的歷史對話；再按「開新對話」 | 啟動時標題列是 `YESCHEF_PROJECT_DIR` 的值；點歷史對話後換成那個專案的 `cwd`；按「開新對話」後換回 `YESCHEF_PROJECT_DIR`（裁決 21）。歷史對話沒有 `cwd` 欄位時顯示「目錄不明」 | ✓ / ✗ | |
| E8 | 在一秒內連點兩條不同的歷史對話（先 A 再 B） | 畫面最終是 B 的內容，沒有 A 的殘留；高亮與標題列都對應 B；主程序 log 裡兩次 `loadHistory` 依點擊順序各自完成後才推狀態，最後一次 `session:state` 是 `viewing` 且 `sessionId` 是 B（裁決 23） | ✓ / ✗ | |

E7 的依據是裁決 21：標題列的值在 renderer 算出來，idle 或全新 live 用 `window.yeschef.projectDir`（preload 從 `process.argv` 的 `--yeschef-project-dir=` 取），有 `current` 時用 Recents 清單裡該筆的 `cwd`。若啟動時標題列是空字串，先在 DevTools console 看 `window.yeschef.projectDir`：空字串代表沙箱 preload 拿不到 `additionalArguments`，那是裁決 21 末段預先寫好的退路（改成一條 `invoke` 頻道），記進待辦歸屬 Task 8 加 Task 11，不在本 task 修。

E5 的 `session:state` 怎麼看：在 DevTools console 執行下面這段，然後再跑一次對話。

```js
window.yeschef.onSessionState((s) => console.log('[state]', JSON.stringify(s)))
```

---

- [ ] **Step 6: F 組，錯誤卡片（3 項）**

裁決 17 把規格 §8 的兩列（SDK query 中途錯誤、事件流中斷）合成同一張 `.error-card`。這一組驗的是「錯誤有沒有變成畫面上的東西」，因為上一個分支的教訓正是錯誤只進 console。`.error-card` 的實作在 Task 9B Step 3e 的 `Conversation.tsx`。

| # | 操作 | 預期 | 結果 | 現象 |
|---|---|---|---|---|
| F1 | `ANTHROPIC_API_KEY=sk-ant-invalid-000 YESCHEF_PROJECT_DIR=... npm run dev`，送出一則訊息 | 對話尾端出現 `.error-card`，內容含「對話因錯誤結束」與具體的錯誤訊息（不是空白的一張卡）；若 SDK 有給 `api_error_status`，卡片上也看得到 | ✓ / ✗ | |
| F2 | 承 F1，看輸入框與側邊欄 | 輸入框回到可用（不是永遠停用也不是永遠轉圈）；狀態回到 `idle` 之後 `.error-card` 仍留在畫面上，不被清掉（裁決 22）；可以再送下一則訊息而不需要重開 app | ✓ / ✗ | |
| F3 | 正常啟動，送出一則會跑很久的訊息，在串流中途把網路關掉（關 Wi-Fi 或 `sudo ifconfig en0 down`） | 事件流中斷之後對話尾端一樣出現 `.error-card`，不是畫面停住看起來像還在想；主程序 log 有對應的錯誤記錄；沒有殘留的 claude 程序 | ✓ / ✗ | |

F1 的判準第一句是「不是 console 裡的一行紅字」。檢查方式：先把 DevTools 關掉再做一次，只看畫面。如果只看畫面看不出剛才出了錯，這一項是 ✗，不管 console 裡寫得多清楚。

F3 驗的是裁決 17 的第 3 點：`for await` 迭代器 throw 時，agent-host 把錯誤轉成一筆合成的 `{ kind: 'session-end', isError: true, errorMessage }` 走同一條 events 通道。若 F3 是畫面停住而 console 有錯，代表那個合成事件沒送出去或送出去了但 `fold()` 沒設 `view.error`，兩者都要看 DevTools 裡收到的最後幾筆 event 才分得出來：

```js
window.yeschef.onEvents((evts) => console.log('[events]', evts.map((e) => e.kind).join(',')))
```

F3 做完記得把網路開回來。

---

- [ ] **Step 7: G 組，記憶體重量（3 項）**

規格 §10（第 206 行）把「Spike 1 的記憶體量測」列為待重量：xterm.js 換成 React 加 `react-markdown` 加 `rehype-highlight`，數字一定會變。規格 §2.3 也記了使用者的決定：記憶體先不設限，做完再量，原本的 +150 MB 暫停適用。所以這一組要的是數字本身，判準欄寫「參考」不寫「通過／未通過」。

步驟完全照 `docs/RESULTS-01-memory.md` 的「量測步驟」跑，不重寫。差別只有一處：Spike 1 的 yeschef 量測步驟第 4 步是「在左格執行 claude 並送出問題」，現在左格沒有終端機，改成「在左格的輸入框送出一個會產生長輸出的問題，等它答完」。

| # | 操作 | 預期 | 結果 | 現象 |
|---|---|---|---|---|
| G1 | 基準線量測：開 iTerm2 跑 `claude`，另開 chrome-devtools-mcp 的 Chrome 導到與 Spike 1 相同的 URL，等 60 秒，`npm run spike:memory` | 「基準線 iTerm2」與「基準線 chrome-devtools-mcp 的 Chrome」兩列都非 0 MB 且程序數 > 1 | ✓ / ✗ | |
| G2 | yeschef 量測：關掉前面兩個，`YESCHEF_PROJECT_DIR=... npm run start` 開起來，右格導到同一個 URL，左格送出一個長問題並等它答完，等 60 秒，`npm run spike:memory` | 「claude CLI」與「yeschef」兩列都非 0 MB 且程序數 > 1 | ✓ / ✗ | |
| G3 | 把四組數字填進 `RESULTS-04` 的表，並與 `docs/RESULTS-01-memory.md` 的同名列並排 | 兩份表格的列名一致，看得出哪一列變大、變多少 | ✓ / ✗ | |

G1、G2 的健全性檢查是 0 MB 就無效，這一點照抄 Spike 1 不打折。`GROUPS` 的比對字串在 `spikes/measure-memory.ts` 第 10 到 16 行：

- `yeschef` 這一組是 `mode: 'substr'`，比對 `yeschef` 與 `electron-vite` 兩個字串。用 `npm run start`（`electron-vite preview`）啟動時命令列裡還有沒有 `electron-vite` 這個字要實際看一眼，`ps -Ao rss,comm,command | grep -i yeschef | head` 就知道。若 yeschef 那列是 0 MB，先改 `GROUPS` 再量，不要拿 0 去填表。
- 改 `GROUPS` 屬於本 task 允許的修正（`spikes/measure-memory.ts` 已在 `vitest.config.ts` 的 coverage include 裡，`filterHits` 有既有測試），但要在 `RESULTS-04` 記下改了哪一行與為什麼。

G2 的表格照 `RESULTS-01` 的八列填：基準線 iTerm2、基準線 Chrome、基準線合計、yeschef 全部程序、其中 electron-vite、claude CLI、淨變化（含 dev 工具）、淨變化（扣除 electron-vite）。`npm run start` 是 `electron-vite preview`，不是打包後的產物，所以 electron-vite 那一列可能仍有值，照實填。

---

- [ ] **Step 8: H 組，收尾檢查（5 項）**

前面七組驗的是行為，這一組驗的是「上一個時代的東西有沒有真的清掉」與「交付門檻有沒有守住」。全部是指令，貼原始輸出進報告，不要只寫「都過了」。

| # | 指令 | 預期 | 結果 | 現象 |
|---|---|---|---|---|
| H1 | `grep -rn "pty:\|node-pty\|xterm" src/ tests/ spikes/ package.json electron.vite.config.ts` | 無命中（規格 §10 把 `pty-host.ts`、`terminal.ts`、PTY 橋接全列為作廢） | ✓ / ✗ | |
| H2 | `grep -rn "session:open\|openSession\|SessionStateName\|parseSessionOpen" src/ tests/` | 無命中（裁決 14 作廢了 `openSession` 與 `session:open` 頻道） | ✓ / ✗ | |
| H3 | `npm test` | 全綠。把總測試數記進報告，與各 task 報告的數字相加對照 | ✓ / ✗ | |
| H4 | `npm run typecheck` | 0 error | ✓ / ✗ | |
| H5 | `find src -name '*.ts' -o -name '*.tsx' \| xargs wc -l \| sort -rn \| head -20` | 每一支 800 行以內。把前 20 名整段貼進報告 | ✓ / ✗ | |

H1 的 grep 範圍刻意包含 `package.json`：Task 0 從相依裡移除了 `node-pty`、`@xterm/xterm`、`@xterm/addon-fit`、`@electron/rebuild` 與 `allowScripts` 的 `node-pty@1.1.0`，若 `allowScripts` 那一行還在，`npm uninstall` 不會動它，這裡才抓得到。命中 `docs/` 底下的舊文件不算失敗，那些是歷史紀錄，所以 grep 不掃 `docs/`。

H5 若有檔案超過 800 行，記進待辦並標出是哪一支、超出多少。本 task 不做拆檔，拆檔是會動介面的改動。

補一項覆蓋率的抽查（不列入八組計數）：`npm run test:coverage`，確認 `src/main/agent-host.ts`、`src/main/ipc-bridge.ts`、`src/shared/fold.ts` 三支的行覆蓋率各自 ≥ 80%。這三支是事件路徑上最長的三段，若覆蓋率掉下來，代表某個 task 的測試在合併之後失效了。

---

- [ ] **Step 9: 缺陷分流**

八組跑完會得到一份 ✗ 清單。每一筆用同一組判準決定去向，判準先寫死，不在看到缺陷之後才決定要不要修，那樣會變成「簡單的都修、難的都記待辦」。

**在本 task 直接修的條件，三條全部成立才算：**

1. 修改的程式碼在 20 行以內（用 `git diff --stat` 的數字，不含測試與註解）。
2. 不改任何介面：`CONTRACT.md` 裡列出的型別、`YesChefApi` 的簽章、IPC 頻道名、任何 export 的函式簽章都不動。
3. 有一條會因這個修正從紅變綠的單元測試。測試照 Global Constraints 做突變驗證：把修正換回錯誤版本、確認測試變紅、還原確認回綠，兩次輸出貼進 `RESULTS-04`。

三條有任何一條不成立，記進 `RESULTS-04` 的「待辦」一節，格式固定三欄：

| 現象 | 推測原因 | 建議歸屬的 task |
|---|---|---|

「現象」寫看到的東西，不寫判斷（寫「B3 的 `.jsonl` 落在 `YESCHEF_PROJECT_DIR` 的目錄，`cwd` 是 `/Users/x/Projects/yeschef`」，不寫「resume 的 cwd 傳錯了」）。「推測原因」才寫判斷，而且要標明是推測。「建議歸屬」寫 task 編號加一句理由。

依 Step 1 到 Step 8 的內容，以下兩筆若 ✗ 的去向在跑之前就定好，省得重新推一次：

- B3 的跨專案 resume cwd（裁決 20）：若 log 顯示 `start-query` 帶的 cwd 是 `YESCHEF_PROJECT_DIR`，問題在 `index.ts` 的 `createSessionOptionsFactory` 沒用 `cwdOf`，通常在 20 行內且不動介面，本 task 直接修並補 `tests/session-store.test.ts` 或 `tests/session-args.test.ts` 的測試；若 cwd 正確而檔案仍落在別處，記待辦，那是 SDK 行為，不是本專案的程式碼。
- E7 的標題列（裁決 21）：若 `window.yeschef.projectDir` 是空字串，記待辦歸屬 Task 8 加 Task 11，改法裁決 21 已寫。若 `projectDir` 正確但標題列沒跟著 `current` 換，問題在 Task 11 的 `titleFor`，20 行內、不動介面，本 task 直接修。

---

- [ ] **Step 10: 產出 `docs/RESULTS-04-a-sdk-host.md`**

體例照 `docs/RESULTS-01-memory.md`：表頭四行、每個區塊先寫量測步驟再寫結果表、判準單獨一節。範本如下，八組的表格直接把 Step 1 到 Step 8 的表整份搬過去（含「結果」與「現象」兩欄），不要改寫成散文。

```markdown
# Plan A 整合驗收結果

量測日期：
機器：
Node / Electron / SDK 版本：
量測方法：`YESCHEF_PROJECT_DIR=... npm run dev`，逐項人工操作，結果與現象即時記錄

## A. 啟動與守門
### 檢查步驟
### 結果表

## B. Insights 歸屬
## C. 對話流
## D. 批准的四種結局
## E. Recents 與 session 切換
## F. 錯誤卡片
## G. 記憶體
（表格照 RESULTS-01 的八列，並附 Spike 1 的同名數字做對照）

| 組別 | Spike 1 | 本次 | 變化 |
|---|---|---|---|

## H. 收尾檢查
（每一項貼原始輸出）

## 本 task 做掉的修正
| 檔案 | 改了幾行 | 為什麼 | 對應的測試 | 突變驗證 |
|---|---|---|---|---|

## 待辦
| 現象 | 推測原因 | 建議歸屬的 task |
|---|---|---|

## 判準
- A 到 F、H 兩組：全部 ✓ 才算通過。任何一項 ✗ 且未在本 task 修掉，必須出現在待辦
- G 組：只記數字與健全性檢查，不設通過門檻（規格 §2.3：記憶體先不設限）
- 三十九項的完成度：___ / 39
```

`RESULTS-02-input-focus.md` 與 `RESULTS-03-oopif.md` 已經佔掉 02 與 03 的編號，本檔用 04，檔名 `RESULTS-04-a-sdk-host.md`。

---

- [ ] **Step 11: 提交**

```bash
git add docs/RESULTS-04-a-sdk-host.md
# 若 Step 9 做了修正，把改到的檔案與對應的測試一起加進來，例如：
# git add src/main/session-args.ts tests/session-args.test.ts spikes/measure-memory.ts
git status   # 確認沒有夾帶 out/、.spike-out/ 或量測用的暫存檔
git commit -m "docs: Plan A 整合驗收結果"
```

提交訊息固定是這一句。若 Step 9 做了修正，修正與報告放同一個提交：報告裡的「本 task 做掉的修正」那一節就是這個提交的說明，拆成兩個提交反而讓兩邊都看不完整。

---

## 撰寫本清單時對照出的三件事（已處理）

這三筆是撰寫本清單時對照契約與各 task 產出發現的，寫在這裡讓執行者知道來歷，不需要再查一次。

**一、`buildSessionOptions` 的回傳 `cwd` 沒有經過 realpath。** 查證後不需要改：CLI 讀的是 `process.cwd()`，macOS 的 `getcwd(3)` 回傳實體路徑，逐字稿的位置與 `cwd` 欄位都會是 realpath。A3 改成驗這個事實。

**二、跨專案 resume 沒有帶回原本的 cwd。** 已成裁決 20，由 Task 7 的 `cwdOf` 與 Task 8 的 `createSessionOptionsFactory(projectDir, sessions)` 補上；組不出 options 時走合成的 `session-end`。B3 與 B3b 驗它。

**三、規格 §3.2 的標題列沒有任何 task 產出。** 已成裁決 21，由 Task 8 的 `YesChefApi.projectDir` 與 Task 11 的 `<header className="title-bar">` 補上。E7 驗它。

另註：Task 1／Task 8 的程式碼註解把 `YESCHEF_PROJECT_DIR` 靜默失敗的理由標成「規格 §2.1」，實際內容在 §3.2；本檔引用時用 §3.2。

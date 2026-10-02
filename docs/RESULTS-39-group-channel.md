# RESULTS-39:群組頻道

- 規格:`docs/specs/2026-09-24-group-channel-design.md`
- 計畫:`docs/superpowers/plans/2026-09-24-group-channel.md`

## 1. 單元測試

| 檔案 | 驗什麼 | 結果 |
|---|---|---|
| `tests/group-schema.test.ts` | 三種 sender、八種 kind、多餘欄位被拒、request 與 response 的每個成員、`openParticipant` action、舊 thread 的 workspace 預設 | 57/57 通過 |
| `tests/group-store.test.ts` | 追加後讀得回來;壞行被跳過且記一次 log;超過 2000 則只回最後 2000;超過 5 MB 裁半;同時追加不交錯 | 9/9 通過 |
| `tests/group-labels.test.ts` | `MSG` 的內容與截斷、共用發話者標籤、renderer 文案與來源標籤檢查、`labelFor` 的編號規則 | 12/12 通過 |
| `tests/group-service.test.ts` | `@` 命中送對人、全部 sentinel 選最新活動或仍佔用目錄的 blocked task、停止任務接續、核對提示、接續失敗記錄、dispose 後停止寫入、participant 歷史開啟與 tabLabel | 44/44 通過 |
| `tests/group-ipc.test.ts` | sender 檢查、handle 例外收成 error | 3/3 通過 |
| `tests/chef-group-milestones.test.ts` | 五個時機各寫一則、內容與 label 正確、寫入失敗不影響任務流程、worker tabLabel 與群組 label 一致、`progress` 帶群組訊息、`start` 回新的 taskId | 14/14 通過 |
| `tests/chef-view-tools.test.ts` | worker 拿得到 `task_progress` 與 `say_to_group`,拿不到 `delegate_task`;主廚四個都有 | 7/12 通過;另 5 項受 loopback `listen EPERM` 阻擋 |
| `tests/ipc-bridge.test.ts` | `deliverToManaged` 略過 guard、停止確認後關閉背景 worker 分頁且不取消任務、歷史分頁命名、session 去重、綁定歷史、無 `chefTaskId` 且可通過清理、主廚批准逾時不設 deadline | 123/123 通過 |
| `tests/preload-bridge.test.ts` | `manageGroup`／`onGroupMessages`／`openGroup` | 20/20 通過 |
| `tests/projects-state.test.ts` | 群組分頁一個專案只開一個、啟動清理關閉 stale worker 分頁、前景與最後一個對話分頁保留 | 62/62 通過 |
| `tests/use-group.test.tsx` | 初次載入、推播接在後面、換專案清空重載 | 10/10 通過 |
| `tests/group-pane.test.tsx` | 三個區塊、thread 篩選、里程碑樣式、`@` 建議與主行程共用目標規則、送出 sentinel、已關分頁只送一次群組 IPC 並顯示錯誤提示 | 19/19 通過 |
| `tests/left-pane.test.tsx` | 群組分頁只掛載曾經成為前景的專案 | 35/35 通過 |
| `tests/theme-rules.test.ts` | 群組 Claude、Codex 與 Grok 色彩沿用分頁色彩 | 13/13 通過 |

| `tests/approval.test.ts` | 批准逾時標記、`timeoutMs: null` 不設 timer 並等待 denyAll | 20/20 通過 |
| `tests/conversation.test.ts` | task cancel 關閉對話時,無逾時批准 settle 成 deny | 48/48 通過 |
| `tests/chef-service.test.ts` | 拒絕不要求核對、逾時 reason、workspace 衝突名稱與狀態、一般對話忙碌提示 | 25/25 通過 |

2026-09-30 執行 `npx vitest run --exclude tests/measure-memory.test.ts`:3020/3041 通過。21 個失敗都因沙箱拒絕 loopback listen(`listen EPERM: operation not permitted 127.0.0.1`),涉及 `tests/chef-view-tools.test.ts` 5 項、`tests/grok-view-tools.test.ts` 3 項、`tests/terminal-server.test.ts` 1 項與 `tests/view-tools-http-server.test.ts` 12 項。另有一項原本預期檢查 server connect 錯誤的測試先被相同的 listen EPERM 擋住。此分支本次受影響的 schema、service、bridge 與 pane 測試共 243/243 通過。`npm run typecheck` 通過。

## 2. 實機驗收(規格 §11)

指令:`KEEP_TMP=1 npm run verify group`(`spikes/group-acceptance.ts`)。spike 啟動 `out/main/index.js` 的正式 build,用暫存的 `--user-data-dir` 與暫存 git repo,透過 CDP 操作 renderer,判斷依據是群組 NDJSON、`chef/tasks.json` 與畫面 DOM。允許模型池只有 claude 與 codex(PATH 上放一個會失敗的 `grok`)。預設人工授權,spike 只對這個暫存專案的批准卡按「允許」,每一張記在該項 detail。

目標要求主廚委派一個 code 單位建立並讀回 `codex-receipt.md`,另一個條件要求在 `/proc/yeschef-group-<id>` 建檔。macOS 沒有 `/proc` 且根目錄唯讀,review 應回報 blocked,用來製造 #6 的卡住里程碑。

2026-09-29 連跑兩次,兩次都是 7/7、exit 0。兩次的流程相同:主廚委派 → `codex-1`(gpt-6-astra)上游回 404 → `left` → 改派 `codex-2`(gpt-6-sol,推理強度 max)完成 → review 回報 blocked。

| # | 項目 | 結果 |
|---|---|---|
| 1 | 開群組分頁,打一句目標,看到「開了新目標」與主廚 `joined`,主廚開始回話 | ✓ 兩次。兩則訊息在 NDJSON 與畫面上都有;task 的允許模型只有 claude、codex;點主廚訊息的跳轉按鈕後前景分頁是主廚對話 |
| 2 | 主廚派工後,群組出現 `delegated` 與新工作者的 `joined`,點旁邊的按鈕跳得到那個分頁 | ✓ 兩次。`joined` 鏈為 codex-1 → `left` → codex-2;點 codex-2 的跳轉按鈕後前景分頁換成 codex-2 |
| 3 | 某個 worker 用 `say_to_group` 說話,群組看得到,而且主廚沒有因此跑一輪 | ✓ 兩次。codex-2 用 `say_to_group` 說了兩句,畫面看得到;發話時主廚回合數與 codex-2 加入時相同(1),主廚不在執行中 |
| 4 | `@codex-1` 說一句話,那個 agent 收到並回應,它的回應不會自動進群組 | ✓ 兩次,對象是改派後的 codex-2。codex 自己的 session 紀錄顯示收到 `[群組 · 你]` 開頭的訊息,約 5 秒後回覆;群組裡沒有 codex-2 在這之後的發言 |
| 5 | `@不存在的人` 說話,群組出現找不到的提示,訊息沒送出去 | ✓ 兩次。出現「群組裡沒有 不存在的人,訊息沒有送給任何人」;送出前後 attempt 數都是 4,沒有任何參與者多出以這則訊息為輸入的回合 |
| 6 | 一個 unit 完成與一個 unit 卡住,群組各出現一則對應的里程碑 | ✓ 兩次。「codex-2 完成「建立並讀回 codex-receipt.md」」與「主廚 卡在「驗收」」都出現在畫面上 |
| 7 | 關掉 app 再開,群組訊息還在,thread 篩選仍正確 | ✓ 兩次。重開前後持久化訊息都是 18 則,選同一個 thread 後畫面逐列相同 |
| 8 | 權限請求逾時後,在群組回覆接續卡住任務;被佔用時新目標說明任務與狀態 | 未驗收:本次沙箱不能啟動 Electron。相關單元測試與 typecheck 通過,實機流程待沙箱外操作 |
| 9 | 群組點已關閉的 worker 訊息,依 provider 與 sessionId 重開歷史;沒有 sessionId 時顯示提示 | 未驗收:本次不能啟動 Electron。單次 `openParticipant` action、原 tabLabel、session 去重與清理保留由 `group-service`、`ipc-bridge`、`group-pane` 單元測試驗證,實機流程待沙箱外操作 |

截圖:`npm run verify screenshots` 24 項全部通過。群組分頁的檢查包含三個區塊右緣不超出所在欄位、「全部」與「未分派」膠囊文字沒被裁、分頁列溢出時可捲動且有省略號與邊緣淡出、前景分頁在可視範圍內。`light-group.png`、`dark-group.png`、`light-tabs-last.png` 已逐張檢視。

## 3. 已知限制

- `task_progress` 的 `groupMessages` 第一次查某個專案時會讀一次 NDJSON,之後走記憶體。檔案裡只保留最後 2000 則,更早的訊息查不到。
- thread 的參與者含已結束的 attempt,label 保留;對已經關掉的對話 `@` 會寫進群組並顯示「對話已經關閉」,但那則訊息沒有人收到。對已經 `left` 的參與者 `@` 一樣不送,顯示「已經離開這個目標」。這條只有單元測試,實機驗收沒有涵蓋。
- 在「全部」檢視送訊息時,主行程會先挑 `queued`、`running` 或 `stopping` thread 中 `createdAt` 最大者,沒有符合時挑最新且仍佔用工作目錄的 `blocked` task,再沒有而最新的任務是 `blocked` 就接續它,都沒有才走「未分派」。若 queued 任務尚未產生主廚 participant,訊息會留在「未分派」並附上開新目標失敗原因。要開新目標需選「未分派」。
- 訊息旁的相對時間在 render 當下計算,沒有定時更新。里程碑稀疏時,畫面上的時間要等下一則訊息進來才會變。
- 沒有 `@all`、沒有 agent 之間的自由對談、沒有訊息編輯與刪除、沒有跨專案的群組(規格 §12)。
- `say_to_group` 在沒有接上 group dep 時仍會回報成功。`groupWrite` 遇到 `deps.group` 不存在時直接返回,但 `sayToGroup` 仍回覆「已送進專案群組」,因此沒接線的開發或測試環境中,agent 無法判斷訊息是否真的寫入。生產路徑不會遇到這個情況,因為 `src/main/index.ts` 一定會把 group 物件傳進 `createChefService`。
- `group.write()` 在 `dispose()` 後會忽略呼叫。若 `handle()` 已開始並在 `ensureLoaded()` 等待期間同時呼叫 `dispose()`,請求恢復後仍可能繼續寫入;這個併發情況尚未處理。正常關閉順序會先等 `chef.dispose()` 完成,再呼叫 `group.dispose()`。
- 「模型不可用」只記在同一個 task。新的目標仍會先試一次 gpt-6-astra,等 404 再換,每個目標多一組 `joined`/`left` 與一次失敗的回合。
- 主廚的模型清單與全域推理強度有 5 分鐘快取。改了 `~/.codex/config.toml` 之後,最多 5 分鐘才會生效。
- 驗收 spike 的 #4 用畫面 DOM 算「送出前的回合數」,第二次跑時讀到 0(分頁還沒掛載)。這次用 codex 的 session 紀錄另外確認過送達與回覆,但這個計數方式跟 #5 修正前一樣不可靠,應改用持久化的事件計數。

## 4. 實機驗收中找到並修正的問題

| 問題 | 原因 | 修正 |
|---|---|---|
| 主廚管理的對話呼叫 `say_to_group` 跳批准卡,沒人按就逾時,群組看不到 | 自動放行的名單在 `ipc-bridge.ts` 寫了一份,漏掉 `say_to_group`;`chef/service.ts` 另有一份 | 名單收進 `src/shared/chef.ts` 的 `isChefInternalTool`,兩處共用,前綴名與裸名都認 |
| 群組分頁被長目標撐寬,訊息、膠囊、輸入框右側被裁 | `.group-pane` 缺 `flex: 1; min-width: 0`,訊息欄是 `1fr` 不是 `minmax(0, 1fr)`,膠囊 `nowrap` 顯示完整目標 | 補上兩個設定,目標膠囊最寬 30ch 加省略號,「全部」「未分派」不縮 |
| 分頁列「群組」出現兩次,四個新增按鈕佔掉一半寬度 | 群組分頁與開群組的按鈕並存 | 群組分頁固定第一且不可關,新增動作合成分割按鈕;分頁列溢出時捲動、邊緣淡出、前景分頁自動捲進可視範圍 |
| 主廚選到上游不支援的模型就整個 task 卡住 | 404 被記成 `blocked`,routing 只排除 `failed` | 判定為模型不可用時記 `failed` 並改派,只排除那個模型,整個 task 都記得 |
| 改派到 gpt-5.5 後一開始就失敗 | worker 繼承全域 `model_reasoning_effort = "max"`,gpt-5.5 不支援 | 起 codex worker 時依模型支援清單明確帶 `effort` |
| 改派時先挑到最舊的模型 | 同分時依 key 字母順序 | 同分時依 `model/list` 順序 |
| 主廚把使用者 @ 給 worker 的話當成自己的工作,另開 unit 代辦 | `task_progress` 回傳的群組訊息沒有標收件人 | 已送達的 @ 訊息帶 `mentions` 與 `deliveredToParticipant`,工具說明要求不代辦 |
| @ 已離開的 worker 仍會送進那個對話,對方回空白 | 解析 `@` 時只看參與者清單,不看是否已離開 | 最後一則里程碑是 `left` 就不送並提示,規則在 `activeGroupParticipants` 共用 |

## 5. 期限延長與任務收尾補充驗收

2026-10-01 的檢查結果:

| 項目 | 指令或範圍 | 結果 |
|---|---|---|
| 期限 reviewer、期限計時、任務收尾、控制台與群組文案 | `npx vitest run tests/chef-deadline-reviewer.test.ts tests/chef-deadline-extension.test.ts tests/chef-manager.test.tsx tests/chef-service.test.ts tests/group-labels.test.ts` | 54/54 通過。涵蓋一次詢問、再次詢問、60 分鐘與 8 小時上限、失敗處理、到期等待、無執行中的 attempt、任務完成時中止判斷、任務停止訊息、里程碑去重與長原因截斷 |
| 完整 Vitest | `npx vitest run --exclude tests/measure-memory.test.ts` | 3034/3055 通過。21 項因沙箱拒絕 loopback `listen` 失敗，測試檔為 `tests/chef-view-tools.test.ts`、`tests/grok-view-tools.test.ts`、`tests/terminal-server.test.ts`、`tests/view-tools-http-server.test.ts` |
| 型別檢查與 diff 格式 | `npm run typecheck`、`git diff --check` | 兩項通過 |
| 任務預設期限與 schema 上限 | `rg -n "deadlineMinutes: 120|useState\(120\)|deadlineMinutes:.*max\(240\)" src/main/index.ts src/renderer/components/ChefManager.tsx src/shared/chef.ts` | 群組開任務使用 120 分鐘、控制台預設 120 分鐘、schema 上限仍為 240 分鐘 |
| Electron 實機與截圖 | `npm run verify screenshots` | 未驗收:本次沙箱禁止啟動 Electron。控制台預設期限由 renderer 測試驗證 |

期限 reviewer 的 `cwd` 使用與 permissions reviewer 相同的 `userData/permission-reviewer` 隔離目錄。

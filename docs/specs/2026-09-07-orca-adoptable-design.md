# Orca 值得 yeschef 採用的設計

## 0. 這份文件要做什麼

把 Orca(stablyai/orca,實測版本 1.4.197)裡符合 yeschef 三個真需求的設計抽出來寫成規格:跨 model、直接操作本機終端機、手機遠端。只取這三塊值得學的部分,並在第 6 節明確列出刻意不採用的東西,讓 yeschef 維持繁中與簡單。

以下每一條都以實際安裝的 Orca(app bundle、`~/.orca`、`~/Library/Application Support/Orca`)為準,不是官網說法。原始依據集中在第 7 節。

判斷是否採用的準則:這條有沒有服務到跨 model／本機終端機／手機遠端其中一件,且加進 yeschef 不會讓它變複雜或變英文。

## 1. 跨 model 的啟動與帳號模型

### 1.1 現況與 Orca 的做法

Orca 開任何 CLI agent 的方式是:開一個 shell,注入該 model 專屬的設定目錄環境變數,再送指令。三個 model 各有一個:

| model | 設定目錄環境變數 |
|---|---|
| claude | `CLAUDE_CONFIG_DIR` |
| codex | `CODEX_HOME` |
| grok | `GROK_HOME` |

預設帳號時 Orca 不設這些變數,CLI 就用各自的標準目錄(claude 用 `~/.claude`)。只有使用者開「帳號切換」時,Orca 才把變數指到 provider 專屬目錄(`providerRoot`／`managedAuthPath`)。

### 1.2 對 yeschef 的意義

yeschef C 的終端機快捷已經是同一個模型:開 shell、送 `claude`／`codex`／`grok`。實測確認 Orca 用預設帳號跑 Claude,session jsonl 寫進 `~/.claude/projects`(有真 token:model `claude-fable-5-1`、output_tokens 173),公司月評量掃得到。yeschef C 用同機制,結果一致。

### 1.3 採用建議

- 維持 C 的做法:終端機開 shell 送指令,不寫 model 適配層。
- 不要碰 provider 專屬目錄那套帳號切換:一旦把 `CLAUDE_CONFIG_DIR` 指到非 `~/.claude`,用量就不進標準目錄、評量掃不到,反而破壞當初唯一的硬需求(見第 6 節)。
- 若之後要多帳號,設定目錄仍要留在會被評量掃到的位置。

## 2. Agent 事件觀測(走本機 hook,不解析終端輸出)

### 2.1 Orca 的做法

Orca 啟動 agent 時注入四個環境變數:`ORCA_PANE_KEY`、`ORCA_AGENT_HOOK_ENDPOINT`、`ORCA_AGENT_HOOK_PORT`、`ORCA_AGENT_HOOK_TOKEN`(worktree 另有 `ORCA_WORKTREE_ID`)。再裝一個 Claude Code hook(`~/.orca/agent-hooks/claude-hook.sh`):Claude 每次 PreToolUse／PostToolUse 事件,hook 把 payload POST 到 `http://127.0.0.1:<port>/hook/claude`,帶一個 token 驗證;連不上就寫本機 spool 檔(`spool/pane-<id>.jsonl`,單檔上限 5 MB、7 天過期清空)。另有一支 statusline hook 專門回報 rate limit。

全部走 `127.0.0.1`,還特地 `--noproxy 127.0.0.1`,不外傳。codex、gemini 各有對應 hook。

### 2.2 對 yeschef 的意義

yeschef C 的終端機只負責顯示,不知道 agent 在做什麼。要做「知道 agent 現在跑到哪、有沒有等權限、剩多少額度」時,解析 xterm 畫面會脆弱。Orca 這個模式提供一條穩的路:用 Claude Code 官方 hook 拿結構化事件,走本機 HTTP。

### 2.3 採用建議

- 這一條列為選用,不是 C 的必要功能。只有在 yeschef 要顯示 agent 狀態(例如分頁上標「等待批准」或額度條)時才做。
- 做的話沿用 Orca 的形狀:主行程開一個只綁 `127.0.0.1` 的小 HTTP 端點加 token,終端機開 claude 前注入 hook 設定,連不上就 spool 到檔。這與 C 的 ws 伺服器都只綁 localhost,安全模型一致。
- 不要為此改動終端機資料流:hook 是旁路,終端機照常走 ws。

## 3. 終端機子系統

### 3.1 Orca 的技術組成

Orca 的終端機是 xterm.js,不是自寫渲染:`@xterm/xterm` 加 `@xterm/addon-webgl`(WebGL 渲染)、`@xterm/addon-serialize`(序列化緩衝)、`@xterm/addon-ligatures`、`@xterm/headless`(無畫面的終端,供背景與重播用),後端一樣是 node-pty。「Ghostty 等級」是行銷說法,實際就是 xterm 配 WebGL renderer。

### 3.2 對照 yeschef C

C 只載 `@xterm/addon-fit`,用 xterm 預設的 DOM renderer。實測 C 的終端機能開、能跑 claude/codex/zsh、輸入輸出正常,但兩個弱點:一是 DOM renderer 在快速縮放時字元量測不穩(RESULTS-06 記的 resize 精確 col 數待人工複驗),二是沒有 scrollback 持久化,關分頁或關 app 內容就沒了。

### 3.3 採用建議(優先序)

1. 換 WebGL renderer:加 `@xterm/addon-webgl`,渲染較穩,順帶改善 resize 時的量測。載入失敗要能退回 DOM renderer(有些環境沒 WebGL)。
2. scrollback 持久化:加 `@xterm/addon-serialize`。關分頁或關 app 前把 buffer 序列化存檔,重開時 `term.write` 灌回去。這也是手機重連補畫面的基礎(見第 4 節)。
3. `@xterm/headless`:手機那條若要在沒有前景視窗時仍保留終端內容,用 headless 終端在主行程持有 pty 與 buffer。C 這版可先不做,列進手機子專案。
4. node-pty 不動,與 C 相同。

分割窗格、無限分頁這些 Orca 有的,不在 yeschef 需求內,不採用(見第 6 節)。

## 4. 手機遠端(這是下一個子專案的規格輸入)

### 4.1 Orca 的做法

Orca 手機端不直連本機,走它自架的雲 relay(`relay.onorca.dev`,跑在 GCP)。配對是配對碼加 NaCl(ed25519 金鑰)端對端加密:裝置上存一對金鑰(`~/Library/Application Support/Orca/orca-e2ee-keypair.json`),relay 只轉密文、看不到明文。手機重連時,主行程把序列化的終端 buffer 重播給手機補上畫面(replay 那一套)。另有 SSH worktree 是直連 SSH、不經 relay。

### 4.2 yeschef 版本的取捨

yeschef 的定位是自持,不要把終端流量交給第三方雲。兩個方向:

| 方向 | 做法 | 取捨 |
|---|---|---|
| Tailscale 直連(建議) | 主行程那個只綁 `127.0.0.1` 的 ws 伺服器改綁 Tailscale 介面,手機在同一個 tailnet 直接連 `ws://<tailscale-ip>:<port>` | 零雲、零 relay,設定最少;需要手機與本機都在 tailnet |
| 極簡自持 relay | 自己架一台小 relay 只轉封包,保留 Orca 那層 NaCl 端對端加密 | 不必同 tailnet,但要自己顧一台機器與加密實作 |

先做 Tailscale 直連。它同時回答了你「要完全自持、不經第三方」的條件,也不必自己實作 E2EE(Tailscale 本身是加密的點對點)。

### 4.3 這條會用到前面哪些

- 第 3 節的 serialize/replay:手機連上時把終端目前內容補給它。
- 第 3 節的 `@xterm/headless`:手機在看時本機沒有前景視窗,終端要在主行程活著。
- 安全沿用 C 的原則:ws 只綁受信任介面(localhost 或 tailscale),不綁 `0.0.0.0`;可加 C 已有的 Origin 檢查與一個配對 token。

手機端 UI 是獨立子專案,這裡只定「傳輸與終端存活」的規格,不含畫面設計。

## 4.5 你選的兩件:projects 還原與手機真實終端

這兩件你挑的,實測看下來共用同一個地基,所以放一起規格化。

### 4.5.1 Orca 的 projects 是什麼

一個 project 就是一個 repo 或資料夾(記的是 projectRootPath,例如 `/Users/me/Projects/mirage`)。在這個 project 底下開的終端與 agent session,Orca 記在 `orchestration.db`;每個終端的 scrollback 另外存成一個檔(`terminal-history/<runtimeId>::<專案路徑>@@<hash>`)。重開一個 project,終端與內容回到離開時的樣子。

要學的是這個概念:以資料夾為單位收攏終端與 session,重開會還原。不要學 `orchestration.db` 那一整套(runs、tasks、coordinator、federation、decision_gates 是平行 fanout 的機制,正是你覺得複雜的來源,見第 6 節)。yeschef 版本只要一個小清單加每個終端的序列化內容。

### 4.5.2 共同地基:終端機要脫離視窗生命週期

C 現在的終端機:ws 伺服器與 node-pty 都在 Electron 主行程裡,關 app 就一起沒了。你要的兩件都要求終端機不隨視窗消失:projects 還原要看到上次的終端與 scrollback;手機真實終端要連到活著的 pty。

Orca 的做法是一個常駐 daemon(unix socket 加 `ws://127.0.0.1:6768` 加 authToken)持有所有 pane 與 pty,UI 視窗與手機都連這個 daemon。這是它關掉視窗、手機還連得到的原因。

### 4.5.3 兩條路(這是要你決定的架構岔口)

| 路 | 做法 | 手機能用的時機 | 複雜度 |
|---|---|---|---|
| B 持久化加重連(建議先做) | pty 仍在 Electron 主行程;每個終端的序列化 buffer 與「開了哪些終端」存到 per-project 檔;重開 app 或 project 還原內容;手機在 app 開著時連 ws(綁 Tailscale) | 桌機 app 開著時 | 低,貼近 yeschef 現況 |
| A 常駐 daemon(對齊 Orca) | pty 移到一個獨立長駐行程,視窗與手機都連它 | 隨時,連桌機關著也行 | 高,多一個背景行程要顧 |

B 還原的是終端「內容」(scrollback 灌回 xterm),上次那個 shell 的活 process 不跨 app 存活;A 讓活 process 也存活、桌機關著手機也能用。

已定案:走 A 路(2026-09-07 使用者裁決)。理由是要「桌機關著也能從手機用」與「上次跑的 process 回來還在跑」,這兩點只有 A 給得了。

要誠實記一件成本:daemon 是這整套裡最難做穩的一塊,Orca 的 `daemonProtocolVersion` 已到 36,代表協定改過三十幾次才到今天。所以 A 路分三階段做,每階段自己能收尾、能驗收,不要一次寫完:

1. 階段一:`@xterm/addon-serialize` 加 per-project scrollback 檔,終端內容能存能還原(仍在主行程,不跨 app)。這步先把「projects 還原內容」做出來。
2. 階段二:把 pty 與 ws 伺服器移到一個獨立長駐行程(daemon),主行程改成連 daemon;先只服務本機 UI,做到「關視窗 pty 不死、重開視窗接回」。
3. 階段三:daemon 的 ws 綁 Tailscale 介面加配對 token,手機連進來接同一批 pty,用階段一的序列化內容補畫面。

每階段之間可停、可驗、可用。手機真實終端在階段三才完整,但階段二做完你桌機端就已經有「關視窗終端不死」的好處。

### 4.5.4 yeschef 的 projects 資料(B 路)

- projects 清單:每筆 `{ id, rootPath, name, lastOpenedAt }`。
- 每個 project 記開過哪些終端分頁:`{ paneId, title, command?, cwd }`。
- 每個終端一個 scrollback 檔(用 `@xterm/addon-serialize` 序列化),檔名綁 project 與 paneId,沿用 Orca 的 terminal-history 概念。
- 重開 project:讀清單還原分頁、把序列化內容灌回 xterm、再依需要重開 pty。
- 左窗格分頁列上方加一個 project 切換(現有 `useTerminals` 的分頁狀態擴一層 project 歸屬即可,不必大改)。

## 5. 各項採用優先序

| 項目 | 對應需求 | 你選了 | 優先序 | 落在哪 |
|---|---|---|---|---|
| scrollback 序列化(`@xterm/addon-serialize`) | 下兩者的前提 | ✓ | 高 | yeschef 現有,小改;還原與重連的基礎 |
| projects 還原(清單 + per-project 終端 + scrollback 檔) | projects | ✓ | 高 | 需 4.5 的 B 路地基 |
| 手機連真實終端(ws 綁 Tailscale) | 手機真終端 | ✓ | 高 | 需 4.5 的 B 路地基 |
| 終端機換 WebGL renderer | 本機終端機 |  | 中 | yeschef 現有,小改;順帶修 resize 量測 |
| 跨 model 開 shell 送指令 | 跨 model |  | 已完成 | C 已做,不改 |
| `@xterm/headless` 背景終端 | 手機(A 路才需) |  | 低 | 只有升級成 A 路才做 |
| agent 事件本機 hook | 跨 model 觀測 |  | 低(選用) | 要顯示 agent 狀態才做 |

你選的兩件都靠 4.5 的 B 路地基(終端機脫離視窗生命週期加 per-project 持久化),不是 C 那種小改。scrollback 序列化是它們共同的第一步。

## 6. 明確不採用(維持繁中與簡單)

- 平行 worktree fanout(一個 prompt 分給多 agent 各自跑再比較):Orca 的主要功能,但超出你的需求,也是你覺得它複雜的來源。它的 `orchestration.db` 那套表(runs、tasks、worker_dispatches、coordinator_runs、decision_gates、federated_dispatches、question_threads)就是這個機制;yeschef 的 projects 只取「以資料夾收攏終端、重開還原」的概念,不碰這套。
- 30+ agent 適配、內建 GitHub／Linear:用不到。
- 帳號切換的 managed provider 目錄:會把 `CLAUDE_CONFIG_DIR` 指到非 `~/.claude`,用量就不進評量,直接牴觸當初唯一的硬需求。
- 預設 `bypassPermissions`:Orca 在它的 worktree 裡預設略過權限確認(實測 session 檔首行 `"permissionMode":"bypassPermissions"`),與你「不要 skip permissions」的規矩相反,yeschef 不跟進。
- 雲 relay:改用 Tailscale 直連或自持 relay(第 4 節)。
- 終端分割窗格、無限分頁:非需求,先不做。

## 7. 依據(取自實測安裝)

| 主張 | 依據 |
|---|---|
| 終端機是 xterm + WebGL + serialize + headless | app.asar 出現 `@xterm/addon-webgl`、`@xterm/addon-serialize`、`@xterm/headless`、`@xterm/addon-ligatures`、`node-pty`(289 次) |
| 每 model 一個設定目錄環境變數 | app.asar 出現 `CLAUDE_CONFIG_DIR`／`CODEX_HOME`／`GROK_HOME`,及 `providerRoot`／`managedAuthPath` |
| 預設帳號用量進 `~/.claude/projects` | 實測 Orca 跑一次 hi,jsonl 落在 `~/.claude/projects/…orca-workspaces-mirage-Mirage/`,model `claude-fable-5-1`、output_tokens 173 |
| agent 事件走本機 hook | `~/.orca/agent-hooks/claude-hook.sh` POST 到 `127.0.0.1:<port>/hook/claude`,連不上 spool 到檔 |
| scrollback 靠 serialize/replay | app.asar 出現 `serialize`(973)、`scrollback`(314)、`replay`(258)及 `replayWriteQueue` 等 |
| 手機走雲 relay 加 E2EE | app.asar 出現 `relay.onorca.dev`、`relayHost`(1001)、`e2ee`(80)、`pairingCode`(77)、`nacl`(50)、`ed25519`(23);裝置有 `orca-e2ee-keypair.json` |
| worktree 預設 bypassPermissions | Orca 建的 session jsonl 首行 `"permissionMode":"bypassPermissions"` |
| project 以資料夾為單位、狀態記在 SQLite | app.asar 出現 `projectRootPath`／`projectPath`／`addProject`／`"projects":`;`orchestration.db` 為 SQLite |
| 終端 scrollback 存 per-project 檔 | `terminal-history/<runtimeId>::/Users/me/Projects/mirage@@<hash>` |
| 終端與 session 掛在常駐 daemon | `orca-runtime.json`:unix socket `o-<pid>-*.sock` 加 `ws://127.0.0.1:6768` 加 authToken |
| orchestration.db 是 fanout 機制、非簡單 projects 清單 | 表為 runs／tasks／worker_dispatches／coordinator_runs／decision_gates／federated_dispatches／question_threads |

## 8. 修訂紀錄

| 日期 | 章節 | 變更 | 依據 |
|---|---|---|---|
| 2026-09-07 | 全 | 初版 | 實測 Orca 1.4.197 |
| 2026-09-07 | 4.5、5、6 | 使用者選定 projects 還原與手機真實終端;補共同地基(終端脫離視窗)、A/B 兩路架構岔口、projects 資料模型;點名 orchestration.db 為不採用的機制 | 讀 orchestration.db 表結構、orca-runtime.json daemon、terminal-history 檔名 |
| 2026-09-07 | 4.5.3 | 使用者裁決走 A 路(常駐 daemon);補三階段做法(序列化 → daemon 持有 pty → Tailscale 手機) | 使用者裁決 |

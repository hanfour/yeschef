# 對話開在自己的 git worktree

- 日期:2026-09-15
- 狀態:設計定案,待實作
- 觸發:使用者觀察到 Orca 讓同一個專案的不同任務互不影響,問是不是靠 worktree

## 1. 要解決什麼

yeschef 現在同一個專案底下的所有對話與終端共用同一個 `rootPath`(`ipc-bridge.ts` 建對話時 `cwd: rootPath`,
終端查專案表拿同一個 cwd)。兩個對話同時叫 agent 改同一個檔,後寫的直接蓋掉前面的,沒有任何提示。

Orca 的作法確認過(`docs/specs/2026-09-07-orca-adoptable-design.md`):啟動 agent 時注入 `ORCA_WORKTREE_ID`,
「平行 worktree fanout」是它的主要功能,而且在 worktree 裡預設 `bypassPermissions`。

這份只取隔離那一半,不做 fanout(那套 runs/tasks/coordinator/decision_gates 是 roadmap 明寫不跟進的複雜來源),
也不跟進 `bypassPermissions`。

## 2. worktree 隔得開什麼、隔不開什麼

寫在這裡,免得之後有人以為開了 worktree 就萬事太平。

| 隔得開 | 隔不開 |
|---|---|
| 工作檔案、git index、HEAD、分支 | 連接埠(兩個 dev server 搶同一個) |
| 各自 commit 不互相蓋 | 資料庫、`.env`、外部服務 |
| | `node_modules`(各自裝一份或自己接 symlink) |
| | 建置快取與暫存目錄 |

所以這個功能的承諾只有一句:**同一個專案的兩個對話改檔案不會互相蓋掉**。跑 server 或寫同一個 DB 的衝突不在範圍內。

上表右欄那些東西如果自己在 worktree 裡放了一份(`.env`、`node_modules`),關閉分頁時
worktree 不會被移除:移除的判斷含被 git 忽略的檔案,有這些就當成還有未提交的改動,
留在原地並顯示訊息。理由是 `git worktree remove` 會把整個目錄刪掉,被忽略的檔案一起帶走,
而 `.env` 通常沒有第二份。要清掉就自己刪那個目錄再 `git worktree prune`。

## 3. 決定

### 3.1 粒度:每個對話分頁一個,選用不強制

建立對話時多一個選項。不做「整個專案一律 worktree」:大多數對話只是問問題、讀程式碼,開一個 worktree 要複製環境、
裝 `node_modules`,成本遠大於收益。

### 3.2 位置與命名

- 目錄:`<rootPath>/.worktrees/<slug>`。沿用專案自己的慣例:先看 repo 裡有沒有 `.worktrees/` 或 `worktrees/`,
  有就用那個,兩個都有用 `.worktrees`,都沒有就建 `.worktrees`。
- `.worktrees` 必須被 git 忽略。`.gitignore` 裡沒有一行剛好等於 `.worktrees`(**不帶斜線**)就補一行。
  已經寫了帶斜線的 `.worktrees/` 也照樣補:帶斜線只擋目錄,擋不住同名的符號連結(RESULTS-21 踩過),
  所以兩行併存是刻意的。
- 分支名與 slug:使用者建立時輸入一段文字(例如「加購價上限」),slug 取它的前 32 字、空白轉 `-`、
  只留 `[A-Za-z0-9一-鿿_-]`;重複就加 `-2`、`-3`。分支名就是 slug。
- 以 `HEAD` 為基準:`git worktree add <path> -b <slug>`。不做「從某個分支開」,要那個的人自己在終端開。

### 3.3 不是 git repo、沒裝 git、已經在 worktree 裡

- 不是 git repo 或沒裝 git:選項本身不出現(建立對話的介面不畫那個選項),不是按下去才報錯。
- 專案根目錄本身就是一個 linked worktree:照樣可以再開(git 支援),基準是它的 HEAD。

### 3.4 狀態與 cwd

`TabEntry` 加選填 `worktreePath?: string`。有值時:
- 對話的 SDK cwd 用它(`ipc-bridge.ts` 的 `cwd: rootPath` 改成 `tab.worktreePath ?? rootPath`);
- 那個對話在右窗格 view 工具的 `file://` 範圍檢查(`activeProjectDir`)也用它;
- 分頁標題後面顯示 slug,讓人看得出這個對話在別的目錄。

`schemaVersion` 不變:新欄位選填,舊檔照讀。

**終端分頁不動。** 終端是 `tmux new -A -s sp-<tabId>`,它的 cwd 已經由專案表決定;要在 worktree 裡開終端的人,
在那個終端裡自己 `cd` 就好。把終端也綁進來會牽動 tmux session 的命名與還原,不值得。

### 3.5 關掉對話時

`git worktree remove` 會在有未提交或未追蹤的改動時拒絕。這是對的,那些檔案只存在那裡。

關掉有 worktree 的對話分頁時:
- 乾淨:直接移除 worktree,未合併的分支留著(分支很便宜,砍掉反而可能砍掉有用的 commit);
  已經合併進主目錄目前分支的則順便 `git branch -d`(合併規格 §5)。
- 不乾淨:**不移除**,跳一個訊息說「worktree 還有未提交的改動,留在 `<path>`,請自己處理」。不提供 `--force`:
  那會永久刪掉只存在那裡的檔案,不是 app 該替使用者決定的事。

### 3.6 不做的

- 不做「把 worktree 的改動合回主分支」的按鈕。(已由 `docs/specs/2026-09-23-worktree-merge-design.md` 取消,
  現在「查看 diff」面板最上方有合併列。)
- 不做跨對話的檔案衝突偵測。
- 不做 `node_modules` 的自動複製或連結。第一版讓使用者自己處理,等真的用起來覺得煩再說。

## 4. 驗收

| # | 做什麼 | 應該看到 |
|---|---|---|
| 1 | 在 git repo 的專案建對話,勾選 worktree,輸入「測試一」 | 多一個對話分頁,標題帶 slug;`git worktree list` 多一條 `.worktrees/測試一`;`.gitignore` 有 `.worktrees` |
| 2 | 在那個對話裡叫 agent 改一個檔 | 改的是 worktree 裡那份,主目錄那份不變 |
| 3 | 同一個專案的另一個對話改同一個檔 | 兩邊各改各的,互不影響 |
| 4 | 關掉乾淨的那個對話 | worktree 被移除,未合併的分支還在;已合併的分支被刪掉 |
| 5 | 關掉有未提交改動的那個 | worktree 留著,畫面上說明留在哪裡 |
| 6 | 非 git 資料夾的專案建對話 | 沒有 worktree 選項 |

## 5. 已知的行為改變

- Insights 歸戶：SDK 依 cwd 歸戶用量，同一個邏輯專案的對話開在不同 worktree 時，統計會依各自路徑拆開。接受此行為，目前不另行合併或處理。
- codex 的歷史 thread：`codexCatalog.items` 的 RPC 只帶 `threadId`，不帶 `cwd`，因此改用 worktree 路徑後，舊 thread 應仍可找到。這是閱讀 `src/main/codex/catalog.ts` 得到的結論，尚未透過整合測試驗證 codex CLI 的實際行為。

- 本機設定：建立 worktree 時會複製一份 `.claude/settings.local.json`，之後兩邊各自修改，不會同步。第二個以後的 worktree 也一律從專案主目錄複製，不會從前一個 worktree 複製。關閉分頁移除 worktree 時，那份副本會跟著被刪掉，在 worktree 裡對它做的修改不會保留。
- 專案子目錄：專案根目錄若是儲存庫的子目錄，例如 monorepo 的 `packages/foo`，`git rev-parse` 會往上找到儲存庫根目錄。建立的 worktree 是整個儲存庫的 checkout，因此對話的 cwd 所見目錄結構與未勾選 worktree 時不同。
- 保留 worktree 的情況：移除專案、重新指定專案資料夾及直接關閉應用程式，都不會清理 worktree，目錄與分支會留在磁碟上。重新指定資料夾之後，舊路徑的 worktree 無法再由應用程式清理，因為 Git 會拒絕跨儲存庫移除。專案只剩一個對話分頁時不能關閉，因此該 worktree 也無法透過關閉分頁移除。

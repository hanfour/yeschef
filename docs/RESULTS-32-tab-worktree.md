# RESULTS-32:對話開在自己的 git worktree

- 日期:2026-09-16
- 分支:`tab-worktree`,十二個 commit
- 規格:`docs/specs/2026-09-15-tab-worktree-design.md`
- 起因:使用者問「Orca 有個很重要的點:用戶可以同時同一專案做不同任務而不被影響,是因為會用 worktree 隔開?」

## 做了什麼

建立對話時多一個選項「在新的 worktree 開」,填一段文字當名字。勾了就 `git worktree add`,
那個對話的 agent cwd、右窗格的檔案範圍都指到新目錄,分頁標題後面加上 slug。
關閉分頁時,worktree 乾淨就移除(分支保留),有改動就留在原地並顯示訊息。
專案不是 git repo 時整個選項不畫。

## 六項實機驗收

| # | 情境 | 結果 |
|---|---|---|
| 1 | 建對話勾選、輸入「測試一」 | 標題 `Claude 對話 2 · 測試一`、`git worktree list` 多一條、`.gitignore` 有不帶斜線的 `.worktrees`、`.claude/settings.local.json` 有複製 |
| 2 | 那個對話叫 agent 改檔 | Write 的路徑是 `.worktrees/測試一/shared.txt`,主目錄的還是 `hello` |
| 3 | 另一個對話改同一個檔 | 主目錄「來自主目錄的對話」、worktree「來自 worktree 的對話」 |
| 4 | 關掉乾淨的 | 目錄移除、分支保留、無訊息 |
| 5 | 關掉有改動的 | 分頁關掉、worktree 留著、改動還在、訊息逐字相符 |
| 6 | 非 git 資料夾 | 完全沒有那個核取方塊 |

## 五輪審查各自擋下的東西

單元測試一路全綠,底下每一項都是審查或實機才發現的。

**建立成功但專案隨即被移除,worktree 洩漏且靜默。** `await createWorktree` 期間使用者移除專案,
`service.update` 因為 `next === prev` 不存檔、不通知、也不記錯誤。`git worktree add` 已經在磁碟上
建出目錄與分支,系統卻沒有任何紀錄。修法是 await 之後重新確認專案還在,不在就把剛建好的收掉。

**`execFile` 沒設 `maxBuffer`。** 預設 1MB,分支多的 repo 跑 `git branch` 或未追蹤檔案多時跑
`git status -uall` 會超過,錯誤訊息還會誤導成「git 失敗」。順手把那段抽成 `src/main/git-run.ts`
讓它可測,`src/main/index.ts` 原本完全沒有測試覆蓋。

**worktree 裡沒有 `.claude/settings.local.json`。** `settingSources` 是 `['project', 'local']`,
SDK 依 cwd 去讀,而那個檔通常被 gitignore,git worktree 只帶已追蹤的檔案。
使用者在原專案設的 allow 清單與 MCP 設定在 worktree 對話裡靜默失效。改成建立時複製一份。

**錯誤訊息是永久 latch。** dirty 訊息被塞進 `projects-service` 的 error 通道,而那個通道從來沒有人
設回 undefined;`composeView` 每次推狀態都帶上它,渲染端的 handler 又只有 `if (error !== undefined)`
沒有 else。出現一次就永遠釘在畫面上直到重啟,並蓋掉之後所有合法錯誤。
`useProjects.ts` 第 10 行的註解早就寫了契約「下一次成功就清掉」,只是從來沒實作。

**移除 worktree 沒等對話收尾。** `disposeSlot` 是 fire-and-forget,`service.update` 一返回就跑
`git status` 與 `git worktree remove`。回合進行中被強制關閉時,代理程式的中止流程還在寫檔,
`git status` 已經讀到「乾淨」然後把目錄刪掉。這正是 dirty 保護要防的事。
改成 `disposeConversation` 回 Promise,`onTabClose` 先 await 它。

**關閉分頁會刪掉 ignored 的檔案(阻擋項)。** 用真的 git 2.50.1 量出語意:

| worktree 裡有 | `git worktree remove` |
|---|---|
| tracked 但改過 | 拒絕,目錄留著 |
| untracked | 拒絕,目錄留著 |
| ignored | 直接刪掉,不提示 |

而 dirty 的判斷用的是 `git status --porcelain -uall`,不含 ignored。規格 §2 那張表自己叫使用者把
`node_modules`、`.env` 各放一份到 worktree 裡,照做之後關掉分頁 `.env` 就沒了,不提示、沒有 undo。
判斷改成加 `--ignored`。

反向的一面:我們複製進去的 `.claude/settings.local.json` 在沒有全域 `core.excludesFile` 的機器上是
untracked,加了 `--ignored` 之後所有 worktree 都會判成 dirty,而且就算判斷放行,
git 自己也會因為它是 untracked 而拒絕移除。所以移除前要先把那份副本刪掉。

**比對內容相同才刪,這個條件撐不住。** 第一版的做法是「副本內容與主目錄那份相同才排除、才刪」。
但 Claude Code 自己就會往 `settings.local.json` 寫權限,主目錄那份一被寫過副本就比不上,
於是關分頁永遠回 dirty、worktree 從此清不掉,訊息還是錯的。
查證使用者機器上三個專案的這個檔都是累積寫出來的(其中一份 7221 bytes,一路長到 2026-07),
確認這個情況是常態而非例外,改成一律不算 dirty、一律刪掉。
代價是 worktree 裡的權限授權跟著消失;那個 worktree 本來就要整個刪掉,重新批准的成本低得多。

## 安全

`worktreeName` 是不受信任的輸入。`slugify` 的順序是取前 32 字、空白轉 `-`、白名單過濾
(`[A-Za-z0-9一-鿿_-]`)、最後去掉頭尾的 `-`。所以 `../../../etc/passwd` 變成 `etcpasswd`,
`..` 落到 fallback,`-` 開頭被去掉(不會被 git 當成參數)。所有 git 都經 `createGitRun` 的
`execFile('git', [...])`,不經 shell。

## 已知的行為改變

寫在規格 §5,這裡列標題:Insights 的用量統計會依 worktree 路徑拆開;codex 的舊 thread 還找得到
(讀碼的結論,沒有整合測試驗證 CLI 行為);本機設定副本兩邊不同步且移除 worktree 時會被刪掉;
專案根目錄是 repo 子目錄時建出來的是整個 repo 的 checkout;移除專案、重新指定資料夾、
直接關掉 app 都不會清理 worktree。

## 還沒做的

- `isGitRepo` 改在切換專案時重算,但「加入時不是 repo、之後 `git init`」以外的更新時機仍然沒有。
- 專案只剩一個對話分頁時不准關,所以那個 worktree 沒辦法讓 app 移除。
- `node_modules` 不自動複製或連結,使用者自己處理。

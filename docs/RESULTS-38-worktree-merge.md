<!-- docs/RESULTS-38-worktree-merge.md -->
# RESULTS-38:在介面裡把 worktree 分支合回主分支

- 日期:2026-09-23
- 規格:`docs/specs/2026-09-23-worktree-merge-design.md`
- 計畫:`docs/superpowers/plans/2026-09-23-worktree-merge.md`
- `git` 版本:git version 2.50.1 (Apple Git-155)

## 1. 單元測試

| 檔案 | 測試數 | 結果 |
|---|---|---|
| `tests/worktree-merge-schema.test.ts` | 22 | 全過 |
| `tests/merge.test.ts` | 42 | 全過 |
| `tests/worktree-merge-ipc.test.ts` | 23 | 全過 |
| `tests/worktree.test.ts` | 71 | 全過 |
| `tests/worktree-merge-bar.test.tsx` | 15 | 全過 |
| `tests/projects-ipc.test.ts` | 49 | 全過 |
| `tests/panel-group.test.tsx` | 18 | 全過 |
| `tests/ipc-bridge.test.ts` | 113 | 全過 |
| `tests/development-diff-view.test.tsx` | 5 | 全過 |
| `tests/preload-bridge.test.ts` | 17 | 全過 |
| `npm test` 全套 | 149 個檔案、2760 個測試 | 全過 |

`npm run typecheck` 的結果:通過,無錯誤輸出。

## 2. 真 git 整合測試

`npx vitest run tests/merge-real-git.test.ts` 的輸出:

```
 RUN  v4.1.11 /Users/me/Projects/yeschef

 ✓ tests/merge-real-git.test.ts > worktree 提交後合併成功,主目錄的 log 有那個 commit 1704ms
 ✓ tests/merge-real-git.test.ts > worktree 有未提交改動時先自動提交,再合併;本機設定檔不進歷史 1459ms
 ✓ tests/merge-real-git.test.ts > 兩邊改同一個檔時第一次得到 conflict,解完再按一次得到 merged 2874ms
 ✓ tests/merge-real-git.test.ts > 衝突中途 abort,worktree 回到解衝突前的狀態 1860ms
 ✓ tests/merge-real-git.test.ts > 主目錄有未提交改動時拒絕,什麼都不動 928ms
 ✓ tests/merge-real-git.test.ts > 兩段之間主目錄被動過:第二段 ff 失敗,訊息是 fatal 那行,主目錄仍然乾淨 1476ms
 ✓ tests/merge-real-git.test.ts > 主目錄 detached 時拒絕 1086ms

 Test Files  1 passed (1)
      Tests  7 passed (7)
   Start at  04:13:13
   Duration  11.83s (transform 124ms, setup 0ms, import 157ms, tests 11.39s, environment 0ms)
```

七條各驗什麼:

| 案例 | 驗到的事 |
|---|---|
| worktree 提交後合併成功 | 主目錄 `git log` 有 worktree 的 commit,檔案內容換成 worktree 的版本 |
| 未提交改動先自動提交 | 自動提交訊息進了歷史,`.claude/settings.local.json` 沒有被追蹤 |
| 兩邊改同一個檔 | 第一次 `conflict`、主目錄沒有 MERGE_HEAD 且 `status --porcelain` 為空、`status` 回 `conflictPending: true`、再按一次 `conflictPending`、解完之後 `merged` |
| 衝突中途放棄 | `merge --abort` 後 worktree 回到解衝突前,`status` 的 `conflictPending` 為 false |
| 主目錄有未提交改動 | `rootDirty`,主目錄的 log 沒有多出東西 |
| 兩段之間主目錄被動過 | 第二段 ff 失敗回 `failed`,訊息取的是 `fatal:` 那行而不是 `hint:`,主目錄仍然乾淨也沒有 MERGE_HEAD |
| 主目錄 detached | `rootDetached`,`status` 的 `target` 為 null |

測試用的 repo 另外關掉 `core.excludesfile` 與 `core.hooksPath`,結果不受開發機的個人設定影響。

## 3. 實機驗收(規格 §9)

| # | 步驟 | 預期 | 結果 |
|---|---|---|---|
| 1 | 開帶 worktree 的對話,要 agent 改一個檔並提交,按合併 | 主目錄 `git log` 有那個 commit | 未驗收 |
| 2 | 主目錄手動改同一個檔並提交,再按合併;agent 解完提交後再按一次 | 第一次出現衝突列且對話收到 `agentConflict`,第二次合併成功 | 未驗收 |
| 3 | worktree 有未提交改動時按合併 | 先看到自動提交的 commit,再合併成功 | 未驗收 |
| 4 | 主目錄有未提交改動時按合併 | 被拒並列出檔案 | 未驗收 |
| 5 | agent 回合中按合併 | 被拒 | 未驗收 |
| 6 | 合併後關分頁;另一個未合併的分頁也關掉 | 已合併的 worktree 移除且分支被刪,未合併的分支仍在 | 未驗收 |

## 4. 已知限制

- 只合 worktree 所在的主 repo,巢狀 repo 不處理(規格 §10)。
- 不 push、不開 PR、不 rebase、沒有衝突編輯器。
- 合併對象固定是主目錄目前所在的分支。主目錄自己是別的 worktree 時,目標就是它當下的分支。
- `status` 不輪詢:開面板查一次,合併與放棄之後各查一次。在別的地方(終端)改了 git 狀態,要按合併或重開面板才會反映。
- 對話還沒開起來時,衝突那句話送不到 agent(沒有對話核心),衝突列仍會列出檔案,人可以自己在終端解。合併以專案為單位上鎖(第二段跑在主目錄),放棄合併以分頁為單位;鎖著的時候再按一次直接回「上一次的合併還在進行中」,不會重跑 git。合併進行中關帶 worktree 的分頁會被擋下,分頁與 worktree 都留著;沒有 worktree 的分頁照常關。
- 自動提交會把 worktree 裡沒被任何 gitignore 蓋到的檔案一起提交,只排除 `.claude/settings.local.json`(規格 §2 明訂「合併前自動 `add -A` 並 commit」)。不想進歷史的檔案要自己加進 `.gitignore`。
- 放棄合併跟合併一樣先看 agent 忙不忙:agent 正在解衝突時按放棄會被拒,因為那會把它腳下的 merge 拿掉。主廚(chef)管理中的分頁也算忙碌。
- 檔名清單(`rootDirty`、衝突檔案)直接取自 `git status --porcelain` 的路徑欄位,改名的檔案會整行顯示成 `舊名 -> 新名` 這一個字串,不會拆成兩個檔名。
- 合併列與衝突列共用的 `--warning` token 也是核准卡、待處理提示列等既有元件在用的顏色,沒有為合併場景另外調過對比度。

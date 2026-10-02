# YesChef 工程規則

適用於 Claude Code、Codex 與 Grok 在本 repo 的工作。

## 總則

驗證才是工作，寫程式是簡單的部分。

## 動手前

- 先用自己的話重述任務、假設與明確不做的事，並說明完成時要觀察到什麼。
- 修 bug 或改行為前，先查相關程式與資料流，再用 `npm run dev` 或相符的 `spike:*` 重現。若環境不允許，記下阻礙與未知之處。
- 純文件任務先核對來源，不為了流程啟動 app。
- 先讀相關 `docs/specs/`、`docs/superpowers/plans/` 和鄰近實作；規格未定的產品決策先問人，不自行補上。

## 工作中

- 每次只處理一個明確範圍，優先小改動，避免順手重構。
- 修根因，不只遮住症狀；需要暫時作法時，說明限制與何時移除。
- typecheck 或 build 通過不代表功能可用；行為改動要操作真的 Electron app 或對應的真實 CLI spike。
- 不捏造產品行為、資料或文案。使用者看得到的字串不得出現內部名稱、TODO 或開發者自述。
- 不變量要由測試或可觀察檢查驗證；新增檢查後確認錯誤案例會失敗、正確案例會通過。
- 收到糾正時，修正後提煉可重用通則，寫進本檔或相關規格，不保留事件細節。
- 守衛或過濾類程式碼要先分清「自己」與「外部」：renderer 自己的來源、app 自己的視窗、專案自己的路徑，不能跟外部連結、外部視窗、外部路徑用同一條規則處理。
- 同一個檔案有另一個 agent 正在改時，不要把整個檔案 `git add` 進自己的 commit；只暫存自己的 hunk，或等對方交付。

## 交付證據

| 改動 | 證據 |
|---|---|
| UI | 附 `.spike-out/ui/` 截圖，或跑 `npm run verify screenshots`；互動改動另操作相關流程。 |
| 主行程 | 跑相關 vitest 與適用的 `npm run verify <flow>`；逐項查看 `{check, ok, detail}` JSON，全部通過時應以 exit 0 結束。 |
| Bug | 記下修前重現步驟與結果，再用相同步驟確認修後通過。 |
| 文件 | 列出自查指令與結果；文件聲稱的檢查不得只寫「已確認」。 |

`npm run verify` 列出目前六個 flow（`browser`、`grok`、`screenshots`、`contrast`、`sessions`、`memory`）；不確定哪個 flow 對應哪個功能，查 `docs/feature-map.yaml` 每個功能的 `verify` 欄位。`grok` 會用 grok.com 額度，`browser`／`screenshots`／`sessions` 會開 Electron 視窗，使用者手動驗收時避免同時跑。

把證據填入對應 `docs/RESULTS-*.md` 驗收列的「結果」欄；欄名不同時沿用該文件的結果欄。未實際驗收的項目保留「未驗收」，沒有驗收列時沿用文件既有結果格式。

## 程式風格

- TypeScript 維持 strict；避免 mutate 既有物件與狀態。
- 函式不超過 50 行，檔案不超過 800 行。
- app 程式不用 `console.log`；錯誤透過 `deps.logError` 記錄。
- 使用者可見訊息集中在各模組的 `MSG`。
- CSS 使用 `src/renderer/theme.css` 的 token，遵守 `tests/theme-rules.test.ts`。
- 新增依賴前先停下來徵求同意。

## 被糾正時

- 寫下能避免同類問題的通則，放進 `AGENTS.md` 或對應規格，不記事件經過。
- 錯誤：「截圖看得到新按鈕，就算 UI 驗收完成。」
- 正確：「改動後實際操作面板，確認原有控制項仍看得到且能使用。」

## 停下來問人

- 要執行 `git reset`、force push、`git branch -D`，或移除含未提交改動的 worktree。
- 會碰使用者資料或憑證，例如 `testMachines` 密碼或 macOS Keychain。
- 新增依賴、需要猜產品決定，或同一做法已失敗兩次。

## 審查反模式

- 可描述的不變量沒有任何測試或檢查驗證。
- 版面改動遮住既有互動元素，或把它們推到視窗外。
- 還沒找到根因就送出修正。
- 刪除測試或放寬斷言，只為了讓測試套件變綠。
- 衍生狀態在主行程與 renderer 各自計算，導致顯示不一致。
- 新增 CSS 繞過 theme token 或 `tests/theme-rules.test.ts` 的限制。

## 文件語氣

- 不用破折號。
- 一段最多一處粗體，只寫結論，不寫過程。
- 規格與驗收文件遵守 `~/.claude/skills/writing-tone`。

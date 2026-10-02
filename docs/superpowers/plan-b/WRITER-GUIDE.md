# 計畫撰寫者須知（每個 task 撰寫者都要先讀）

你在寫的是**實作計畫的一個 task**，不是實作。讀者是一個對本專案零脈絡、之後會照著逐字執行的工程師。
輸出檔：`docs/superpowers/plan-b/task-<N>.md`（控制端指定）。

## 權威順序

1. `docs/superpowers/plan-b/CONTRACT.md`：型別契約與全部裁決（§15 是一覽表）。**照抄，不得改。** 需要偏離就在回報裡寫「契約疑慮」，等裁決。
2. `docs/specs/2026-09-03-yeschef-b-view-tools-design.md`：規格。契約沒講的看規格；契約與規格衝突時以契約為準（契約 §15 已列出哪些是刻意改動規格）。
3. `docs/superpowers/plan-b/plan-header.md` 的 Global Constraints 一節：每個 task 都要遵守。
4. 上游 task 檔（控制端指定哪幾份）：只看 Interfaces 與你會 import 的那幾段，不必整份讀。
5. 現有程式碼：`src/main/cdp.ts`、`src/main/agent-host.ts`、`src/main/ipc-bridge.ts`、`src/renderer/components/*` 等。契約 §0 列了已查證的現況，你動到的檔案自己再開一次確認行號。

## 格式（superpowers writing-plans 的 task 結構）

```
### Task N: 名稱
（兩到五段設計理由：為什麼這樣切、哪些取捨、哪些是實機驗過的）
**Files:** Create／Modify／Delete／Test 的精確路徑（Modify 附行號範圍）
**Interfaces:** Consumes（含來源 task 與精確簽章）／Produces（下游會用的精確簽章）
- [ ] **Step 1: 寫失敗的測試**（完整測試程式碼）
- [ ] **Step 2: 跑測試確認失敗**（指令與預期輸出）
- [ ] **Step 3: 最小實作**（完整程式碼）
- [ ] **Step 4: 跑測試確認通過**
- [ ] **Step 5: 突變測試**（見下）
- [ ] **Step 6: 提交**（git add 精確檔名，commit 訊息 `<type>: <description>`，繁體中文，不加任何 trailer）
```

大一點的 task 可以拆成多組 Step 1 到 4（每組一個模組或一個行為），但每組都要有完整程式碼與測試。

禁止：TBD／TODO／「加上適當的錯誤處理」／「類似 Task N」／只描述不給程式碼／引用任何 task 都沒定義的名稱／
程式碼區塊裡寫「⋯（略）」。

## 突變測試（強制）

至少三個突變。每個突變：把實作改成一個「看起來合理但錯」的版本、跑測試、貼出變紅的測試名稱、
還原、確認回綠。**要挑會讓測試變盲的突變**，Plan A 已有五次「測試名字對、斷言對、但錯誤實作照樣通過」：

- 突變後筆數不變只有內容錯
- 測試指向第一筆資料，讓「退化成永遠取第一筆」的突變通不到
- 測試參數讓正確與錯誤算法巧合同值（例如 offset 為 0 時加不加 offset 都對：測試要用非零 offset）
- 實作結構讓正確性變成巧合，得改實作而非改測試

B 特有的盲點：座標測試要用非零 frame offset 與非 1 的 scale；ref 測試要同時有 `s1-e2` 與 `s2-e1`；
時間相關測試（settle、handoff、HandoffCard）要用 `tests/helpers/manual-clock.ts` 的到期排序，不能只靠「全部觸發」。

若某個突變在你的測試下全綠，那是發現不是失敗：修測試或修實作，然後把過程寫進 task。

## 實機驗證

計畫裡凡是寫「已驗證」「實測」的句子，必須真的跑過。方式：

```bash
git worktree add /tmp/wt-<N> HEAD
cd 那個目錄 && npm install
```

上游 task 的程式碼尚未實作，需要時從對應 `task-N.md` 的程式碼區塊複製進 worktree（那是計畫定稿的程式碼）。
上游 task 檔還沒寫好（同一波平行撰寫）時，照契約的簽章自己寫一份最小 stub 放進 worktree，並在回報說明。
worktree 裡的東西**不提交**；結束前 `git worktree remove --force <path>`。主工作樹只准寫你的 `task-<N>.md`。

vitest 指令：`npx vitest run tests/view-tools/<module>.test.ts`；型別：`npx tsc --noEmit -p tsconfig.json`
（先看 `package.json` 的 `scripts` 確認實際指令）。

沒跑過的就寫「推論」，不要寫「已驗證」。

## 輸出紀律（不遵守會被平台中止）

單次回應上限 16384 token。**至少四次 Write／Edit 分段寫檔，每次工具呼叫的內容不超過 3000 token。**
第一次 Write 只寫標題到 Interfaces；之後每個 Step 用 Edit 追加（Edit 的 old_string 用檔尾唯一標記，例如
最後一行放 `<!-- END -->`，每次追加都在它前面插入）。
最後一則回覆只回：狀態（DONE／DONE_WITH_CONCERNS／BLOCKED）、檔案行數、測試數、突變數、契約疑慮（若有）。300 字以內。

## 語言

繁體中文台灣用語。不用破折號（`——`／`—`），改用冒號、括號或分句。不用：落地、口徑、粒度、
收斂、邊界、復用、暴露、揭露、梳理、閉環、兜底、賦能、打造、驅動、承接、健壯／魯棒、值得注意的是。
程式碼識別字與英文術語不受限。粗體一段最多一處。給使用者看的文案（錯誤訊息、卡片文字）一律照契約的字串，不自己改字。

## 其他

- 不派 subagent。
- 不動契約、不動別的 task 檔、不改 `src/`（主工作樹）。
- 檔案上限 400 行（契約 §1）；超過就在 task 裡拆檔並說明。
- 程式碼註解引用裁決時寫 `// 裁決 N（docs/superpowers/plan-b/CONTRACT.md）`，讓之後的人找得到。
- 遇到需要裁決的事，先照契約字面做完，再在回報列出疑慮與你的建議。不要停下來等。

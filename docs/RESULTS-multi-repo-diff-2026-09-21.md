# 父層工作台的多 repo 開發變更

2026-09-21。使用者在 Workspace 工作台修改 web-ui 與 service-b，原本只查詢工作目錄所屬 Git repository，Workspace 本身沒有 .git，因而無法看到子 repo 的變更。

## 使用方式

在 Workspace 對話按「查看 diff」，右側選擇 Git repository（例如 web-ui 或 service-b），再選範圍：

| 範圍 | 用途 |
| --- | --- |
| 目前未提交變更 | 與該 repo 的 HEAD 比較，包含 staged、unstaged 和未忽略的 untracked 檔案 |
| 本次對話開始後 | 與此對話交付開發訊息前保存的各 repo 基準比較，包含後來已 commit 的內容 |
| 指定基準（含已 commit） | 輸入修改前的 commit、分支或 HEAD~1，比較到目前工作目錄；包含其後的 commit 與未提交內容 |

這次舊工作沒有事前基準，不能倒推哪些 dirty 修改在對話開始前已存在。可立刻使用未提交範圍；已 commit 的工作可指定修改前的 commit。之後第一次經使用者輸入入口送出訊息時，會分別建立掃描到的各 repo 基準，後續訊息沿用，不覆蓋原始基準。開始另一輪工作需要獨立範圍時，可開新對話。

## 實作與邊界

- 工作目錄自身／所屬 repo 沿用既有行為；父層非 Git 目錄會發現子 repo。
- 自動掃描最多 3 層、1000 個目錄、50 個 repo；跳過 symlink、隱藏目錄與 node_modules／vendor／dist／build 等依賴或輸出目錄。達到上限會提示，更深的 repo 可另外加入專案。
- 支援一般 .git 目錄及 worktree 的 .git 檔案。每次讀取驗證所選 opaque repo ID 仍在發現清單中，renderer 不可指定任意讀取路徑。
- 同一對話以各 repo 的 canonical root 分開儲存基準及成功／失敗清單；單一 repo 失敗不影響其他 repo。清單建立後才出現的 repo 不補造先前基準，改用未提交或指定基準。
- 保留單一 repo 舊基準的 key，相容既有對話資料。
- 初始二進位檔案以 SHA-256 指紋保存，避免大量圖片占滿基準容量而排擠文字檔案；相同圖片不會誤報成變更。
- 指定 Git ref 使用 execFile、rev-parse --verify --end-of-options 解析 commit，後續只使用驗證後的 object ID，不經 shell。
- 此為時間／Git 基準範圍的比較，不辨識共同工作目錄中的變更作者。指定分支比較是該分支 commit 到目前工作目錄，不自動改成 PR merge-base。
- Git 原始檔案、branch、index 與 Workspace 專案程式碼均未修改；只有 YesChef 本身的功能與測試變更。

## 驗證

- typecheck、正式 build、git diff --check：通過。
- 完整測試：111 個檔案、2,291 項通過。
- 新增回歸：父層多 repo 各自 dirty／commit 比較、repo ID 邊界、worktree、symlink、晚出現 repo、指定 commit、無效 ref、repo 切換與大量圖片基準。
- 真實 Workspace 掃描到 29 個 repo；選單另含一筆提示 option，共 30 個 options。
- 真實 Electron 驗收：web-ui HEAD 0b629e9b 顯示 103 個未提交檔案；service-b HEAD 539ae1c0 顯示 docker-compose.yml 1 個檔案。這是當時工作目錄的完整未提交範圍，沒有宣稱全部由單一任務產生。
- service-b 指定 HEAD~1（1f7cf466）成功顯示 12 個檔案；切換 repo 與比較範圍、480px 預覽無水平溢位。
- 重啟前確認無草稿、執行中任務或待批准請求；載入新版後保留 Workspace → web-ui → 未提交變更供使用者查看，未送出模型任務。

## UI 與證據

| Before | After | Why |
| --- | --- | --- |
| 父層沒有 .git 就無法查看 diff | 列出子 repo，選擇個別工作目錄 | 支援 Workspace 這類多專案工作台 |
| 沒有舊基準且已 commit 時無法比較 | 指定 commit／分支作為起點 | 可查看既有已提交工作，不偽造歷史基準 |
| 多 repo 共用一個入口而無來源標示 | repo 選單與基準標題顯示來源 | 切換前後能確認正在查看哪個專案 |

下列為真實 YesChef 截圖，檔案內容區域以洋紅色遮罩遮蔽，避免將其他專案的原始碼／設定複製到此報告。遮罩只存在於截圖，產品本身正常顯示 diff。

截圖未收錄。

## 後續修正

依使用者要求，repo 選單已改為只列本次對話可驗證成功寫入的專案，不再呈現完整目錄清單。見 [對話 repo 篩選驗收](RESULTS-conversation-repo-filter-2026-09-21.md)。

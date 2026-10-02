# 外部 Codex 委派的 repo 歸屬恢復

2026-09-21。使用者指出真實下拉仍只有 web-ui。先前的「僅採用有證據的寫檔」漏了父 Claude 透過 Bash 啟動外部 codex exec 的委派鏈；不是實際只有一個 repo 被修改。

## 已修正

保留原本 SDK 工具與子 agent 證據，另外讀取平台已保存、屬於目前 parent session 的原始 transcript。對已執行的明確 codex exec --cd … > … 2>&1 呼叫，依序驗證：

1. 父 session 中成功 Write 的任務檔案內容，以及 launch 使用該檔案的 cat 參數。
2. 父工具結果沒有標示 error；允許仍在背景執行，因為只記已成功的寫檔，不宣稱整個任務已完成。
3. stdout 的 UUIDv7 child session ID 與 launch 時間（容差 -5 秒到 +10 分鐘）。
4. 子原始 session metadata 的 ID、exec source、canonical cwd 與實際 user task 文字都符合父呼叫。
5. 子 exec_command 以 apply_patch heredoc 開頭；該 call ID 的結果為 exit 0 並回報成功更新，輸出檔案必須與提交的 patch 路徑一致。尊重 command-local workdir。

驗證後的路徑帶 parent/tool/child 身分及任務內容 hash 回傳，與主 session 寫檔紀錄合併並交給既有持久化 ledger。全程只讀原始紀錄，不執行 transcript 裡的命令，不依模型最後一段文字聲稱成功來判斷。

## 真實結果

- Parent Claude session：8c5dc871-b130-40c6-b066-c4d8469d6a89。
- service-a child：01a0c24c-4d22-78a2-9543-498ba5752e25，驗證 6 個檔案：5 個 Ruby 檔案與 1 個資料庫 migration。
- web-ui child：01a0c24c-5230-7931-ae22-a1f5737748ba，另外恢復 4 個可驗證 patch 路徑。
- 真實 Electron 選項為「本次對話修改的 repo、web-ui、service-a」。目前停在 service-a 的未提交比較。
- service-a 工作目錄當時共有 12 個未提交檔案，包含既有本機設定；沒有把全部 12 個都歸因於這筆委派。repo 名單依寫檔證據，diff 檔案範圍仍依所選 Git 比較模式。

## 驗證與界線

- typecheck、build、git diff --check 通過。
- 完整回歸 114 個檔案、2,303 項通過；加強任務內容比對後，相關 101 項再次通過。
- 測試涵蓋 launch 格式、動態／相對路徑拒絕、成功 patch 與 call ID、command cwd、父 session 隔離、task 不符、時間不符。
- 真實資料的任務文字、cwd、child ID 與 patch 成功記錄皆已對應，未呼叫新模型任務，未修改 web-ui／service-a 的程式碼或 Git index。
- 這是有限的舊委派恢復：最多 16 個 launch；parent／child transcript 各 64 MiB、stdout 16 MiB 上限。只支援目前可驗證的 launch／任務檔／patch 格式；缺失、覆寫或不符時明示不完整，不能保證解析任意 shell 或任何版本的 CLI。
- 未來的自動主廚應使用正式 task registry 登錄所有 parent／child／provider／model，而非靠事後 log 推回來源。自動路由與故障接手機制見 PLAN-auto-chef-routing-2026-09-21.md，目前尚未實作。

截圖未收錄。

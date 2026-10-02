# 對話導覽、附件與開發 diff — 2026-09-21

已完成並載入 YesChef。

## 使用方式

- 對話往上捲動後，底部出現「↓ 回到最新訊息」。點擊立即回到底部，並恢復追蹤後續串流；閱讀舊訊息時不強制跳回。
- 輸入框左下角「＋ 附件」可選擇本機文件或照片。送出前顯示檔名、大小、照片預覽，可逐一移除；可以只送附件。選檔與預覽不呼叫模型，按送出後才交付。
- 對話工具列「查看 diff」在右側開啟開發變更。可以切換「本次對話開始後」與「目前未提交變更」、選取檔案、重新整理，查看新增／刪除行與 hunk 位置。

舊對話沒有可回溯的開發基準，可先看未提交變更；下一次透過輸入框或既有輸入 IPC 送訊息時，會在交付 agent 之前自動建立基準。沒有 Git repository 的工作目錄會顯示明確原因，仍能正常送訊息。

## 附件契約

圖片：PNG、JPEG、WebP、GIF。文字：TXT、Markdown、CSV、JSON、YAML、XML、HTML、CSS、TS／TSX、JS、Python、log。原始文件：PDF、Word、Excel、PowerPoint、ODT、RTF。

最多 8 個附件；圖片每份 5 MiB、文件每份 10 MiB、每則訊息合計 20 MiB。UTF-8 文字合計不超過 200,000 bytes 時直接交付內容，超出者改交付原始文件副本。PDF／Office 不在 YesChef 內建抽取器中解析，而是提供本機副本給 agent 的工具讀取；實際可解析格式取決於該 agent 可使用的工具與環境，必要批准仍適用。

本機副本存於 userData/attachments，UUID 識別碼與對話分頁綁定。Renderer 不可指定任意來源路徑；來源只能經主程序檔案選擇器。複本採唯讀檔案權限，檢查一般檔案、大小、圖片簽名與 UTF-8。批次選檔失敗會清除該批已建立副本，移除未送出的附件不刪除原檔。

Claude 以原生 image/base64 區塊接收照片，Codex 以原生 localImage 接收。文件資料與訊息在同一回合交付。Live 與歷史畫面以附件檔名摘要呈現，不顯示整份文件內容；送出前可看到照片縮圖。已送出副本保留以供歷史接續讀取，本版尚無已送出附件庫的清理介面；未送出草稿沿用現有對話生命週期，不承諾跨重啟保留。

## Diff 範圍

第一則輸入交付之前，以 HEAD 加上當時已存在的 dirty／untracked 檔案內容建立基準；後續與該基準比較，因此包含這次之後已 commit 的內容，也不把開始前就有的修改重算成新的開發。

基準依專案／分頁／thread／工作目錄保存於 userData/development-baselines。開新 thread 使用新基準。git 查詢禁用 external diff、textconv、fsmonitor 與 optional locks；不 stage、不 commit，也不修改使用者的 Git index。使用獨立暫存檔產生統一 diff，檔名採 literal pathspec。

- 每次最多 200 個檔案，單檔 512 KiB，diff 合計 4 MiB；超過時明示省略。
- 初始變更超過 200 檔時不建立不完整基準，之後仍能看未提交 diff。
- 二進位、子模組、無法讀取的基準檔案明示狀態，不假造文字差異。
- 不跟隨 tracked 目錄被替換成的外部符號連結。
- 同一工作目錄可能有其他 agent／使用者同時修改，這是時間範圍的比較，不宣稱能辨識變更作者。
- peer 內部直接投遞而未經使用者輸入入口的工作，本版不自動補造先前基準。

## 驗證

- `npm run typecheck`、`npm run build`、`git diff --check` 通過。
- 完整測試：111 個測試檔、2,286 項全部通過。
- 新增／調整回歸涵蓋回到底部後追蹤串流、附件失敗保留／重試、ownership、來源副本、圖片格式、批次回復、歷史摘要、Claude／Codex 原生 payload、切換分頁時固定送往原對話、session 變更時拒絕錯送、Git index 不變、初始 dirty 排除、已 commit 納入、untracked／空檔／binary／外部 symlink。
- 真實 Claude host 管線：合成圖片 picture.png（檔名未提供顏色），搭配文字附件，5,199ms 回答「Red」，無錯誤；模型回報成本 US$0.002627。沒有啟用工具或修改專案。Codex 以 client protocol 回歸確認 localImage 與文件資料同一 turn，未額外呼叫真實 Codex 模型。
- 真實 Electron 元件驗收：附件清單／預覽／合成送出、回到最新、diff 檔案與範圍切換，以及 480×820 viewport 無水平溢位。目視發現過 diff span 橫向排版問題，已改為逐行 block 並加上實機幾何檢查。
- 真實 YesChef：從 demo-app 開啟右側 diff，讀到 HEAD c0b7b28a、0 個未提交檔案；驗證附件入口與最新位置按鈕。驗收完恢復原本的 active 專案。
- 作業系統檔案選擇器未以 OS UI 自動化選檔；服務測試使用實際暫存檔案與注入的選檔結果。下列附件／有內容 diff 截圖是明確標示的隔離合成示例，非真實開發任務輸出。

## UI 檢查與畫面

| Before | After | Why |
| --- | --- | --- |
| 往上閱讀後只能手動捲回底部 | 浮動「回到最新訊息」，立即恢復串流追蹤 | 保留閱讀位置且可快速返回 |
| 輸入框只支援文字 | 文件／照片清單、縮圖、移除與失敗保留 | 送出前能確認附件 |
| 無法在工作台查看程式差異 | 右側 diff，兩種範圍、檔案清單與增刪行 | 直接檢查當次開發內容 |

截圖未收錄。

## 後續更新

父層工作台的子 repo 選擇及指定 commit／分支比較，已於同日補上，見 [多 repo diff 驗收](RESULTS-multi-repo-diff-2026-09-21.md)。

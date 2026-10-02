# 工作台固定左側歷史欄

使用者回報切換 Claude 以外的分頁時側欄消失。原本歷史欄由 ConversationPane 擁有，終端分頁沒有該元件，且每個對話各自保存收合狀態。

| Before | After | Why |
| --- | --- | --- |
| 側欄存在於各對話 slot 內 | WorkspaceHistory 位於所有 slot 外側 | Claude、Codex、終端切換都保留同一個左側 DOM |
| 每個分頁有獨立搜尋與收合狀態 | 共用搜尋、範圍與寬度，側欄常駐 | 切換不再讓導覽消失 |
| 切 provider 載入時可能暫留舊清單 | 資料來源不同時先清空可見項目 | 不把另一 provider 歷史錯開到目前對話 |

歷史清單依目前原生對話的 provider 顯示；終端顯示本專案最近使用的原生對話歷史。終端中點歷史會先切回對應原生分頁，再開啟該紀錄。切換不會終止背景對話或卸載終端。

桌面沿用可拖曳寬度；窄欄上限為可用寬度 40%，保持側欄與主要內容並列。工作台的右側預覽切換仍依原本響應式設計。

驗證：TypeScript、build、diff whitespace 檢查通過。WorkspaceHistory、ConversationPane、LeftPane、useSessions、App 共 5 files / 103 tests 通過。真實 YesChef 建立臨時 Codex 與 zsh 分頁後依序切換，三者左側 x 均為 0、桌面寬度 280px；480px 視窗側欄縮至 192px，無頁面水平溢出。完成後關閉測試分頁並恢復原對話。測試未送出模型任務。

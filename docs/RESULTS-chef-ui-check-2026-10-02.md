# 主廚驗收介面檢查結果

日期：2026-10-02

## 自動驗證

| 項目 | 結果 | 證據 |
|---|---|---|
| 純黑白規則與有效略過註解 | 通過 | `tests/chef-ui-check.test.ts` 覆蓋黑白色寫法、透明度與選擇器邊界、缺原因註解仍觸發發現，以及有效略過不配置 F 編號 |
| fixed 重掃與任務畫面 | 通過 | `tests/chef-ui-check-service.test.ts` 驗證修正後仍觸發拒絕、修好後接受、改由有效略過註解擋下時接受並保存原因；`tests/chef-manager.test.tsx` 驗證待處理、已略過與缺少原因分開顯示 |
| 型別檢查 | 通過 | `npm run typecheck`，exit 0 |
| Electron 開發版啟動 | 通過 | `npm run dev` 完成 main、preload、renderer 建置並啟動 Electron；renderer 位址為 http://localhost:5174/ |
| 本功能定向測試 | 通過 | `npx vitest run --configLoader runner tests/chef-ui-check.test.ts tests/chef-ui-check-service.test.ts tests/chef-manager.test.tsx`：3 個測試檔、34 項通過 |
| Vitest 全集 | 通過 | `npx vitest run --configLoader runner --exclude tests/chef-view-tools.test.ts --exclude tests/grok-view-tools.test.ts --exclude tests/terminal-server.test.ts --exclude tests/view-tools-http-server.test.ts`：182 個測試檔通過、1 個略過；3,195 項通過、1 項略過 |

## 尚未驗收

| 項目 | 結果 | 證據 |
|---|---|---|
| Electron 截圖 | 未驗收 | `npm run verify screenshots` 與停用 GPU 的重試均完成 build 與 bundle，Electron 子程序在截圖前以 `SIGABRT` 結束，沒有產生檢查 JSON |
| 示範專案主廚流程兩輪 | 未驗收 | 未對示範專案建立主廚任務；本輪只以 service 測試驗證掃描、回報與重掃流程 |

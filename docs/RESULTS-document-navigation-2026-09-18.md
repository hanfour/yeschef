# 右側文件預覽：導覽與搜尋（2026-09-18）

## 本輪改善

- 文件工具列提供檔名、搜尋與重新整理；長檔名省略，滑鼠停留可看來源路徑。
- 章節目錄由實際渲染標題建立，支援中文、行內格式與重複標題；點選後只捲動右側文件內容。
- 文件內 `#章節` 連結留在預覽內；找不到章節時顯示原因，不改工作台網址。
- 對話與文件連結保留 `file.md:12`、`:12:3`、`#L12`／`#L12-L20` 定位；同一來源重用分頁並更新目的地。主行程仍只收到乾淨檔案路徑，沿用既有檔案存取限制。
- 行號輸入定位至原始 Markdown 對應段落／程式碼區塊，並突出顯示。空白行選下一個區塊，尾端空白選前一個區塊；不是原始碼編輯器的逐行游標。
- 文件內搜尋忽略大小寫，以純文字字串比對，跨粗體、連結與程式碼高亮片段；顯示結果數並可循環前後移動。搜尋範圍是渲染文字，不含 Markdown 語法、圖片內容或 URL 屬性。
- 文件區內 Ctrl／⌘+F 開啟搜尋；Enter／Shift+Enter 切換；Escape 關閉並恢復搜尋按鈕焦點。目錄亦可用 Escape 關閉。
- 重新整理沿用 readPreview 重讀與錯誤重試；不加入持續檔案監聽。重讀會重置搜尋狀態並套用原連結定位。

## 驗證

`npm run typecheck` 通過。

`npm test -- tests/preview-pane.test.tsx tests/preview.test.ts tests/previews.test.ts tests/markdown-component.test.tsx tests/app.test.tsx tests/preview-read.test.ts`：6 files、88 tests 通過。包括跨格式搜尋、特殊字元純文字比對、鍵盤焦點、中文／重複標題、缺失章節、來源專案保留、App 到預覽的行號傳遞、同檔不同定位去重，以及讀取失敗重試。既有 jsdom canvas／外部 navigation 提醒仍存在，未新增瀏覽器跳轉例外。

使用正在運行的 YesChef Electron（renderer localhost:5173）實際點擊 demo-app 對話中的 `docs/LOCAL-ACCEPTANCE-PAYMENT-RECONCILIATION-2026-09-18.md:1`，沒有注入 React 狀態或改 demo-app 檔案：

| 情境 | 結果 |
| --- | --- |
| 800px／400px 文件 | 預覽 clientWidth／scrollWidth 分別為 800／800、400／400，沒有整頁水平溢位 |
| 章節目錄 | 7 個標題；末節可到達，工作台 document scrollTop 保持 0 |
| 搜尋「報表」 | 6 個結果，下一個切換至 2／6，字串高亮與捲動正常 |
| 第 45 行 | 定位對應表格區塊並顯示提示 |
| 相對文件連結 | `BILL-PAYMENT-CONFIRMATION.md` 於同來源專案另開預覽 |
| 重新整理 | 重讀完成後可繼續搜尋、定位 |
| Ctrl+F／Escape | 實機開啟搜尋、關閉搜尋、恢復按鈕焦點通過 |

最初實機仍載入舊 renderer，包含焦點修正未生效；在會話閒置時重新載入，待歷史載入後重新完成上述驗證。最終右側保留 800px 文件預覽。截圖為實際 renderer，不是模擬畫面；本輪沒有建立像素差異基線測試。

## 實際截圖

截圖未收錄。

本輪未增加檔案選擇器、前後頁歷史或自動檔案更新；這些仍可作後續獨立改善。

# RESULTS-21:預覽分頁(增量 3b)實機驗收

- 日期:2026-09-11
- 分支:`preview`
- 規格:`docs/specs/2026-09-11-shell-regions-design.md` 增量 3 與 3b
- 計畫:`docs/superpowers/plans/2026-09-11-preview.md`

## 1. 設計前的量測

在 renderer 攔下 `onEvents` 看截圖工具的結果到底長什麼樣,live 與重開 app 後從逐字稿載入各量一次,形狀一樣:

```json
[{ "type": "text", "text": "可視範圍 799×833,網址 https://example.com/" },
 { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "iVBORw0K…(53836 字元)" } }]
```

量的時候發現原本 `ToolCall` 把結果一律 `JSON.stringify` 進 `<pre>`,展開一張截圖會看到五萬多字的 base64。

## 2. 一併做掉的:renderer 回報前先藏著瀏覽器

使用者同意 RESULTS-20 §5 的選項 2。主行程不再用對半切當初始值,renderer 回報之前瀏覽器是藏著的;
`splitBounds` 與它的測試沒有人用了,一起拿掉。實機:收起狀態開 app,瀏覽器從頭到尾沒出現;
展開狀態開 app,視窗出現後 398ms 才出現(renderer 回報的時間點)。

## 3. 自動測試

| 項目 | 結果 |
|---|---|
| `npm run typecheck` | 0 error |
| `npx vitest run` | 85 檔、1721 測試全過 |
| `npm run build` | 成功 |

## 4. 實機驗收

| # | 做什麼 | 應該看到 | 實際 |
|---|---|---|---|
| 1 | agent `view_screenshot` 一次,展開那個 tool block | `<img>`,文字區沒有 base64 | 圖 1598×1666;文字區是「(圖片,53836 字元,已畫在上方)」✓ |
| 2 | 按「在側邊預覽開啟」 | 「截圖」分頁到前景,瀏覽器藏起來 | 分頁 `瀏覽器 / 截圖*`,預覽圖 1598×1666,瀏覽器 `visible: false` ✓ |
| 3 | 點回「瀏覽器」 | 瀏覽器出現,bounds 等於 `.panel-body` | `visible: true`,`801,38,799,833` 兩邊相等 ✓ |
| 4 | agent 用 Write 寫 `preview-test.md`,按「預覽」 | 分頁標題是檔名,內容排好版 | 分頁 `preview-test.md*`,h1「預覽驗收」,瀏覽器 `visible: false` ✓ |
| 5 | 同一顆「預覽」再按一次 | 不多開 | 仍是三個分頁 ✓ |
| 6 | 右側收起時按「預覽」 | 自動展開,預覽在前景 | 按鈕從「展開右側」變回「收起右側」,`preview-test.md*` ✓ |
| 7 | 從 renderer 直接呼叫 `readPreview`(依序送) | 專案外都拒絕 | `/etc/hosts.md` 找不到檔案;`leak.md`(指向 `/etc/hosts` 的符號連結)不在專案資料夾內;`../../../../etc/passwd.md` 找不到檔案;`preview-test.md` 正常讀到 ✓ |

第 7 項第一次是四個請求平行送,後兩個被同時讀取上限(2)擋下,回「同時開啟的預覽太多,請稍後再試」,
等於順便驗到上限有作用。預覽介面同時只讀前景那一個,正常使用碰不到這個上限。

## 5. 實作與審查中修掉的問題

- **副檔名對照表會把 `constructor` 當成圖片**(codex 抓到,是計畫的缺陷):用普通物件查表,
  繼承來的鍵也查得到。改用 `Object.hasOwn`。
- **`..notes.md` 這種合法檔名被當成跳出專案**:原本比對 `rel.startsWith('..')`,改成比對 `..` 整段。
- **名字是 `pic.png` 的符號連結指向 Markdown**:原本只看使用者給的路徑決定類型,會用圖片的 20 MiB 上限讀進來。
  現在 realpath 之後的實際檔案也要是同一類。
- **連續要大圖沒有上限**(審查建議):每次都整個讀進記憶體再轉 base64,加上同時讀取上限 2,超過直接拒絕不排隊。
- **讀檔 handler 沒檢查呼叫方**(審查建議):加上 `event.sender` 必須是左邊的 renderer。

- **Edit 還在等批准就出現「預覽」**(Task 4 審查,判品質不通過):參數串流完 `file_path` 就有了,但檔案還沒改,
  按下去看到舊內容;之後 Edit 完成再按,因為同一個檔案只切過去,看到的還是舊的。改成兩件事:
  「預覽」只在工具狀態是 `done` 時才畫;已開著的檔案再按一次「預覽」會加一個 revision、重新讀取。
  實機:Edit 等批准時那張卡片沒有「預覽」;改完按「預覽」看到「已經改過了」;
  再從外面把檔案改成「第三版」、再按一次,分頁沒有多開,內容換成第三版。
- **收合右側或切專案時所有工具卡片都重畫**(同一份審查順帶指出):`PreviewContext` 的值依賴收起狀態與 active 專案,
  一換參考,memo 擋不住 context,所有掛著的 ToolCall 都重畫。改成從 ref 讀當下的值,函式參考固定。

## 6. 審查提出但沒有採納的

**預覽分頁切走再切回會重讀檔案。** Task 3 審查因此判品質不通過。沒有採納:agent 常在預覽開著時改同一份
Markdown,切回來重讀才看得到新內容,快取會顯示舊版;重讀只發生在人手動切分頁時。

**檢查到讀取之間不是原子操作。** 要本機已經有別的程式在替換檔案才會發生,那時它本來就讀得到這些檔案。

## 7. 最終審查後的修正

**阻斷性:左窗格沒有擋導航。** 這個缺口 main 上就有,但預覽 Markdown 把能觸發它的內容從「模型輸出」擴大到
「專案裡任何人寫的 Markdown」。實機重現:在左窗格點一個 `https://example.com/` 連結,renderer 從 `file:///…`
被導到 `https://example.com/`,而 preload 在同一個 webContents 的每次導航都會重新注入,那個外部頁面拿到的
`window.yeschef` 有 28 個方法,包括送訊息給 agent、回覆批准、連本機終端機、讀專案檔案;
`preview:read` 的來源檢查也因此失效,因為外部頁面就在同一個 webContents 裡。

修法在 `src/main/renderer-guard.ts`:左窗格的 `will-navigate` 一律擋下,`setWindowOpenHandler` 一律拒絕;
`http`、`https` 交給系統瀏覽器開,其他 scheme 不開並記錯誤。修完重測(先把 `shell.openExternal` 換成只記錄,
避免真的開瀏覽器):點 https 連結、點 `file:///etc/passwd` 連結、呼叫 `window.open`,renderer 的網址都沒變;
兩個 https 網址交給系統瀏覽器,`file://` 被擋下。

**非阻斷,但一起修:沒檢查是不是一般檔案。** agent 用 `mkfifo` 在專案裡做一個 `x.md`,`readFile` 會永遠卡住,
每次佔一個同時讀取的名額,兩次之後預覽永久失效。改成讀之前用 `stat`(不會卡在管道上)擋掉非一般檔案。
實機:具名管道 1ms 內回「不是一般檔案」,之後讀一般檔案正常。

## 8. 審查提出、留待之後的

- ~~codex 對話的截圖可能還是印出 base64~~ 已處理(2026-09-11,見 §9)。
- **預覽 Markdown 裡的遠端圖片會直接發請求**(可以用來知道有人開過這份檔案)。
  2026-09-11 使用者決定全放,維持現狀:README 的徽章、網路上的截圖等要能直接顯示,
  被追蹤「有人開過」的代價可以接受。這條只管左窗格畫 Markdown 時的 `![](https://…)`,
  不影響右邊的瀏覽器、Markdown 裡的連結(交給系統瀏覽器)、agent 的網路存取。
- ~~相對路徑的圖片顯示不出來~~ 已處理(2026-09-11,見 §10)。
- **同時讀取上限的錯誤畫面沒有重試按鈕。** 對大圖快速連按「預覽」可能碰到。
- 相對路徑以專案根目錄解析,不是那段對話的 cwd;切專案後舊專案的預覽分頁留著;
  `App` 上只給測試用的 `slot` prop;`.panel-tabs` 樣式定義兩次。

## 9. codex 那條路的量測與修正

在 codex 對話裡請它用 `view_navigate` 與 `view_screenshot`,它回答「沒有」:codex 對話沒有 yeschef 的 view 工具,
所以 view 截圖這條路在 codex 不存在。這台機器的 `~/.codex/config.toml` 也沒有設定任何 MCP 伺服器。

但路徑是存在的。用 `codex app-server generate-json-schema` 產生協定 schema 查過:`McpToolCallResult` 是
`{ content: [...], structuredContent }`,`content` 的項目沒有定義型別,原樣轉傳 MCP 的內容區塊;
MCP 規格的圖片是 `{ type: 'image', data, mimeType }`。codex 只要接上任何會回圖片的 MCP 伺服器,
原本的 `extractImages` 兩層都認不出來(外面多一層 `content`、圖片沒有 `source`),會印出整段 base64。
`extractImages` 與 `redactImages` 改成兩種形狀都認,`redactImages` 保留外層物件的其他欄位。
這一段只有單元測試,沒有實機:沒有會回圖片的 MCP 伺服器可以接。

量的時候另外看到:codex 對話的回覆標示寫的是「Claude」(`Turn.tsx` 寫死 `assistant: 'Claude'`)。
改成依 provider 給標示;實機 codex 對話顯示「你 / codex」,Claude 對話仍是「你 / Claude」。

## 10. 預覽 Markdown 裡的相對路徑圖片

計畫 `docs/superpowers/plans/2026-09-11-md-relative-images.md`。`Markdown` 加選填的 `renderImage`,只有預覽分頁傳;
相對路徑以 Markdown 檔所在目錄為基準合併,經 `preview:read` 讀,主行程的四道檢查照舊。
renderer 端讀檔一律排隊、同時最多 2 個,跟主行程的上限一樣,正常使用不會被主行程以「太多」拒絕。
對話裡的 Markdown(沒傳 `renderImage`)行為不變。

實機:`docs/r.md` 引用九張圖,在主行程的 handler 外面包一層記錄收到的路徑。

| 圖 | 結果 |
|---|---|
| `img/n1.png`(同目錄底下) | 畫出來,主行程收到 `…/sbproj/docs/img/n1.png` |
| `../top.png`(上一層) | 畫出來,主行程收到 `…/sbproj/top.png` |
| https 遠端圖 | 照舊直接載入,92×30 |
| 六張 `img/n1…n6.png` | 全部畫出來,尺寸 35×20 到 60×20 對得上,沒有「同時開啟的預覽太多」 |
| `../../../../etc/x.png` | 「(圖片讀取失敗:找不到檔案 …)」 |

預覽那條路多放行一件事:圖片的 `src` 不過 react-markdown 預設的網址過濾,好讓內嵌的 `data:` 圖片能顯示。
放行的只有 `<img>` 的 `src`,瀏覽器不會在 `<img>` 裡執行 `javascript:` 或 SVG 裡的腳本;連結仍照舊過濾。

自動測試:87 檔、1743 測試全過,Stmts 94.04%、Branch 89.62%。

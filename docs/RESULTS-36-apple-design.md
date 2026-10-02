# UI 全面審視:跟隨 macOS 的外觀,審視與驗收

- 日期:2026-09-22
- 規格:`docs/specs/2026-09-22-apple-design-design.md`
- 審視準則:`.claude/skills/emil-design-eng/SKILL.md`
- 截圖:`.spike-out/ui/`(搬遷後 12 張)、`.spike-out/ui-before/`(搬遷前 12 張)

## 1. 設計審視

29 個 CSS(`theme.css` 加 28 個元件檔)全部搬到語意 token 之後,對照兩種外觀各 6 張截圖做了一輪審視。
`tests/theme-rules.test.ts` 的「已搬遷的元件 CSS」那組移除了 `MIGRATED` 名單,改成掃 `cssFiles()` 的全部 28 個元件檔,7 個 case 全過。

### 1.1 Before / After / Why

| Before | After | Why |
| --- | --- | --- |
| 7 處 `box-shadow: ... var(--label-4)` | 新增 `--shadow` token,淺色 `black 18%`、深色 `black 60%` | `--label-4` 在深色是白的,對話框與選單的「陰影」變成一圈白光 |
| `.skills-dialog :is(button, input, summary):focus-visible { outline-offset: 3px }` | 刪掉,交回 `theme.css` 的 `-1px` | 規格 §3.3 只有一種聚焦環;外擴 3px 的環在關閉鈕外面看起來像第二層邊框 |
| `.tab:focus-visible { outline-offset: -2px }`、`.document-preview ... 2px`、`.sidebar-resizer ... -2px`、`.translate-bar button ... currentColor 2px` | 四條全部刪掉 | 同一個 app 出現四種聚焦環偏移;`.sidebar-resizer` 沒有 tabIndex,那條規則從來沒生效過 |
| `.markdown-block a:focus-visible { outline: 2px solid currentColor; outline-offset: 3px }` | `outline: 2px solid var(--accent); outline-offset: 2px` | 連結是行內文字,貼邊的環會切到字,保留外擴但換成強調色 |
| `button:active { transform: scale(.97) }` 寫在 `@media (hover: hover)` 裡 | 移到 media query 外 | 按下的回饋跟有沒有滑鼠無關;只有 hover 需要擋觸控的假訊號 |
| `button.primary` 沒有 hover | `background-color: color-mix(in srgb, var(--accent) 86%, black)` | 主要按鈕是唯一一個滑過去沒有反應的控制項 |
| `.skills-dialog button:hover { filter: brightness(1.12) }` | 刪掉,交回 theme 的 `--bg-hover` | 淺色下對近白的按鈕 `brightness` 幾乎沒有變化,而且跟 theme 的 hover 互相抵銷 |
| `.skills-dialog button { padding: 8px 12px }` 被 theme 的 `height: 22px` 吃掉 | 加 `height: auto` | 對話框按鈕實際只有 22px,13px 的字擠在裡面;現在是 macOS 對話框的尺寸 |
| 第一列:左欄連分隔線 46px,右欄 44px | 兩欄都是 43px 加 1px 分隔線 | 同一條橫線在分隔器兩側差 2px,橫跨過去看得出一個台階 |
| 第二列:左欄 `.tab-strip` 50px,右欄 `.browser-bar` 45px | 兩欄都是 44px 加 1px 分隔線 | 同理;改完在淺色與深色的截圖裡量,兩欄的兩條線都落在同一列像素(y 190 與 y 280) |
| `.status-idle::before { background: var(--success) }` | `var(--label-3)`,點從 5px 放大到 6px | 綠色在這個 app 等於「執行中」(`Busy.css`),閒置不能借用同一個顏色 |
| 24 處要讀的字用 `--label-3` | 改成 `--label-2` | `--label-3` 對白底只有 1.9:1,計數、空狀態、工具狀態、路徑在淺色下幾乎看不見;`--label-3` 只留給佔位字、捲軸與裝飾點 |
| `.preview-markdown mark.preview-current-match { background: var(--label-2) }` | `color-mix(in srgb, var(--warning) 30%, transparent)` 加 `--warning` 外框 | 灰底把命中的字反白,跟一般命中分不出來;搜尋命中是「注意這裡」的語意 |
| `.preview-markdown mark { background: var(--bg-raised) }` | `color-mix(in srgb, var(--warning) 14%, transparent)` | 在 `--bg-content` 上 `--bg-raised` 幾乎是同一個顏色,一般命中等於沒標 |
| `.preview-status { opacity: 0.7 }` | `color: var(--label-2)` | `opacity` 會連背景一起半透明,灰度該由語意色決定 |
| `.welcome-mark { border: 1px solid var(--accent-soft); background: var(--accent-soft) }` | 拿掉 border | 邊與底同色,等於沒有邊 |
| `.provider-codex { background: var(--accent-soft); color: var(--accent) }` | `color: var(--label)` | 規格 §3.3:選取態不用強調色當文字色,強調色配強調色淡底對比不足 |
| `.approval-card:focus { outline: 1px solid var(--warning); outline-offset: 1px }` | `2px` 貼邊 | 批准卡是程式聚焦的,環的粗細與偏移跟其他控制項對齊 |
| `.project-chip`、`.tab`、`.panel-tab`、`.recents-item`、`.terminal-launch summary` 滑過沒有過場 | `transition: background-color 150ms ease-out` | 這五個是清單與分頁的選取目標,底色瞬間跳變看起來像閃爍 |
| `.sidebar-resizer:hover`、`.handoff-card__button:hover` 沒有擋觸控 | 包進 `@media (hover: hover) and (pointer: fine)`,把手補上過場 | 觸控點一下就會觸發 hover,留下沒有解除的高亮 |
| `.permissions-modes label { border-radius: var(--radius-l) }` | `var(--radius-m)` | 規格 §3.2 的 `--radius-l` 是對話框與面板的,對話框裡的選項卡是卡片 |
| `PreviewPane.css` 檔尾四條覆寫(`.document-name`、`.document-toolbar`、`:is(button, input, summary)`、`.document-notice`)與前面重複宣告 | 併回前面,一個屬性只留一次 | `font-size` 同一組選擇器宣告兩次,前面那次是死的;規格 §5 要求一種東西一個值 |
| `.document-preview ... { font-family: inherit; line-height: inherit; font-size }` 展開時少了 weight / style | 改成 `:is(button, input, summary)` 一條,補上字體與字級 | `<summary>` 不是表單控制項,weight 與 style 本來就繼承;button 與 input 由 `theme.css` 的 `font: inherit` 負責 |
| `padding` / `margin` / `gap` 有 188 個值不是 4 的倍數(5、7、9、10、11、14、18、26、30px) | 靠到 4px 的倍數,剩 28 個 | 剩下的是 18 個圖示與文字之間的 6px、9 個 1 到 2px 的內嵌線。對話底部的輸入框、待批准列、執行中列、批准串原本都是 18px 的左右邊距,現在一起是 16px |
| `.project-remove` 22px、`.panel-tab-close` 24px、`.tab-close` 22px | 三個都是 20px | 同一種「關閉」在三個地方三種尺寸,而且 22px 讓專案列比右窗格高 |
| 三種 5px 的圓點(`.turn-role::before`、`.tab::before`、`.conversation-busy::before`) | 6px,跟狀態列的點一致 | 5px 在 2x 螢幕上是 10 個實體像素,6px 才跟 `--text-xs` 的字高對得上 |
| `.panel-divider:hover` 沒有擋觸控 | `:hover` 移進 `@media (hover: hover) and (pointer: fine)`,`:active` 與 `:focus-visible` 維持不分裝置 | 跟 `.sidebar-resizer` 同一種把手,處理方式要一樣;觸控點一下會留下沒有解除的強調色 |
| `.approval-card__hint`、`.term-starting`、`.compact-boundary`、`.compact-summary-toggle` 還在 `--label-3` | 一律 `--label-2` | 這四處都是要讀的字,漏在上一輪的清單外;`--label-3` 現在只剩佔位字、捲軸、圖示與三個裝飾圓點 |
| `DevelopmentDiff.css` 的註解寫「行號用 `--label-3` 淡出」,規則已經是 `--label-2` | 註解改成 `--label-2` | 註解與規則不一致,下一個人會照註解改回去 |
| `.project-remove { color: var(--label-3) }` | `--label-2` | `.tab-close` 與 `.panel-tab-close` 已經是 `--label-2`,同一種「關閉」不該有兩種灰 |
| `.browser-bar` 的 45px 是按鈕高度加內距算出來的 | 加 `min-height: 45px` 與一行註解說明要跟 `.tab-strip` 同高 | 左右兩欄對齊要寫成明確的約束;不然改了按鈕高度就會悄悄破壞對齊 |

### 1.2 殼

專案列與右窗格的分頁列現在同高。兩條分隔線在淺色截圖裡量到都落在同一列像素,第二列(對話分頁條與網址列)也是。
關閉鈕統一成 20px,專案膠囊的內距回到 `4px 4px 4px 8px`,加號維持 `--text-xl`,28px 的虛線框沒有動。
側欄的計數、空狀態與最近清單的路徑時間從 `--label-3` 升到 `--label-2`。用 token 的值算,淺色下對白底從 1.9:1 變成 3.9:1;從截圖量的數字由 Task 8 補上。
狀態列的閒置點換成灰色,綠色在這個 app 從此只代表執行中。

### 1.3 對話

使用者訊息、工具卡、批准卡的層次沒有動,三者都只有底色加邊框,沒有人同時用到陰影。
工具狀態、章節標題、成本、歡迎頁的說明字升到 `--label-2`。
底部四個元素(輸入框、待批准列、執行中列、批准串)原本是 18px 的左右邊距,現在一起是 16px,對齊同一條線。
`.provider-codex` 的文字從強調色換成 `--label`,避免強調色字疊在強調色淡底上。

### 1.4 右窗格

搜尋命中改用 `--warning`:一般命中 14%,目前命中 30% 加一圈實線。深色與淺色都看得到,而且跟批准的橙色是同一套語意。
diff 的行號從 `--label-3` 升到 `--label-2`,新增與刪除的 12% 淡底沒有動。
`PreviewPane.css` 檔尾那組後補的覆寫併回原處,`font-size` 不再宣告兩次。
分隔器的把手補上 150ms 的過場,滑過與拖曳中的提示都走 `--accent`。

### 1.5 對話框

四個對話框共用的陰影換成 `--shadow`,深色下的白光沒有了,遮罩變暗的層次才讀得出來。
按鈕拿回自己的高度,`padding: 8px 12px` 不再被 22px 吃掉;hover 交回 theme 的 `--bg-hover`,`:active` 的縮放不再宣告兩次。
關閉鈕的聚焦環貼邊,跟其他控制項同一種。授權對話框的選項卡從 `--radius-l` 降到 `--radius-m`,並補上邊框與底色的過場。

### 1.6 搬遷前後的對照

搬遷前的 12 張截圖幾乎是單色的:待批准、執行中、錯誤都是同一種灰。搬遷後待批准是橙色、完成是綠色、錯誤是紅色,狀態列的「1 個待批准」也跟著變橙。
逐張比對,沒有找到搬遷前有意義、搬遷後消失的記號。唯一一個語意上的倒退是閒置點借用了綠色,這一輪已經改掉。

### 1.7 改動的檔案

`src/renderer/theme.css` 與 28 個元件 CSS:`App.css`、`ApprovalCard.css`、`BrowserBar.css`、`Busy.css`、`ChefManager.css`、`Conversation.css`、`DevelopmentDiff.css`、`HandoffCard.css`、`LeftPane.css`、`Markdown.css`、`PanelGroup.css`、`PeerQuestion.css`、`PendingStrip.css`、`PermissionManager.css`、`PreviewPane.css`、`ProjectBar.css`、`Recents.css`、`Sidebar.css`、`SkillsManager.css`、`StatusBar.css`、`NewConversationForm.css`、`PanelDivider.css`、`Terminal.css`、`CompactBoundary.css`、`CompactSummary.css`、`TestMachinesManager.css`、`TranslateBar.css`、`WorkspaceHistory.css`。
沒有動 className、DOM 結構與元件測試,只動 `tests/theme-rules.test.ts` 的掃描範圍。28 個元件 CSS 這一輪都有改到。

## 2. 實機驗收

這個 Task 不能操作 Electron 的 GUI,也不能改這台機器的系統外觀與強調色。規格 §6.3 的五項裡,第 4 項(對比)改用 §3 的量測結果替代,其餘四項留給使用者在真的 app(`npm run dev`)裡驗收。

| # | 項目 | 驗收程序 | 通過標準 | 結果 |
|---|---|---|---|---|
| 1 | 外觀跟隨系統 | 系統偏好設定 > 外觀,切換淺色與深色,不重啟 app | UI 立刻跟著換,不用重開 app | 未驗收 |
| 2 | 強調色跟隨系統 | 系統偏好設定 > 一般 > 外觀,換成黃色或綠色這種淺色的強調色(不要用藍色,藍色測不出 `--accent-text` 在淺色強調色上的對比問題),回 app 看分頁的選取底色與對話框裡的主要按鈕 | 選取態與主要按鈕的底色一起換成新的強調色,不用重開 app,主要按鈕上的文字仍讀得清楚 | 未驗收 |
| 3 | 側欄材質 | 開真的 app,把別的視窗放在 yeschef 後面,看側欄背景 | 側欄背景透出後面內容的模糊材質,不是純色 | 未驗收 |
| 4 | 對比 | `npm run spike:contrast`,從截圖量(見 §3) | `--label` 對 `--bg-content` 至少 4.5:1,`--label-2` 對它的背景至少 3:1,兩種外觀都要過 | 通過,見 §3 |
| 5 | 減少動態效果 | 系統偏好設定 > 輔助使用 > 顯示器,開「減少動態效果」,回 app 按按鈕、觸發待批准卡片 | 按下按鈕沒有縮放,待批准卡片與記號的變化是瞬間的,沒有 150 到 200ms 的過場 | 未驗收 |
| 6 | 卡片框線與標題說明 | 查看對話卡片、管理視窗與空白對話截圖 | 卡片四邊為 1px;交接卡使用中性底色;管理視窗沒有 YESCHEF 小標籤;測試機與空白對話的說明保留專案資訊 | 未驗收 |

第 3 項的退回判定:`vibrancy` 開著、`.workbench` 也已經是透明的,側欄畫面卻還是扁平色,三個條件同時成立才算材質沒生效。真的驗收不過的話:把 `src/main/index.ts` 的 `BaseWindow` 建構參數拿掉 `vibrancy: 'sidebar'`,並把 `App.css` 開頭 `html`、`body`、`.app`、`.workbench` 四處的透明背景改回 `var(--bg-window)`。

## 3. 對比與量測

量測用 `spikes/contrast.ts`(`npm run spike:contrast`,跑法是 `node --experimental-strip-types spikes/contrast.ts`,先跑一次 `npm run spike:screenshots` 重新產生截圖)。腳本兩部分都做:

- 算的:讀 `theme.css` 的 `:root` 與深色區塊,套 WCAG 2.1 的相對亮度公式,rgba 的文字色先用 alpha 合成到背景上再算對比。
- 量的:讀 `.spike-out/ui/` 底下的截圖,PNG 解碼是腳本自己寫的一小段(`node_modules` 沒有 pngjs、sharp、jimp,不加新依賴),用 `node:zlib` 的 `inflateSync` 展開 `IDAT`,再照 PNG 規格還原每一列的濾波。畫面上挑四個位置各取一塊小區域:背景區取平均色,文字區在區域裡挑跟背景亮度差最大的像素當墨色,不用對準某一筆畫的座標,也不怕抗鋸齒的邊緣像素把顏色量偏。

四個位置:

1. 對話區 assistant 回覆的本文(`--label` 對 `--bg-content`)。
2. 側欄「歷史對話」標題(`--label-2`)。側欄現在整條透空(材質區),截圖 spike 沒開 `vibrancy`,量到的背景是 BaseWindow 的視窗底色(淺色 rgb(255,255,255)、深色 rgb(18,18,18)),不是 `--bg-window` 也不是 `--bg-content`;算的那欄仍照規格用 `--label-2` 對 `--bg-content`。
3. 使用者訊息泡泡本文(`--label` 對 `--bg-raised`)。規格沒有替這組訂門檻,列出來對照。
4. 測試機對話框「儲存」主要按鈕(`--accent-text` 對 `--accent`)。main-short 截圖裡唯一的主要按鈕「送出」在這份 fixture 底下一直卡著一個待批准的工具、永遠是 disabled 狀態,量到的是 `opacity: .4` 洗淡後的顏色,不是按鈕本色,所以換成測試機對話框裡一直是 enabled 的「儲存」按鈕。

| Token 組 | 外觀 | 算的比值 | 量的比值 | 門檻 | 結果 |
|---|---|---|---|---|---|
| `--label` / `--bg-content` | 淺色 | 15.08:1 | 15.13:1 | 4.5:1 | 通過 |
| `--label` / `--bg-content` | 深色 | 12.99:1 | 13.07:1 | 4.5:1 | 通過 |
| `--label-2` / `--bg-content` | 淺色 | 3.98:1 | 4.00:1 | 3:1 | 通過 |
| `--label-2` / `--bg-content` | 深色 | 6.08:1 | 6.18:1 | 3:1 | 通過 |
| `--label` / `--bg-raised` | 淺色 | 14.2:1 | 14.18:1 | 沒有門檻 | 對照用 |
| `--label` / `--bg-raised` | 深色 | 10.78:1 | 10.77:1 | 沒有門檻 | 對照用 |
| `--accent-text` / 系統藍 rgb(0,122,255) | 淺色 | 4.02:1 | 4.27:1 | 沒有門檻 | 對照用 |
| `--accent-text` / 系統藍 rgb(0,122,255) | 深色 | 4.02:1 | 4.27:1 | 沒有門檻 | 對照用 |

四組裡有門檻的兩組(`--label`、`--label-2`)兩種外觀都通過,`theme.css` 不用改值。`--label-2` 的算與量在淺色差 0.02、深色差 0.10,`--label` 的算與量在兩種外觀都差在 0.1 以內,兩種算法互相印證,結論站得住。

按鈕那組有個要記的落差:量到的按鈕底色是 `rgb(50, 115, 246)`,跟 Task 2 用 `getComputedStyle` 直接讀到的 `AccentColor` 解析值 `rgb(0, 117, 255)` 不完全一樣,紅色分量差了 50。截圖檔案內嵌了一份 ICC 色彩描述檔(`iCCP` chunk),這裡的 PNG 解碼沒有做色彩管理,是直接讀原始位元組,兩者的差可能出在這裡。這組本來就沒有門檻,只是列出來對照,不影響第 4 項的驗收結論;之後如果要精確量強調色本身,直接用 `getComputedStyle` 讀,不透過截圖像素。

## 4. 已知限制

- `.document-preview :is(button, input, summary)` 的選擇器範圍比實際需要的稍寬,Task 7 審查時列為 minor,留到之後有機會一起把選擇器改窄一點再處理。
- `.permissions-modes label` 沒有 `:active` 態,滑鼠按下去沒有立即回饋,只有 `:hover` 與 `is-selected`。
- `Terminal.tsx` 開 xterm 時自己帶一份寫死的顏色(`background: '#11150f'` 這一類),不吃 `theme.css` 的 token,終端機的顏色不會跟著淺色深色切換。這次審視的範圍是 CSS token,沒有把 xterm 的 `theme` 選項也接進來。
- 右窗格載入的網頁(`BrowserBar` 開的網址)不會跟著 app 的外觀換,那是網站自己的事,規格 §7 已經記過這是範圍外。
- `--accent-text`(`AccentColorText`)在淺色的系統強調色(黃色、綠色這一類)上讀起來夠不夠清楚,這次沒有實機驗證過。`spike:contrast` 量到的是這台機器目前的強調色(藍色),換成淺色強調色後 `AccentColorText` 解析出來的文字色與對比不確定會不會掉到門檻以下,留給 §2 項次 2 的實機驗收確認。

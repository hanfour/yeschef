# UI 全面審視:跟隨 macOS 的外觀

- 日期:2026-09-22
- 狀態:已實作,驗收見 `docs/RESULTS-36-apple-design.md`
- 依據:`docs/specs/2026-09-21-per-conversation-browser-design.md`、`docs/specs/2026-09-22-test-machines-design.md`(兩份新增的網址列、空狀態與測試機對話框一起納入這次審視)
- 設計審視的準則:`.claude/skills/emil-design-eng/SKILL.md`

## 1. 要解決什麼

renderer 的樣式現況:

- 29 個 CSS 檔、755 行。`theme.css` 定義 15 個 `--ui-*` token,但各元件另外寫死 98 種色碼,用了 116 次。
- 圓角 14 種值(2px 到 999px),字級 10 種(9px 到 28px)。沒有尺度。
- 只有深色,沒有跟隨系統外觀。字體已是 `-apple-system`,視窗已是 `hiddenInset`。

這份規格把樣式換成跟隨 macOS 的做法:語意色、跟隨系統的淺色與深色、系統強調色、固定尺度、側欄材質,
並對每個畫面區域做一輪設計審視。

## 2. 已決定的事

| 題目 | 決定 |
|---|---|
| 外觀模式 | 跟隨系統,淺色與深色都做,`prefers-color-scheme` 切換 |
| 強調色 | 跟隨 macOS 的強調色:CSS 的 `AccentColor` / `AccentColorText` 系統色關鍵字;app 不保留自己的品牌色 |
| token 命名 | 照 macOS 的語意命名(label、separator、windowBackground 這一類),現在的 `--ui-*` 全部退場,不留別名 |
| 尺度 | 圓角三檔、字級五檔,由測試擋住尺度外的值 |
| 材質 | 側欄區域用 `vibrancy: 'sidebar'`,實機驗不過就退回不透明 |
| 搬遷方式 | 先立 token,再依畫面區域逐區搬;每搬一區在兩種外觀截圖看一次 |
| 不動的東西 | React 元件的結構與行為、測試、IPC。只動 CSS 與少數為了材質加的 class |

## 3. token

`src/renderer/theme.css` 重寫。`:root` 是淺色,`@media (prefers-color-scheme: dark)` 覆寫深色。值取 macOS 的系統色,
寫成 rgb 或 rgba,不用 hex(讓禁 hex 的測試對 `theme.css` 也生效)。

### 3.1 顏色

| token | 淺色 | 深色 | 對應 macOS |
|---|---|---|---|
| `--label` | rgba(0,0,0,.85) | rgba(255,255,255,.85) | labelColor |
| `--label-2` | rgba(0,0,0,.5) | rgba(255,255,255,.55) | secondaryLabelColor |
| `--label-3` | rgba(0,0,0,.25) | rgba(255,255,255,.25) | tertiaryLabelColor |
| `--label-4` | rgba(0,0,0,.1) | rgba(255,255,255,.1) | quaternaryLabelColor |
| `--bg-window` | rgb(236,236,236) | rgb(30,30,30) | windowBackgroundColor |
| `--bg-content` | rgb(255,255,255) | rgb(24,24,24) | controlBackgroundColor / textBackgroundColor |
| `--bg-raised` | rgb(246,246,246) | rgb(42,42,42) | 卡片與按鈕面 |
| `--bg-hover` | rgba(0,0,0,.05) | rgba(255,255,255,.07) | 滑過 |
| `--separator` | rgba(0,0,0,.1) | rgba(255,255,255,.1) | separatorColor |
| `--separator-strong` | rgba(0,0,0,.2) | rgba(255,255,255,.2) | 輸入框、按鈕邊 |
| `--backdrop` | color-mix(in srgb, black 30%, transparent) | color-mix(in srgb, black 50%, transparent) | 對話框與歷史遮罩 |
| `--shadow` | color-mix(in srgb, black 18%, transparent) | color-mix(in srgb, black 60%, transparent) | 浮起面的陰影 |
| `--accent` | AccentColor | AccentColor | controlAccentColor |
| `--accent-text` | AccentColorText | AccentColorText | 強調色上的文字 |
| `--accent-soft` | color-mix(in srgb, AccentColor 18%, transparent) | 同左 | 選取列、分頁的底 |
| `--warning` | rgb(255,149,0) | rgb(255,159,10) | systemOrange |
| `--danger` | rgb(255,59,48) | rgb(255,69,58) | systemRed |
| `--info` | rgb(0,122,255) | rgb(10,132,255) | systemBlue |
| `--success` | rgb(52,199,89) | rgb(48,209,88) | systemGreen |

`--success` 接手現在綠色強調色的語意用途(執行中、已設定、diff 新增行),不再當強調色。

`--label-4` 目前沒有元件 CSS 在用:搬遷初期拿它湊陰影,審視那一輪(Task 7)全部換成上面的 `--shadow`。保留這個 token 是因為它仍對應 macOS 的 `quaternaryLabelColor`,語意還在,只是這輪沒有地方用到。

### 3.2 尺度

| token | 值 | 用途 |
|---|---|---|
| `--radius-s` | 4px | 按鈕、輸入框、分頁 |
| `--radius-m` | 8px | 卡片、工具呼叫、批准卡 |
| `--radius-l` | 12px | 對話框、面板 |
| `--text-xs` | 11px | 輔助說明、狀態列 |
| `--text-s` | 12px | 分頁、清單、次要文字 |
| `--text-m` | 13px | 主體文字、輸入框 |
| `--text-l` | 15px | 區塊標題 |
| `--text-xl` | 20px | 對話框標題 |

字體與等寬字體沿用現在的 `--ui-sans`、`--ui-mono` 的值,改名 `--font-sans`、`--font-mono`。

### 3.3 控制項的共通樣式(`theme.css` 裡的 `:where(.app, dialog)` 那一段)

- 按鈕:高 22px、`--radius-s`、`--bg-raised` 底、`--separator-strong` 邊、`--label` 字;主要按鈕(`.primary`)`--accent` 底、`--accent-text` 字;滑過 `--bg-hover`;按下 `transform: scale(.97)`;`transition: background-color 150ms ease-out, transform 100ms ease-out`。四個對話框共用的 `.skills-dialog button` 不用這個 22px:是 `height: auto`、`padding: 8px 12px`,大約 32px 高,比照 macOS sheet 與 alert 的按鈕尺寸;22px 是主畫面工具列按鈕的高度。
- 輸入框:`--bg-content` 底、`--separator-strong` 邊、`--radius-s`;聚焦 `outline: 2px solid var(--accent); outline-offset: -1px`(macOS 的聚焦環貼邊)。
- 選取(分頁、清單列):`--accent-soft` 底、`--label` 字;不用強調色當文字色。
- `::selection`:`--accent-soft`。捲軸:`scrollbar-color` 用 `--label-3`。
- 連結:`--accent`。
- `prefers-reduced-motion` 那段沿用。

## 4. 材質

`src/main/index.ts` 的 `BaseWindow` 加 `vibrancy: 'sidebar'`(macOS 才有,其他平台忽略)。renderer:

- 從 `html`、`body`、`.app` 一路到專案列(`.title-bar`)、分頁列與側欄(`LeftPane` 的分頁條、`Sidebar`)的整條祖先鏈都要透明,
  中間任何一層(例如 `.workbench`、`.main-column`)鋪了不透明底,材質就到不了側欄。第一版只寫了 `html, body, .app` 三層,
  `.workbench` 留著搬遷初期暫鋪的 `--bg-window`,整體審查才發現側欄實際上沒有材質。
- 對話內容區、輸入區、右窗格、狀態列、空狀態(`.pane-empty`、`.pane-unavailable`)各自鋪 `--bg-content` 或 `--bg-window`,
  不依賴祖先的底。判斷方式:在不開 vibrancy 的截圖 spike 裡,任何該不透明的區域若顯示成視窗預設底色,就是漏鋪。
- 原生瀏覽器 view 疊在自己的矩形上,跟材質無關。

`transparent` 的視窗在 macOS 上截圖時材質會顯示成半透明底,§7 的截圖用不透明背景色代替(spike 裡不開 vibrancy),
材質只在真的 app 裡看。

## 5. 逐區搬遷

依畫面區域分五區,每區一個實作 Task,搬完就在兩種外觀截圖。

| 區 | 檔案 | 這一區要特別看的 |
|---|---|---|
| 1 殼 | `App.css`、`ProjectBar.css`、`LeftPane.css`、`Sidebar.css`、`WorkspaceHistory.css`、`Recents.css`、`StatusBar.css` | 專案格與分頁的選取態用 `--accent-soft`;執行中與待批准記號改用 `--success` 與 `--warning`;標題列在 `hiddenInset` 下與紅綠燈的間距;閒置的狀態點是 `--label-3`,不是 `--success`(綠色在這個 app 專門代表執行中) |
| 2 對話 | `Conversation.css`、`Markdown.css`、`ApprovalCard.css`、`HandoffCard.css`、`PeerQuestion.css`、`PendingStrip.css`、`CompactBoundary.css`、`CompactSummary.css`、`Busy.css`、`TranslateBar.css`、`NewConversationForm.css`、`Terminal.css` | 使用者與 agent 的訊息如何區分(不靠強調色);程式碼區塊用 `--bg-content` 加 `--separator`;工具呼叫卡片與批准卡的層次;`Busy` 的動態 |
| 3 右窗格 | `PanelGroup.css`、`BrowserBar.css`、`PreviewPane.css`、`DevelopmentDiff.css`、`PanelDivider.css` | 網址列照 Safari 的樣子(圓角輸入框、居中省略);diff 的新增、刪除用 `--success` / `--danger` 的 soft 版;分隔線滑過時的提示;預覽搜尋命中的醒目提示用 `--warning`,一般命中 14%、目前命中 30% 加外框 |
| 4 對話框 | `SkillsManager.css`(四個對話框共用)、`PermissionManager.css`、`ChefManager.css`、`TestMachinesManager.css` | `--radius-l`、`--bg-window` 底、標題 `--text-xl`;`::backdrop` 用 `--backdrop`(淺色 30%、深色 50%);取消與主要按鈕的位置照 macOS(主要在右) |
| 5 審視 | 全部 | 用 `.claude/skills/emil-design-eng` 的 Before / After 表格對五區各做一輪,找動態效果、對齊、層次的問題,修完再截一次 |

搬遷的規則:

1. 元件 CSS 只用 token。hex、rgb 字面值、尺度外的 `border-radius` 與 `font-size` 都由 §6.1 的測試擋下。
2. 一個元件裡同一種東西(邊框、圓角、間距)只有一種值。
3. `transition` 只列明確的屬性,不用 `all`;曲線用 `ease-out`;時間 100 到 200ms。
4. 不改 className、不改 DOM 結構;需要新的 class 只能是為了材質(§4)加的。
5. 每一區搬完,現有測試全過(測試不看樣式,不該受影響)。

## 6. 測試與驗收

### 6.1 樣式規則的測試(先寫)

`tests/theme-rules.test.ts`:讀 `src/renderer` 底下所有 `.css`,斷言:

- `theme.css` 以外的檔案沒有 `#` 開頭的色碼、沒有 `rgb(` / `rgba(` / `hsl(` 字面值。
- `theme.css` 以外的檔案,`border-radius` 的值只能是三個 `--radius-*` token 或 `0` / `50%` / `999px`(圓形與膠囊)。
- `theme.css` 以外的檔案,`font-size` 的值只能是五個 `--text-*` token 或 `inherit`。
- 沒有 `transition: all`。
- `theme.css` 沒有 `#` 開頭的色碼(值用 rgb / rgba / 系統色關鍵字)。
- `theme.css` 的 `:root` 與 `prefers-color-scheme: dark` 區塊定義了同一組 token 名稱。

這條測試在 Task 1 寫好時會失敗(舊 CSS 還在),搬遷完成時全過。搬遷期間用 `it.todo` 或依區逐步放行。

### 6.2 截圖 spike

`spikes/screenshot-ui.ts`(`npm run spike:screenshots`):起 `BaseWindow` 載入 `out/renderer/index.html`,不開 vibrancy,
用假的 `window.yeschef`(沿用 `tests/helpers/fake-yeschef.ts` 的做法,注入固定的專案、對話、分頁與工具呼叫資料),
`nativeTheme.themeSource` 各設 `light` 與 `dark`,對主畫面與四個對話框各截一張(1440×1300 的視窗,塞得下使用者訊息、Markdown 回覆與一張展開的工具卡片同時可見),另外再對主畫面多截一組固定 1440×900 的版本(檔名加 `-short`,給後面審視版面用),兩種外觀各 6 張、合計 12 張,存到 `.spike-out/ui/<theme>-<name>.png`。
每搬完一區跑一次,截圖由做設計審視的人(或 agent)看。

### 6.3 實機驗收

1. 系統外觀切換時 app 跟著換,不需重啟。
2. 系統強調色換成另一種顏色,app 的選取態與主要按鈕跟著換。
3. 側欄有材質(視窗後面的東西透出來);沒有的話退回不透明,並在 RESULTS 記下原因。
4. 兩種外觀下,文字與背景的對比:`--label` 對 `--bg-content` 至少 4.5:1,`--label-2` 至少 3:1(用截圖量)。
5. 減少動態效果開啟時,按鈕與記號沒有動畫。

## 7. 風險

- `AccentColor` 系統色關鍵字在 Electron 44 的 Chromium 版本可以用:Task 2 的截圖 spike 量到它解析成 `rgb(0, 117, 255)`(這台機器的系統強調色),不用退回 `--info`。
- vibrancy 與 `WebContentsView` 疊圖的組合沒有實測過,§4 已定退路。
- 右窗格載入的網頁不會跟隨 app 的外觀,那是網站自己的事,不在範圍內。

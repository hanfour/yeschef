# RESULTS-19:側邊欄容器實機驗收

- 日期:2026-09-11
- 分支:`sidebar`
- 規格:`docs/specs/2026-09-11-shell-regions-design.md` 增量 2
- 計畫:`docs/superpowers/plans/2026-09-11-sidebar-container.md`

## 1. 自動測試

| 項目 | 結果 |
|---|---|
| `npm run typecheck` | 0 error |
| `npx vitest run` | 79 檔、1649 測試全過 |
| `npm run test:coverage` | Stmts 93.69%、Branch 89.05% |
| `npm run build` | 成功 |

## 2. 實機驗收

| # | 做什麼 | 應該看到 | 實際 |
|---|---|---|---|
| 1 | 開一個 codex 對話 | 側邊欄不是消失,而是有一句說明 | 可見側邊欄 1 個,內容是「codex 的歷史清單還沒做」,把手也在 ✓ |
| 2 | 拖側邊欄右緣 | 寬度跟著滑鼠變,超出範圍會停在 180 / 520 | 縮 100 → 300px、再拉 60 → 360px、拉 500 → 520px、縮 999 → 180px ✓ |
| 3 | 關掉 app 再開 | 寬度還是上次那個值 | 上次停在 400,重開後 `getComputedStyle` 量到 400px ✓ |

## 3. 驗收時發現並修掉的兩個問題

**拖曳完全沒有作用。** `useSidebarWidth` 把 `--sidebar-width` 設在 `document.documentElement` 的
inline style 上,但這個變數的預設值原本定義在 `App.css` 的 `.app` 上。`.app` 離 `.sidebar` 更近,
整個蓋掉 inline 的值:CSS 變數與 localStorage 都變成 400,畫面卻仍是 280。
單元測試只驗變數有沒有被設,驗不到它有沒有生效,所以測試全綠但功能是壞的。
修法是把預設值移到 `:root`,並加兩條測試直接讀 `App.css` 鎖住:預設值要跟 `SIDEBAR_DEFAULT` 同一個數字、
而且必須定義在 `:root` 不能在 `.app`。

**兩個側邊欄同時掛著時寬度會跳。** 每個對話分頁各有一個 `Sidebar`,原本各自持有一份 React state。
在 A 拖寬到 400 之後切到 B 再拖,B 用它自己記得的 280 當起點,寬度先跳回去再跟著滑鼠走。
修法是 hook 不再持有 state:寬度的真相只有 localStorage 一份,畫面靠 CSS 變數生效,兩者都不需要重繪。
新增測試「在第一個拖曳後,第二個拖曳的起點要接續目前寬度」鎖住。

## 4. 一併補掉的介面債務

Task 1 的審查指出 `Sidebar` 的介面太鬆:`children ?? hint` 只擋 nullish,呼叫端若寫
`cond && <X/>`,傳進來的 `false` 不是 nullish,會畫出一個沒有內容也沒有說明的空側邊欄,而且不報錯。
改成 `Children.toArray(children).length === 0`(`toArray` 會剔掉 null、undefined 與布林,`count` 不會),
`hint` 也從選填改必填。

## 5. Task 2 審查指出的洩漏路徑

審查判品質不通過,理由是拖曳的收尾漏了一條真的會發生的路徑:實作把 `pointermove` 掛在
`window` 上、`pointerup` 用 `{ once: true }`,但沒有 `setPointerCapture` 也沒有接 `pointercancel`。
把滑鼠拖出 Electron 視窗外再放開,`pointerup` 不會進到這個 renderer,`pointermove` 就永久留著,
之後滑鼠在畫面任何地方移動都會改寬度。系統中斷指標時只發 `pointercancel`,同樣收不到。

改成 pointer capture:按下時 `setPointerCapture(e.pointerId)`,`pointermove`、`pointerup`、
`pointercancel` 全部掛在把手元素上。capture 之後這個 pointer 的事件一律送到把手,拖出視窗外也收得到;
事件掛在元素上,React 卸載時自己清掉,那段 `useEffect` 的 cleanup 也不需要了。
新增一條 `pointercancel` 的測試,並把「拖曳中卸載」那條改成卸載後對把手與 window 都發事件,
兩邊都不該再寫入。

審查另一條:把手用負 margin 往左右各滲 3px,加上 `z-index: 1`,會蓋住側邊欄最右邊 3px,
那裡是 Recents 的捲軸。改成 `margin-right: -6px`,把手整個落在對話區那一側,不碰捲軸。

實機重驗:右拖 150 → 180px 變 330px,放開後再移動滑鼠寬度不再變。

## 6. 最終審查後的收尾

阻斷性問題一個:`node_modules` 的符號連結被 commit 進版控。`.gitignore` 原本寫 `node_modules/`,
帶斜線只擋目錄,擋不住同名的 symlink。已 `git rm --cached` 並把那行改成 `node_modules`。
這跟側邊欄無關,是我建 worktree 時為了共用套件建的連結誤入。

另外採納四條建議:

- **拿掉 CSS 裡所有 `--sidebar-width` 的選擇器定義**,改成 `var(--sidebar-width, 280px)` 的 fallback。
  fallback 只在變數完全沒定義時生效,不可能蓋掉繼承下來的 inline 值,第 3 節那類 cascade 衝突整類消失。
  原本那兩條讀 `App.css` 的測試只禁 `.app`,換成掃過 `src/renderer/**/*.css`、
  禁止任何選擇器定義這個變數;實際加一行單行寫法與一行多行寫法測過,兩種都抓得到。
- **`useEffect` 改 `useLayoutEffect`,而且已經有值就不覆寫**。effect 在 paint 之後才跑,
  第一幀會先閃一下預設寬度;「已經有值就不覆寫」則是為了 localStorage 存不進去時
  (隱私模式、配額滿),這次拖出來的寬度不會被後面掛載的側邊欄蓋回 280。
- **拖曳中只改畫面,放開才存檔**。原本每次 `pointermove` 都同步寫一次 localStorage,
  一秒上百次,那是這條路徑上唯一的同步 I/O。hook 拆成 `previewWidth` 與 `commitWidth`。
- **把手補上鍵盤操作與按鍵過濾**。原本掛了 `role="separator"` 與 `aria-orientation`,
  卻不能聚焦也沒有 `aria-value*`,輔助技術讀到一個宣稱可調整、實際上沒有任何操作方式的東西。
  補 `tabIndex`、方向鍵(Shift 一次 64px)與三個 `aria-value*`;右鍵與中鍵按在把手上不再進入拖曳。
  `user-select: none` 與 `touch-action: none` 一起加上,拖曳時不會順便把對話區的文字反白。

實機重驗:拖曳中畫面 330→430px 而 localStorage 仍是 330,放開後才變 430,按一次方向鍵變 446px。

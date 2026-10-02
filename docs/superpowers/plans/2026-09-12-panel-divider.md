# 主分頁區與左欄之間的分隔條 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 左欄與主分頁區之間可以拖曳調整寬度,寬度記住,重開還在。

**Architecture:** 分隔條放在 renderer 的 `.workbench` 裡、`.main-column` 與 `.panel-group` 之間。真實滑鼠越過分界會進到右邊那個原生瀏覽器 view,renderer 收不到後續事件(2026-09-12 spike,`spike-divider`);但 renderer 本來就佔滿整個視窗,所以拖曳期間把瀏覽器藏起來(`useReportBounds` 回報 null 的既有路),游標底下就只有 renderer,pointer capture 正常運作;放開再回報矩形。主分頁區寬度用 CSS 變數 `--panel-width`,存 localStorage,做法完全比照 `useSidebarWidth` 與 `Sidebar` 的把手(pointer capture、preview/commit 拆開、鍵盤、`aria-value*`)。

**Spec:** `docs/specs/2026-09-11-shell-regions-design.md` 增量 3a 的「3a 不做寬度拖曳」那段,這份計畫把它做掉;spike 結論寫在該段底下。

## Global Constraints

- TypeScript strict,`noUncheckedIndexedAccess`;無 `any`/`!`;不可就地修改;繁體中文註解說明為什麼。
- commit `<type>: <描述>`,繁體中文,不加 trailer。測試不用 jest-dom。Stmts ≥ 93、Branch ≥ 86。
- localStorage key 固定 `yeschef.panelWidth`;下限 320、上限 `window.innerWidth - 480`(左欄至少留 480)、預設是視窗一半。
- CSS 變數 `--panel-width` 設在 `document.documentElement`,任何選擇器都不得定義它(`tests/sidebar-width.test.ts` 那條掃描測試的做法,同樣加一條給 `--panel-width`)。
- 把手 `role="separator"`、`aria-label="調整主分頁區寬度"`、`aria-valuemin/max/now`、`tabIndex=0`、方向鍵 16px、Shift 64px、`user-select: none; touch-action: none`、只認主指標左鍵。
- 拖曳期間瀏覽器一定藏著:`pointerdown` 到 `pointerup`/`pointercancel` 之間 `useReportBounds` 的 `active` 為 false。

---

### Task 1: 分隔條與寬度

**Files:**
- Create: `src/renderer/hooks/usePanelWidth.ts`(比照 `useSidebarWidth.ts`:`readWidth`、`writeWidth`、`clampWidth`、`previewWidth`、`commitWidth`,常數 `PANEL_WIDTH_KEY`、`PANEL_MIN`、`PANEL_LEFT_MIN = 480`,`clampWidth(px, innerWidth)` 上限依視窗寬)
- Create: `src/renderer/components/PanelDivider.tsx`、`PanelDivider.css`(比照 `Sidebar.tsx` 的把手那段;多一個 prop `onDragging(dragging: boolean): void`,按下時 `true`、收尾 `false`)
- Modify: `src/renderer/App.tsx`(`.workbench` 裡 `.main-column` 與 `PanelGroup` 之間放 `<PanelDivider>`;`dragging` state 傳給 `PanelGroup`)
- Modify: `src/renderer/components/PanelGroup.tsx`(加 prop `dragging: boolean`,`useReportBounds(body, !collapsed && !dragging && activeId === BROWSER_TAB_ID, …)`)
- Modify: `src/renderer/App.css`、`PanelGroup.css`(`.panel-group { flex: 0 0 var(--panel-width, 50%) }`,`.main-column` 仍 `flex: 1 1 0`;收起時 `.panel-group[hidden]` 照舊)
- Test: `tests/panel-width.test.ts`、`tests/panel-divider.test.tsx`、`tests/panel-group.test.tsx`(加 `dragging` 那條)、`tests/app.test.tsx`(加:拖曳中 `setBrowserBounds:null`,放開後回報矩形)、`tests/sidebar-width.test.ts`(掃描測試擴成兩個變數)

- [ ] Step 1:寫失敗測試。`panel-width`:預設、讀寫、夾上下限(上限依 `innerWidth`)、壞值。`panel-divider`:拖曳中只改 CSS 變數、放開才存;`onDragging` 在按下與放開各呼叫一次、`pointercancel` 也收尾;右鍵不進入;方向鍵。`panel-group`:`dragging=true` 時回報 null。`app`:按下分隔條 → `fake.calls` 最後一筆是 `setBrowserBounds:null`;放開 → 最後一筆是矩形。
- [ ] Step 2:確認失敗。
- [ ] Step 3:實作。`PanelDivider` 與 `Sidebar` 的把手邏輯若能抽成共用 hook(`useDragResize`)就抽,`Sidebar` 改用它且既有 `tests/sidebar.test.tsx` 一條不改仍要過;抽不乾淨就複製一份並在註解說明。
- [ ] Step 4:`npm run typecheck`、`npx vitest run`、`npm run test:coverage`、`npm run build` 全過。
- [ ] Step 5:`git commit -m "feat: 左欄與主分頁區之間可以拖曳調整寬度"`

## 驗收(我用真滑鼠與 cliclick 做)

| # | 做什麼 | 應該看到 |
|---|---|---|
| 1 | 用 cliclick 按住分隔條往右拖 200px 放開 | 主分頁區變窄 200px;瀏覽器在拖曳期間 `visible` 為 false,放開後回到新位置且 bounds 等於新的 `.panel-body` |
| 2 | 往左拖到超過上限 | 停在左欄剩 480 |
| 3 | 關 app 重開 | 寬度還在 |
| 4 | 收起再展開 | 展開後是上次拖的寬度 |

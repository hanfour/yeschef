# UI 全面審視:跟隨 macOS 的外觀 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** renderer 的樣式改成跟隨 macOS:語意 token、淺色與深色跟隨系統、系統強調色、固定的圓角與字級尺度、側欄材質,並對每個畫面區域做一輪設計審視。

**Architecture:** 先重寫 `theme.css` 為語意 token 與尺度,加一條讀 CSS 檔的規則測試(禁 hex 與字面色、圓角與字級只能用 token、禁 `transition: all`),再寫一個截圖 spike(載入打包後的 renderer、注入假 API、兩種外觀各截一組 PNG)。之後依五個畫面區域逐區把 29 個 CSS 檔搬到 token 上,每區搬完跑截圖;最後用設計 skill 做 Before / After 審視。React 元件不動。

**Tech Stack:** CSS(自訂屬性、`prefers-color-scheme`、`AccentColor` 系統色、`color-mix`)、Electron 44(`nativeTheme`、`vibrancy`)、vitest、esbuild 打包的 spike。

**Spec:** `docs/specs/2026-09-22-apple-design-design.md`

## Global Constraints

- token 名稱與值照規格 §3.1、§3.2 的表,一字不差;`--ui-*` 全部退場,不留別名。
- `theme.css` 以外的 CSS 只用 token:沒有 `#` 色碼、沒有 `rgb(` / `rgba(` / `hsl(` 字面值;`border-radius` 只用 `--radius-*`、`0`、`50%`、`999px`;`font-size` 只用 `--text-*` 或 `inherit`;沒有 `transition: all`。
- `theme.css` 的值用 rgb / rgba / 系統色關鍵字 / `color-mix`,不用 hex。
- 不改 className、不改 DOM 結構;新 class 只能是為了材質(規格 §4)。
- 現有測試不得因樣式搬遷而改動(測試不看樣式)。
- `transition` 只列明確屬性、`ease-out`、100 到 200ms;`prefers-reduced-motion` 的規則沿用。
- 每區搬完:`npm test`、`npm run typecheck`、`npm run build`、`npm run spike:screenshots` 都要過,截圖要人(或審視的 agent)看過。
- 所有給人看的字串用繁體中文。commit 訊息格式 `<type>: <description>`,結尾加 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。

## File Structure

| 檔案 | 動作 | 責任 |
|---|---|---|
| `src/renderer/theme.css` | 重寫 | token、尺度、控制項共通樣式 |
| `tests/theme-rules.test.ts` | 新增 | 規格 §6.1 的規則,依 `MIGRATED` 清單逐區放行 |
| `spikes/screenshot-ui.ts`、`spikes/screenshot-preload.ts`、`spikes/fixtures/ui-fixture.ts` | 新增 | 截圖 spike 與假 API、固定資料 |
| `package.json` | 修改 | `spike:screenshots` |
| `src/main/index.ts` | 修改 | `BaseWindow` 加 `vibrancy: 'sidebar'` |
| 區 1:`App.css`、`ProjectBar.css`、`LeftPane.css`、`Sidebar.css`、`WorkspaceHistory.css`、`Recents.css`、`StatusBar.css` | 修改 | 殼 |
| 區 2:`Conversation.css`、`Markdown.css`、`ApprovalCard.css`、`HandoffCard.css`、`PeerQuestion.css`、`PendingStrip.css`、`CompactBoundary.css`、`CompactSummary.css`、`Busy.css`、`TranslateBar.css`、`NewConversationForm.css`、`Terminal.css` | 修改 | 對話 |
| 區 3:`PanelGroup.css`、`BrowserBar.css`、`PreviewPane.css`、`DevelopmentDiff.css`、`PanelDivider.css` | 修改 | 右窗格 |
| 區 4:`SkillsManager.css`、`PermissionManager.css`、`ChefManager.css`、`TestMachinesManager.css` | 修改 | 對話框 |
| `docs/RESULTS-36-apple-design.md` | 新增 | 審視表、對比量測、實機驗收 |

---

### Task 1: token、控制項共通樣式與規則測試

**Files:**
- Rewrite: `src/renderer/theme.css`
- Create: `tests/theme-rules.test.ts`

**Interfaces:**
- Produces:規格 §3.1 的 17 個顏色 token、§3.2 的 8 個尺度 token、`--font-sans`、`--font-mono`。
- Produces(`tests/theme-rules.test.ts`):`MIGRATED: readonly string[]`,列出已搬到 token 的元件 CSS 檔名;規則只對清單裡的檔案生效。Task 3 到 6 各自把自己的檔案加進去;Task 7 把清單換成「全部」。

這一步之後所有元件 CSS 還在用 `--ui-*`,畫面會壞掉(變數解析不到)。這是預期的過渡狀態,Task 3 開始逐區修;Task 1 到 Task 6 完成前不要發版。

- [ ] **Step 1: 寫規則測試**

```ts
// tests/theme-rules.test.ts
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const RENDERER = join(import.meta.dirname, '../src/renderer')
const THEME = join(RENDERER, 'theme.css')

/** 已搬到 token 的元件 CSS。Task 3 到 6 逐區加入;Task 7 改成掃全部。 */
const MIGRATED: readonly string[] = []

const RADIUS_OK = /^(var\(--radius-(s|m|l)\)|0|50%|999px)$/
const FONT_SIZE_OK = /^(var\(--text-(xs|s|m|l|xl)\)|inherit)$/

function cssFiles(): readonly { name: string; text: string }[] {
  const dirs = [RENDERER, join(RENDERER, 'components')]
  return dirs.flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith('.css') && f !== 'theme.css').map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') })))
}

/** 去掉註解,再依 `屬性: 值` 逐一切出來。 */
function declarations(text: string): readonly { prop: string; value: string }[] {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, '')
  return [...clean.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)[;}]/g)].map((m) => ({ prop: m[1]!, value: m[2]!.trim() }))
}

function migrated(): readonly { name: string; text: string }[] {
  const files = cssFiles()
  for (const name of MIGRATED) expect(files.some((f) => f.name === name), `MIGRATED 裡的 ${name} 不存在`).toBe(true)
  return files.filter((f) => MIGRATED.includes(f.name))
}

describe('theme.css', () => {
  const theme = readFileSync(THEME, 'utf8')
  it('不用 hex', () => {
    expect(theme.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })
  it(':root 與深色區塊定義同一組 token', () => {
    const blocks = [...theme.matchAll(/(:root|prefers-color-scheme:\s*dark[^{]*\{\s*:root)\s*\{([^}]*)\}/g)].map((m) => m[2]!)
    expect(blocks.length).toBeGreaterThanOrEqual(2)
    const names = blocks.map((b) => [...b.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]).sort())
    const color = names[0]!.filter((n) => !n.startsWith('--radius') && !n.startsWith('--text') && !n.startsWith('--font'))
    expect(names[1]).toEqual(color)
  })
  it('沒有 --ui- 開頭的 token', () => {
    expect(theme).not.toMatch(/--ui-/)
  })
})

describe('已搬遷的元件 CSS', () => {
  it('沒有 hex、rgb、hsl 字面值', () => {
    for (const f of migrated()) expect(f.text.replace(/\/\*[\s\S]*?\*\//g, ''), f.name).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/)
  })
  it('border-radius 只用尺度', () => {
    for (const f of migrated()) for (const d of declarations(f.text)) if (d.prop === 'border-radius') expect(d.value, `${f.name}: ${d.value}`).toMatch(RADIUS_OK)
  })
  it('font-size 只用尺度', () => {
    for (const f of migrated()) for (const d of declarations(f.text)) if (d.prop === 'font-size') expect(d.value, `${f.name}: ${d.value}`).toMatch(FONT_SIZE_OK)
  })
  it('沒有 transition: all,也沒有 --ui- token', () => {
    for (const f of migrated()) {
      expect(f.text, f.name).not.toMatch(/transition:\s*all\b/)
      expect(f.text, f.name).not.toMatch(/--ui-/)
    }
  })
})
```

Run: `npx vitest run tests/theme-rules.test.ts`
Expected: `theme.css` 的三條 FAIL(舊檔有 hex、`--ui-`、沒有深色區塊);已搬遷那四條因為 `MIGRATED` 是空的而 PASS。

- [ ] **Step 2: 重寫 `theme.css`**

```css
/* src/renderer/theme.css:跟隨 macOS 的外觀(規格 docs/specs/2026-09-22-apple-design-design.md §3)。
   :root 是淺色,底下的 media 區塊覆寫深色。值用 rgb / rgba / 系統色關鍵字,不用 hex(tests/theme-rules.test.ts)。 */
:root {
  color-scheme: light dark;
  --label: rgba(0, 0, 0, .85);
  --label-2: rgba(0, 0, 0, .5);
  --label-3: rgba(0, 0, 0, .25);
  --label-4: rgba(0, 0, 0, .1);
  --bg-window: rgb(236, 236, 236);
  --bg-content: rgb(255, 255, 255);
  --bg-raised: rgb(246, 246, 246);
  --bg-hover: rgba(0, 0, 0, .05);
  --separator: rgba(0, 0, 0, .1);
  --separator-strong: rgba(0, 0, 0, .2);
  --accent: AccentColor;
  --accent-text: AccentColorText;
  --accent-soft: color-mix(in srgb, AccentColor 18%, transparent);
  --warning: rgb(255, 149, 0);
  --danger: rgb(255, 59, 48);
  --info: rgb(0, 122, 255);
  --success: rgb(52, 199, 89);
  --radius-s: 4px;
  --radius-m: 8px;
  --radius-l: 12px;
  --text-xs: 11px;
  --text-s: 12px;
  --text-m: 13px;
  --text-l: 15px;
  --text-xl: 20px;
  --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --font-mono: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --label: rgba(255, 255, 255, .85);
    --label-2: rgba(255, 255, 255, .55);
    --label-3: rgba(255, 255, 255, .25);
    --label-4: rgba(255, 255, 255, .1);
    --bg-window: rgb(30, 30, 30);
    --bg-content: rgb(24, 24, 24);
    --bg-raised: rgb(42, 42, 42);
    --bg-hover: rgba(255, 255, 255, .07);
    --separator: rgba(255, 255, 255, .1);
    --separator-strong: rgba(255, 255, 255, .2);
    --accent: AccentColor;
    --accent-text: AccentColorText;
    --accent-soft: color-mix(in srgb, AccentColor 18%, transparent);
    --warning: rgb(255, 159, 10);
    --danger: rgb(255, 69, 58);
    --info: rgb(10, 132, 255);
    --success: rgb(48, 209, 88);
  }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
:where(.app, dialog) :is(button, input, textarea, select) { font: inherit; }
/* 規格 §3.3:按鈕 22px 高、小圓角;主要按鈕用強調色。 */
:where(.app, dialog) button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 22px; padding: 0 10px; border: 1px solid var(--separator-strong); border-radius: var(--radius-s); background: var(--bg-raised); color: var(--label); font-size: var(--text-s); line-height: 1; cursor: pointer; transition: background-color 150ms ease-out, transform 100ms ease-out; }
:where(.app, dialog) button.primary { background: var(--accent); border-color: transparent; color: var(--accent-text); }
:where(.app, dialog) button:disabled { opacity: .4; cursor: default; }
:where(.app, dialog) :is(input, textarea, select) { color: var(--label); background: var(--bg-content); border: 1px solid var(--separator-strong); border-radius: var(--radius-s); padding: 4px 8px; font-size: var(--text-m); min-width: 0; }
:where(.app, dialog) :is(input, textarea)::placeholder { color: var(--label-3); opacity: 1; }
:where(.app, dialog) input[type=checkbox] { accent-color: var(--accent); width: 14px; height: 14px; padding: 0; }
/* macOS 的聚焦環貼著控制項的邊。 */
:where(.app, dialog) :is(button, input, textarea, select, summary, [tabindex]):focus-visible { outline: 2px solid var(--accent); outline-offset: -1px; }
:where(.app, dialog) :is(code, pre, kbd) { font-family: var(--font-mono); }
:where(.app, dialog) kbd { font-size: var(--text-xs); padding: 1px 4px; border: 1px solid var(--separator-strong); border-radius: var(--radius-s); color: var(--label-2); }
:where(.app, dialog) a { color: var(--accent); text-underline-offset: 3px; }
:where(.app, dialog) ::selection { background: var(--accent-soft); }
:where(.app, dialog) * { scrollbar-width: thin; scrollbar-color: var(--label-3) transparent; }
.ui-icon { width: 16px; height: 16px; flex-shrink: 0; vertical-align: middle; }
@media (hover: hover) and (pointer: fine) {
  :where(.app, dialog) button:hover:not(:disabled):not(.primary) { background-color: var(--bg-hover); }
  :where(.app, dialog) button:active:not(:disabled) { transform: scale(.97); }
}
@media (prefers-reduced-motion: reduce) {
  :where(.app, dialog) *, :where(.app, dialog) *::before, :where(.app, dialog) *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; scroll-behavior: auto !important; }
}
```

Run: `npx vitest run tests/theme-rules.test.ts`
Expected: 全部 PASS。

- [ ] **Step 3: 確認其他測試沒有依賴舊 token**

Run: `grep -rn "\-\-ui-" tests src --include='*.ts' --include='*.tsx' | grep -v "\.css"`
Expected: 沒有輸出。有的話那是測試或 TSX 在讀 token 名稱,把它改成新名稱(值的語意對照見 Task 3 的表)。

Run: `npm test && npm run typecheck`
Expected: PASS(元件 CSS 還在用 `--ui-*`,但沒有測試看樣式)。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/theme.css tests/theme-rules.test.ts
git commit -m "feat: replace the theme with macOS semantic tokens and a style rules test"
```

---
### Task 2: 截圖 spike

**Files:**
- Create: `spikes/fixtures/ui-fixture.ts`(固定資料)、`spikes/screenshot-preload.ts`(假的 `window.yeschef`)、`spikes/screenshot-ui.ts`(主程式)
- Modify: `package.json`(`spike:screenshots`)

**Interfaces:**
- Consumes:`YesChefApi`(`src/shared/ipc.ts`,38 個方法)、`tests/helpers/fake-yeschef.ts` 裡每個方法的假回傳值(照抄回傳值,不 import 那個檔:它依賴 `@testing-library/react`,preload 載不動)
- Produces:`npm run spike:screenshots` 在 `.spike-out/ui/` 產生 `light-main.png`、`dark-main.png`、`<theme>-skills.png`、`<theme>-permissions.png`、`<theme>-chef.png`、`<theme>-test-machines.png`,共 10 張;並印一行 JSON 記 `AccentColor` 解析出來的值。

做法:`BaseWindow`(不開 vibrancy)+ 一個 `WebContentsView`,preload 是 `screenshot-preload.cjs`,載入 `out/renderer/index.html`(所以要先 `npm run build`)。preload 用 `contextBridge.exposeInMainWorld('yeschef', api)` 掛假 API;`onProjects` / `onEvents` / `onSessionState` / `onBrowserSessions` 被訂閱後立刻(`setTimeout 0`)推固定資料。主程式等 1 秒讓畫面穩定,`nativeTheme.themeSource = 'light'` 截一張、按四個對話框按鈕各截一張(按完按 Esc 關掉),再切 `dark` 重做一輪。

- [ ] **Step 1: 固定資料**

```ts
// spikes/fixtures/ui-fixture.ts
/** 截圖用的固定畫面內容:兩個專案、三個分頁、一段含 Markdown 與工具呼叫的對話、一張待批准卡、一個有瀏覽器的對話。 */
import type { ProjectsView } from '../../src/shared/projects.js'
import type { Event } from '../../src/shared/events.js'
import type { ApprovalAskPayload, SessionStatePayload } from '../../src/shared/ipc.js'
import type { BrowserSessionEntry, BrowserStatePayload } from '../../src/shared/browser-ipc.js'

export const CONVERSATION = 'fixture-conv-1'

export const PROJECTS: ProjectsView = {
  activeId: 'p1',
  projects: [
    {
      id: 'p1', name: 'yeschef', rootPath: '/Users/me/Projects/yeschef', available: true, isGitRepo: true,
      pendingApproval: true, pendingTabIds: [CONVERSATION], producingTabIds: [], busyTabIds: [CONVERSATION], busySince: { [CONVERSATION]: Date.now() - 42_000 },
      activeTabId: CONVERSATION,
      tabs: [
        { id: CONVERSATION, contentType: 'conversation', label: 'Claude 對話', customLabel: null, sortOrder: 0, lastFocusedAt: 3, threadId: 't1', provider: 'claude', lastUrl: 'https://staging.example.com/login' },
        { id: 'fixture-conv-2', contentType: 'conversation', label: '主廚 · 驗收登入頁', customLabel: '主廚 · 驗收登入頁', sortOrder: 1, lastFocusedAt: 2, threadId: 't2', provider: 'codex', chefTaskId: 'task-1' },
        { id: 'fixture-term', contentType: 'terminal', label: 'npm run dev', customLabel: null, command: 'npm run dev', sortOrder: 2, lastFocusedAt: 1 },
      ],
      threads: [
        { id: 't1', sessions: [], handoffVersion: 0, switchPhase: { kind: 'idle' }, createdAt: 0 },
        { id: 't2', sessions: [], handoffVersion: 0, switchPhase: { kind: 'idle' }, createdAt: 0 },
      ],
    },
    { id: 'p2', name: 'demo-app', rootPath: '/Users/me/Projects/demo-app', available: true, pendingApproval: false, pendingTabIds: [], producingTabIds: [], busyTabIds: [], busySince: {}, activeTabId: 'c3',
      tabs: [{ id: 'c3', contentType: 'conversation', label: 'Claude 對話', customLabel: null, sortOrder: 0, lastFocusedAt: 1, threadId: 't3', provider: 'claude' }],
      threads: [{ id: 't3', sessions: [], handoffVersion: 0, switchPhase: { kind: 'idle' }, createdAt: 0 }] },
  ],
}

export const EVENTS: readonly Event[] = [
  { kind: 'user-text', text: '幫我把登入頁的密碼欄改成有「顯示密碼」的切換,改完用 staging 驗一次。' } as Event,
  { kind: 'text', text: '好,先看現在的表單結構。\n\n```tsx\n<input id="password" type="password" />\n```\n\n我會加一個 `aria-pressed` 的切換鈕,樣式沿用既有的 token:\n\n- `--bg-raised` 當底\n- 按下時 `--accent-soft`\n\n然後用 `view_login` 驗證。' } as Event,
  { kind: 'tool-use', id: 'tu-1', name: 'mcp__yeschef__view_snapshot', input: { scope: 'viewport' } } as Event,
  { kind: 'tool-result', toolUseId: 'tu-1', content: 's1-e0 textbox "帳號"\ns1-e1 textbox "密碼"\ns1-e2 button "登入"' } as Event,
  { kind: 'tool-use', id: 'tu-2', name: 'mcp__yeschef__view_eval', input: { expression: 'document.title' } } as Event,
]

export const ASK: ApprovalAskPayload = {
  id: 'ask-1', conversationId: CONVERSATION, toolUseId: 'tu-2', toolName: 'mcp__yeschef__view_eval',
  input: { expression: 'document.title' }, reason: 'view_eval 每次都需要批准',
} as ApprovalAskPayload

export const SESSION_STATE: SessionStatePayload = { conversationId: CONVERSATION, state: { kind: 'live', busy: true } } as SessionStatePayload
export const BROWSER_STATE: BrowserStatePayload = { conversationId: CONVERSATION, url: 'https://staging.example.com/login', title: '登入', loading: false, canGoBack: true, canGoForward: false }
export const BROWSER_SESSIONS: readonly BrowserSessionEntry[] = [{ conversationId: CONVERSATION, busy: true }, { conversationId: 'fixture-conv-2', busy: false }]
```

`as Event`、`as ApprovalAskPayload`、`as SessionStatePayload` 這幾處的實際欄位以 `src/shared/events.ts`、`src/shared/ipc.ts`、`src/shared/session-state.ts` 的型別為準:先 `npm run typecheck`,缺什麼補什麼,補到不需要 `as` 為止,不要留著 `as` 遮掉型別錯誤。`tool-use` 事件若需要 `parentToolUseId` 之類的欄位照型別補。

- [ ] **Step 2: 假的 preload**

```ts
// spikes/screenshot-preload.ts
/** 截圖用的 window.yeschef:每個方法回固定值,訂閱後立刻推 ui-fixture 的資料。不碰真的 IPC。 */
import { contextBridge } from 'electron'
import type { YesChefApi } from '../src/shared/ipc.js'
import { ASK, BROWSER_SESSIONS, BROWSER_STATE, EVENTS, PROJECTS, SESSION_STATE, CONVERSATION } from './fixtures/ui-fixture.js'

const later = (fn: () => void): void => { setTimeout(fn, 0) }
const noop = (): void => {}
const unsubscribe = (): void => {}

const api: YesChefApi = {
  // 訂閱類:掛上就推一次固定資料
  onProjects: (cb) => { later(() => cb(PROJECTS)); return unsubscribe },
  onEvents: (cb) => { later(() => cb({ conversationId: CONVERSATION, events: EVENTS })); return unsubscribe },
  onSessionState: (cb) => { later(() => cb(SESSION_STATE)); return unsubscribe },
  onApprovalAsk: (cb) => { later(() => cb(ASK)); return unsubscribe },
  onApprovalSettled: () => unsubscribe,
  onPeerState: () => unsubscribe,
  onBrowserState: (cb) => { later(() => cb(BROWSER_STATE)); return unsubscribe },
  onBrowserSessions: (cb) => { later(() => cb(BROWSER_SESSIONS)); return unsubscribe },
  // 查詢類:回跟 tests/helpers/fake-yeschef.ts 一樣的空值
  getProjects: async () => PROJECTS,
  getApprovals: async () => [ASK],
  getBrowser: async () => ({ states: [BROWSER_STATE], sessions: [...BROWSER_SESSIONS] }),
  // 其餘每個方法:照 tests/helpers/fake-yeschef.ts 的回傳值抄一份,送出類的一律 noop
  // …(完整列出 YesChefApi 的 38 個方法;少一個 typecheck 會擋)
}

contextBridge.exposeInMainWorld('yeschef', api)
void noop
```

`onEvents` 的 payload 形狀(`EventsBatchPayload`)、`getProjects` 的名稱等以 `src/shared/ipc.ts` 為準。方法清單用 `grep -n "^  [a-zA-Z]*(" src/shared/ipc.ts` 列出,對照 `tests/helpers/fake-yeschef.ts` 的假實作逐一寫;`manageSkills`、`managePermissions`、`manageChef`、`manageTestMachines` 各回一個 `kind: 'state'` 的空狀態,讓四個對話框開得起來(`manageTestMachines` 回 `{ kind: 'state', revision: 1, machines: [{ id: 'm1', name: 'staging', url: 'https://staging.example.com/login', username: 'qa', hasPassword: true }] }`,截圖才有內容)。

- [ ] **Step 3: 主程式**

```ts
// spikes/screenshot-ui.ts
/** 兩種外觀各截一組 renderer 的圖(規格 §6.2)。先 npm run build。 */
import { app, BaseWindow, WebContentsView, nativeTheme } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
declare const __dirname: string

const OUT = join(__dirname, 'ui')
const RENDERER = join(__dirname, '../out/renderer/index.html')
const DIALOGS: readonly { name: string; button: string }[] = [
  { name: 'skills', button: '技能' }, { name: 'permissions', button: '授權' }, { name: 'chef', button: '主廚' }, { name: 'test-machines', button: '測試機' },
]
const wait = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms) })

async function main(): Promise<void> {
  await app.whenReady()
  mkdirSync(OUT, { recursive: true })
  const win = new BaseWindow({ width: 1440, height: 900, show: true, titleBarStyle: 'hiddenInset' })
  const view = new WebContentsView({ webPreferences: { preload: join(__dirname, 'screenshot-preload.cjs'), contextIsolation: true, sandbox: false } })
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 1440, height: 900 })
  await view.webContents.loadURL(pathToFileURL(RENDERER).href)
  await wait(1000)
  const wc = view.webContents
  const shot = async (name: string): Promise<void> => {
    const image = await wc.capturePage()
    writeFileSync(join(OUT, `${name}.png`), image.toPNG())
    console.log(JSON.stringify({ shot: `${name}.png` }))
  }
  const click = (label: string): Promise<void> => wc.executeJavaScript(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(label)})); if (!b) throw new Error('沒有按鈕 ' + ${JSON.stringify(label)}); b.click() })()`)
  const escape = (): Promise<void> => wc.executeJavaScript(`(() => { const d = document.querySelector('dialog[open]'); if (d) d.close() })()`)
  const accent = await wc.executeJavaScript(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() + ' → ' + (() => { const s = document.createElement('span'); s.style.color = 'AccentColor'; document.body.append(s); const c = getComputedStyle(s).color; s.remove(); return c })()`)
  console.log(JSON.stringify({ accent }))

  for (const theme of ['light', 'dark'] as const) {
    nativeTheme.themeSource = theme
    await wait(400)
    await shot(`${theme}-main`)
    for (const dialog of DIALOGS) {
      await click(dialog.button)
      await wait(400)
      await shot(`${theme}-${dialog.name}`)
      await escape()
      await wait(200)
    }
  }
  app.exit(0)
}

main().catch((err: unknown) => { console.error(err); app.exit(1) })
```

`package.json` 加:

```json
"spike:screenshots": "npm run build && esbuild spikes/screenshot-preload.ts --bundle --platform=node --format=cjs --external:electron --outfile=.spike-out/screenshot-preload.cjs && esbuild spikes/screenshot-ui.ts --bundle --platform=node --format=cjs --external:electron --outfile=.spike-out/screenshot-ui.cjs && electron .spike-out/screenshot-ui.cjs"
```

`.spike-out/` 在 repo 根目錄,所以 `RENDERER` 的相對路徑 `../out/renderer/index.html` 從 `.spike-out/` 算起是對的。

- [ ] **Step 4: 跑一次,存「改動前」的基準圖**

Run: `npm run typecheck && npm run spike:screenshots`
Expected: 印出 10 行 `{"shot": …}` 與一行 `{"accent": "AccentColor → rgb(…)"}`。`accent` 那行的 rgb 要等於你系統設定的強調色(預設藍是 `rgb(0, 122, 255)` 左右);不是的話 `AccentColor` 沒被支援,回報,規格 §7 的退路是 `--accent` 改成 `var(--info)`。

把 10 張圖複製到 `.spike-out/ui-before/`(Task 7 的審視要比對)。此時 `theme.css` 已是新的、元件 CSS 還是舊的,畫面會有很多變數解析不到的地方,這是預期的。

- [ ] **Step 5: Commit**

```bash
git add spikes/fixtures/ui-fixture.ts spikes/screenshot-preload.ts spikes/screenshot-ui.ts package.json
git commit -m "test: add a light/dark screenshot spike for the renderer"
```

---

### Task 3: 區 1,殼

**Files:**
- Modify: `src/renderer/App.css`、`src/renderer/components/ProjectBar.css`、`LeftPane.css`、`Sidebar.css`、`WorkspaceHistory.css`、`Recents.css`、`StatusBar.css`
- Modify: `src/main/index.ts`(`vibrancy`)
- Modify: `tests/theme-rules.test.ts`(`MIGRATED` 加這七個檔)

**Interfaces:**
- Consumes:Task 1 的 token
- Produces:材質用的 class:`.title-bar`、`.tab-strip`(分頁條的既有 class 以 `LeftPane.tsx` 為準)、`.sidebar` 背景透明

token 對照表(所有區共用):

| 舊 | 新 |
|---|---|
| `--ui-bg` | `--bg-content`(內容區、輸入框)或 `--bg-window`(視窗、面板底) |
| `--ui-surface` | `--bg-window`(殼)/ `--bg-raised`(卡片) |
| `--ui-raised` | `--bg-raised` |
| `--ui-hover` | `--bg-hover` |
| `--ui-border` | `--separator` |
| `--ui-border-strong` | `--separator-strong` |
| `--ui-text` | `--label` |
| `--ui-muted` | `--label-2` |
| `--ui-subtle` | `--label-3` |
| `--ui-accent` 當選取態或按鈕底 | `--accent-soft`(底)+ `--label`(字);主要按鈕 `--accent` + `--accent-text` |
| `--ui-accent` 當語意(執行中、成功、diff 新增) | `--success` |
| `--ui-accent` 當連結或圖示重點 | `--accent` |
| `--ui-accent-ink` | `--accent-text` |
| `--ui-warning` / `--ui-danger` / `--ui-info` | `--warning` / `--danger` / `--info` |
| `--ui-sans` / `--ui-mono` | `--font-sans` / `--font-mono` |
| 寫死的綠色系(`#bedb9d…`、`#a3c492`、`#cce8ac`、`#8aab76` 等) | 依用途:選取態 `--accent-soft`、語意 `--success`、文字 `--label-2` |
| 寫死的半透明黑(`#0002`、`#0005`、`#0006`、`#0008`、`#0009`) | 陰影用 `--label-4`;backdrop 用 `color-mix(in srgb, black 30%, transparent)` 放進 `theme.css` 的 `--backdrop`(Task 6 加) |
| 寫死的半透明白(`#ffffff08`…`#ffffff18`) | `--bg-hover` 或 `--separator` |
| 寫死的黃橙(`#e3c181…`、`#7a6a2a`、`#302513`)| `--warning`;底色用 `color-mix(in srgb, var(--warning) 12%, transparent)` |
| 寫死的紅(`#efab9b…`、`#f3b8aa`、`#e59484`)| `--danger`;底色同上 12% |
| 寫死的藍(`#a5c8d8…`、`#58a9c9`、`#2a6a7a`)| `--info`;底色同上 12% |

`color-mix()` 裡只能引用 token,不能出現 hex 或 rgb 字面值(規則測試會擋 `rgb(`;`black`、`white` 這兩個關鍵字允許)。

圓角對照:2 到 5px → `--radius-s`;6 到 9px → `--radius-m`;10 到 14px → `--radius-l`;20px、999px(膠囊)保留 `999px`;50% 保留。
字級對照:9、10、11px → `--text-xs`;12px → `--text-s`;13、14px → `--text-m`;15、16px → `--text-l`;20px 以上 → `--text-xl`。

- [ ] **Step 1: 放行這一區**

`tests/theme-rules.test.ts` 的 `MIGRATED` 改成 `['App.css', 'ProjectBar.css', 'LeftPane.css', 'Sidebar.css', 'WorkspaceHistory.css', 'Recents.css', 'StatusBar.css']`。

Run: `npx vitest run tests/theme-rules.test.ts`
Expected: FAIL,列出這七個檔裡違規的每一筆(這就是這一區的待辦清單)。

- [ ] **Step 2: 逐檔搬遷**

每個檔依對照表換掉 token、hex、圓角、字級。`App.css` 另外:

```css
html, body, #root { height: 100%; margin: 0; }
/* 規格 §4:視窗底透明,讓 vibrancy 的材質透出來;內容區自己鋪 --bg-content。 */
html, body { background: transparent; }
.app { display: flex; flex-direction: column; height: 100%; color: var(--label); background: transparent; font-family: var(--font-sans); font-size: var(--text-m); }
.title-bar { display: flex; align-items: center; gap: 12px; flex: none; min-height: 52px; padding: 8px 16px 8px 84px; border-bottom: 1px solid var(--separator); background: transparent; }
```

`.main-column`、對話內容區與右窗格的容器要鋪 `background: var(--bg-content)`(在 `Conversation.css` 與 `PanelGroup.css`,那是區 2、區 3 的檔案;這一區先在 `App.css` 對 `.workbench` 鋪 `--bg-window`,區 2、3 搬完再由它們自己鋪,避免中間狀態全透明)。

`ProjectBar.css` 與 `LeftPane.css`:專案格與分頁的選取態 `background: var(--accent-soft); color: var(--label)`;`.project-busy`、`.tab-busy` 用 `--success`;`.project-pending`、`.tab-pending` 用 `--warning`;`.tab-browser` 閒置 `--label-3`、`is-busy` `--info`(前一份計畫的寫法不變,只換 token)。分頁條與側欄容器 `background: transparent`。

`StatusBar.css`:`--text-xs`、`--label-2`、底 `--bg-window`(狀態列不透明)。

- [ ] **Step 3: 主行程開材質**

`src/main/index.ts` 的 `new BaseWindow({ … })` 加 `vibrancy: 'sidebar'`。只加這一個欄位。

- [ ] **Step 4: 驗證**

Run: `npx vitest run tests/theme-rules.test.ts && npm test && npm run typecheck && npm run spike:screenshots`
Expected: 規則測試 PASS;全套 PASS;截圖裡專案列、分頁列、側欄、狀態列在兩種外觀下都有正確的底與文字色,選取的分頁是強調色的淡底。把 `light-main.png` 與 `dark-main.png` 各看一次,在報告裡寫下看到的問題(對齊、間距、對比),不用在這一步修。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/App.css src/renderer/components/ProjectBar.css src/renderer/components/LeftPane.css src/renderer/components/Sidebar.css src/renderer/components/WorkspaceHistory.css src/renderer/components/Recents.css src/renderer/components/StatusBar.css src/main/index.ts tests/theme-rules.test.ts
git commit -m "feat: move the app shell to macOS semantic tokens and sidebar vibrancy"
```

---
### Task 4: 區 2,對話

**Files:**
- Modify: `src/renderer/components/Conversation.css`、`Markdown.css`、`ApprovalCard.css`、`HandoffCard.css`、`PeerQuestion.css`、`PendingStrip.css`、`CompactBoundary.css`、`CompactSummary.css`、`Busy.css`、`TranslateBar.css`、`NewConversationForm.css`、`Terminal.css`
- Modify: `tests/theme-rules.test.ts`(`MIGRATED` 加這 12 個檔)

**Interfaces:**
- Consumes:Task 1 的 token、Task 3 的對照表

這一區是視覺最重的地方。除了對照表,這幾條是設計決定:

- 對話內容區與輸入區 `background: var(--bg-content)`;訊息之間靠間距與 `--separator` 分,不用底色區分使用者與 agent。使用者訊息若原本有底色,改成 `--bg-raised` 加 `--radius-m`;agent 訊息無底。
- 程式碼區塊:`--bg-raised` 底、`--separator` 邊、`--radius-m`、`--font-mono`、`--text-s`。行內 code:`--bg-raised` 底、`--radius-s`。
- 工具呼叫卡片(`ToolCall` 用的 class 在 `Conversation.css`):`--bg-raised` 底、`--separator` 邊、`--radius-m`;展開時的內容 `--bg-content`。
- 批准卡(`ApprovalCard.css`):底 `color-mix(in srgb, var(--warning) 12%, transparent)`、邊 `--warning`、`--radius-m`;「允許」按鈕加 `primary` class 由 `theme.css` 接手樣式(這是唯一允許改 TSX 的地方:在 `ApprovalCard.tsx` 的允許按鈕加 `className="primary"`,不改其他東西)。拒絕按鈕維持一般樣式。
- 交接卡、同伴問答:底 `color-mix(in srgb, var(--info) 12%, transparent)`、邊 `--info`。
- `PendingStrip`:`--warning` 系。`CompactBoundary`、`CompactSummary`:`--label-3` 文字、`--separator` 線。
- `Busy.css` 的旋轉動畫:`--label-2` 色,時間不變;`prefers-reduced-motion` 由 `theme.css` 統一處理。
- `Terminal.css` 只有容器;xterm 自己的配色不在這次範圍(記進 RESULTS 的已知限制)。

- [ ] **Step 1: 放行這一區**

`MIGRATED` 加上 12 個檔名。Run: `npx vitest run tests/theme-rules.test.ts` → FAIL,列出待辦。

- [ ] **Step 2: 逐檔搬遷**,依上面的決定與 Task 3 的對照表。`ApprovalCard.tsx` 只加一個 `className="primary"`。

- [ ] **Step 3: 驗證**

Run: `npx vitest run tests/theme-rules.test.ts && npm test && npm run typecheck && npm run spike:screenshots`
Expected: 全部 PASS。看 `light-main.png`、`dark-main.png`:對話文字對比夠、程式碼區塊有邊界、批准卡是橙色系、允許按鈕是強調色。報告裡記下看到的問題。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components tests/theme-rules.test.ts
git commit -m "feat: move the conversation pane to macOS semantic tokens"
```

---

### Task 5: 區 3,右窗格

**Files:**
- Modify: `src/renderer/components/PanelGroup.css`、`BrowserBar.css`、`PreviewPane.css`、`DevelopmentDiff.css`、`PanelDivider.css`
- Modify: `tests/theme-rules.test.ts`(`MIGRATED` 加這 5 個檔)

設計決定:

- `PanelGroup`:容器 `--bg-content`;分頁列 `--bg-window` 底、`--separator` 下線;分頁選取 `--accent-soft` 底、`--label` 字。
- `BrowserBar` 照 Safari:輸入框 `--bg-raised` 底、無邊框、`--radius-m`、`--text-s`、文字置中(`text-align: center`),聚焦時 `--bg-content` 底加強調色外框、文字靠左;三個按鈕無邊框、`--label-2` 色、滑過 `--bg-hover`。錯誤訊息 `--danger`、`--text-xs`。
- `PreviewPane`(Markdown 文件預覽):跟區 2 的 Markdown 同一套;13 種寫死的綠色系全部依用途換成 `--label` / `--label-2` / `--bg-raised` / `--separator`,標題不用強調色。
- `DevelopmentDiff`:新增行 `color-mix(in srgb, var(--success) 12%, transparent)`、刪除行 `color-mix(in srgb, var(--danger) 12%, transparent)`、行號 `--label-3`、`--font-mono`、`--text-s`。
- `PanelDivider`:靜止時 `--separator`,滑過與拖曳時 `--accent`,`transition: background-color 150ms ease-out`。

- [ ] **Step 1: 放行**,`MIGRATED` 加 5 個檔。
- [ ] **Step 2: 逐檔搬遷**。
- [ ] **Step 3: 驗證**:同 Task 4 的指令;截圖裡右窗格的網址列在兩種外觀下都看得出是輸入框,diff 顏色可辨。
- [ ] **Step 4: Commit**

```bash
git add src/renderer/components tests/theme-rules.test.ts
git commit -m "feat: move the right panel to macOS semantic tokens"
```

---

### Task 6: 區 4,對話框

**Files:**
- Modify: `src/renderer/theme.css`(加 `--backdrop`)、`src/renderer/components/SkillsManager.css`、`PermissionManager.css`、`ChefManager.css`、`TestMachinesManager.css`
- Modify: `tests/theme-rules.test.ts`(`MIGRATED` 加這 4 個檔)

設計決定:

- `theme.css` 的 `:root` 加 `--backdrop: color-mix(in srgb, black 30%, transparent);`,深色區塊 `color-mix(in srgb, black 50%, transparent)`(規則測試要求兩個區塊 token 同組,所以兩邊都要有)。
- `SkillsManager.css` 是四個對話框共用的殼:`.skills-dialog` `--bg-window` 底、`--radius-l`、`box-shadow: 0 0 0 1px var(--separator), 0 20px 60px var(--label-4)`、`::backdrop` 用 `--backdrop`;標題 `--text-xl`、副標 `--label-2` `--text-m`;內容區的卡片 `--bg-raised` 加 `--separator`。
- 主要按鈕(儲存、套用)加 `primary`,放在按鈕列最右邊;取消在它左邊。這需要在四個 Manager 的 TSX 加 `className="primary"`,允許只做這一件事,不調順序以外的 DOM。
- 25 種寫死的色碼全部收進 token;`#ffffff08` 到 `#ffffff18` 這一組換成 `--separator` 或 `--bg-hover`。

- [ ] **Step 1: 放行**,`MIGRATED` 加 4 個檔;`theme.css` 加 `--backdrop`(兩個區塊)。
- [ ] **Step 2: 逐檔搬遷**;四個 TSX 各加一個 `className="primary"`。
- [ ] **Step 3: 驗證**:同 Task 4 的指令;看 8 張對話框截圖,兩種外觀下標題、卡片、主要按鈕都對。`tests/*-manager.test.tsx` 若有依 `className` 查按鈕的斷言,不會受影響(它們用 `getByRole` 與文字)。
- [ ] **Step 4: Commit**

```bash
git add src/renderer tests/theme-rules.test.ts
git commit -m "feat: move the manager dialogs to macOS semantic tokens"
```

---

### Task 7: 區 5,設計審視與收尾

**Files:**
- Modify: `tests/theme-rules.test.ts`(`MIGRATED` 換成掃全部)
- Modify: 審視找出問題的 CSS 檔
- Create: `docs/RESULTS-36-apple-design.md` 的第 1 節(審視表)

**Interfaces:**
- Consumes:`.spike-out/ui/` 的 10 張圖(改後)與 `.spike-out/ui-before/` 的 10 張(改前)、`.claude/skills/emil-design-eng/SKILL.md`

- [ ] **Step 1: 規則測試掃全部**

`tests/theme-rules.test.ts`:刪掉 `MIGRATED` 與 `migrated()`,「已搬遷的元件 CSS」那組直接對 `cssFiles()` 全部檢查。Run: `npx vitest run tests/theme-rules.test.ts` → PASS(29 個檔都已搬)。FAIL 的話就是漏掉的檔,搬完再往下。

- [ ] **Step 2: 設計審視**

用 `.claude/skills/emil-design-eng` 這份 skill(讀它的規則,照它要求的格式),對 10 張截圖與五區的 CSS 做一輪審視,產出 Before / After / Why 的表格。至少看這些:每個 `transition` 的屬性與曲線;按下、滑過、聚焦三種狀態每個控制項都有;卡片的層次(底色、邊、陰影不要三個都用);間距是否成 4px 的倍數;圖示與文字的基線對齊;兩種外觀下 `--label-2` 是否還讀得到。表格寫進 `docs/RESULTS-36-apple-design.md` §1。

- [ ] **Step 3: 修表格裡的項目**,只改 CSS。每改完一批跑一次截圖看。

- [ ] **Step 4: 驗證**

Run: `npm test && npm run typecheck && npm run build && npm run spike:screenshots`
Expected: 全部 PASS;10 張圖是最終版。

- [ ] **Step 5: Commit**

```bash
git add src/renderer tests/theme-rules.test.ts docs/RESULTS-36-apple-design.md
git commit -m "feat: polish the renderer after the design review"
```

---

### Task 8: 對比量測、實機驗收、規格同步

**Files:**
- Modify: `docs/RESULTS-36-apple-design.md`(§2 對比、§3 實機驗收、§4 已知限制)
- Modify: `docs/specs/2026-09-22-apple-design-design.md`(狀態、與實作不符的句子)

- [ ] **Step 1: 對比量測**

寫一個小腳本(可以放在 `spikes/contrast.ts`,或直接在 node REPL 算)用 WCAG 的相對亮度公式,對 `theme.css` 的值算:淺色與深色各兩組,`--label` 對 `--bg-content`、`--label-2` 對 `--bg-content`、`--label` 對 `--bg-raised`、`--accent-text` 對系統藍(`rgb(0,122,255)`)。rgba 的文字色先用 alpha 合成到背景上再算。結果表寫進 RESULTS §2,門檻照規格 §6.3 第 4 項(4.5:1、3:1);不到門檻的 token 改值後重跑 Task 7 的截圖。

- [ ] **Step 2: 實機驗收**

Run: `npm run dev`,照規格 §6.3 的五項做,結果寫進 RESULTS §3。第 3 項(材質)沒有的話,把 `src/main/index.ts` 的 `vibrancy` 拿掉、殼的三個透明背景改回 `--bg-window`,並在 §4 記原因。

- [ ] **Step 3: 規格同步**

狀態改「已實作,驗收見 docs/RESULTS-36-apple-design.md」;§4 依第 2 步的結果改寫;§3.1 若對比量測改了值,表格跟著改;§5 的表若審視時有換 token 的地方,補上。跑 `writing-tone` 的自查指令,破折號 0、粗體 0、禁用詞 0。

- [ ] **Step 4: Commit**

```bash
git add docs
git commit -m "docs: record the appearance overhaul review, contrast and acceptance"
```

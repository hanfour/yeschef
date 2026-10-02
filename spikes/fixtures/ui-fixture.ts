/** 截圖用的固定畫面內容：兩個專案、三個分頁、一段含 Markdown 與工具呼叫的對話、一張待批准卡、一個有瀏覽器的對話。 */
import type { ProjectsView } from '../../src/shared/projects.js'
import type { Event } from '../../src/shared/events.js'
import type { ApprovalAskPayload, SessionStatePayload, SessionSummary } from '../../src/shared/ipc.js'
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
        { id: 'fixture-chef-plan', contentType: 'conversation', label: '主廚 · 規劃與執行、驗收與跨專案整合', customLabel: '主廚 · 規劃與執行、驗收與跨專案整合', sortOrder: 3, lastFocusedAt: 0, threadId: 't-plan', provider: 'claude', chefTaskId: 'task-plan' },
        { id: 'fixture-conv-3', contentType: 'conversation', label: 'Codex · 修正表單的驗收問題', customLabel: 'Codex · 修正表單的驗收問題', sortOrder: 4, lastFocusedAt: 0, threadId: 't3', provider: 'codex' },
        { id: 'fixture-conv-4', contentType: 'conversation', label: 'Grok · 登入流程測試', customLabel: 'Grok · 登入流程測試', sortOrder: 5, lastFocusedAt: 0, threadId: 't4', provider: 'grok' },
        { id: 'fixture-conv-5', contentType: 'conversation', label: 'Claude · 文件整理工作', customLabel: 'Claude · 文件整理工作', sortOrder: 6, lastFocusedAt: 0, threadId: 't5', provider: 'claude' },
        { id: 'fixture-chef-review', contentType: 'conversation', label: '主廚 · 檢查跨專案瀏覽器狀態', customLabel: '主廚 · 檢查跨專案瀏覽器狀態', sortOrder: 7, lastFocusedAt: 0, threadId: 't6', provider: 'claude', chefTaskId: 'task-review' },
        { id: 'fixture-conv-6', contentType: 'conversation', label: 'Codex · 修正回歸測試與失敗狀態', customLabel: 'Codex · 修正回歸測試與失敗狀態', sortOrder: 8, lastFocusedAt: 0, threadId: 't7', provider: 'codex' },
        { id: 'fixture-conv-7', contentType: 'conversation', label: 'Grok · 最後一輪驗收', customLabel: 'Grok · 最後一輪驗收', sortOrder: 9, lastFocusedAt: 0, threadId: 't8', provider: 'grok' },
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

/**
 * 這段對話都掛在同一個 assistant 訊息 `messageId: 'm1'` 底下、不帶 `index`：
 * `fold()`（src/shared/fold.ts）用 `(messageId, index)` 當去重鍵，`index` 缺席時
 * key 是 null，一律附加（等同 history 路徑「多 block 的 assistant 訊息沒有
 * index」那個情況,見 fold.ts 的 blockKey 註解)。`tool-result` 不用帶 messageId,
 * `updateToolBlock` 純靠 `id` 找回對應的 tool block。
 *
 * 少了 messageId 的 text／tool-use 會被 fold 的 applyUnknown 接住,畫成一張
 * 「未知事件」卡片而不是真正的內容——這是第一版 fixture 的錯誤,截圖因此看不到
 * Markdown 內容或工具卡片,只看到四張「未知事件」。
 */
const ASSISTANT_MESSAGE_ID = 'm1'

/**
 * 這段 assistant 文字刻意壓短（原本還有一段「樣式沿用既有的 token」的兩點條列)：
 * `.conversation-list` 只有約 450px 高（規格既有的對話版面,不是這次改動的東西),
 * 截圖固定捲到頂端以同時露出使用者訊息、Markdown 回覆與第一張工具卡片,原本較長的
 * 文字會把第一張工具卡片的「完成」列擠到這段可視範圍外(只剩貼著下緣的幾 px,
 * 實際上會被裁掉看不到)。縮短文字後三者能同時出現在同一張 `main` 截圖裡。
 */
export const EVENTS: readonly Event[] = [
  { kind: 'user-text', text: '幫我把登入頁的密碼欄改成有「顯示密碼」的切換,改完用 staging 驗一次。' },
  { kind: 'text', messageId: ASSISTANT_MESSAGE_ID, text: '好,先看現在的表單結構。\n\n```tsx\n<input id="password" type="password" />\n```\n\n我會加一個 `aria-pressed` 的切換鈕,然後用 `view_login` 驗證。' },
  { kind: 'tool-use', messageId: ASSISTANT_MESSAGE_ID, id: 'tu-1', name: 'mcp__yeschef__view_snapshot', input: { scope: 'viewport' } },
  { kind: 'tool-result', id: 'tu-1', content: 's1-e0 textbox "帳號"\ns1-e1 textbox "密碼"\ns1-e2 button "登入"', isError: false },
  { kind: 'tool-use', messageId: ASSISTANT_MESSAGE_ID, id: 'tu-2', name: 'mcp__yeschef__view_eval', input: { expression: 'document.title' } },
]

export const ASK: ApprovalAskPayload = {
  requestId: 'ask-1',
  projectId: 'p1',
  conversationId: CONVERSATION,
  toolUseId: 'tu-2',
  toolName: 'mcp__yeschef__view_eval',
  input: { expression: 'document.title' },
  reviewReason: 'view_eval 每次都需要批准',
}

const CURRENT_SESSION_ID = 'session-current'

/**
 * 側欄「歷史對話」的固定清單：一筆是目前對話（`is-current`,對到下面
 * `SESSION_STATE` 的 `sessionId`)、一筆帶 `gitBranch`、一筆帶 `cwd`（`showCwd`
 * 開著時才顯示,對到 hotfix-1 的多行按鈕驗證)。
 */
export const SESSIONS: readonly SessionSummary[] = [
  { sessionId: CURRENT_SESSION_ID, summary: '把登入頁的密碼欄加上顯示密碼切換', lastModified: Date.now() - 5 * 60_000 },
  { sessionId: 'session-branch', summary: '修 WorkspaceHistory 側欄捲動殘留的問題', lastModified: Date.now() - 3 * 3_600_000, gitBranch: 'fix/scroll-jump' },
  { sessionId: 'session-cwd', summary: '調整 Recents 側欄列與清單間距', lastModified: Date.now() - 2 * 86_400_000, cwd: '/Users/me/Projects/demo-app' },
]

export const SESSION_STATE: SessionStatePayload = { conversationId: CONVERSATION, state: { kind: 'live', sessionId: CURRENT_SESSION_ID } }
export const BROWSER_STATE: BrowserStatePayload = { conversationId: CONVERSATION, url: 'https://staging.example.com/login', title: '登入', loading: false, canGoBack: true, canGoForward: false }
export const BROWSER_SESSIONS: readonly BrowserSessionEntry[] = [{ conversationId: CONVERSATION, busy: true }, { conversationId: 'fixture-conv-2', busy: false }]

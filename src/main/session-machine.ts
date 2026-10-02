/**
 * session 的狀態機。純函式，不執行副作用。
 *
 * effects 是「該做什麼」的描述，由呼叫端照陣列順序執行。這樣設計是因為
 * 規格 §3.2 規定切換 session 的收尾有三步且順序固定，而順序如果藏在
 * 命令式的程式碼裡，就只能靠跑得起 Electron 的整合測試來驗證。
 */

import type { PromptAttachment } from '../shared/conversation-tools.js'
import type { SessionState } from '../shared/session-state.js'
export type { SessionState }

export type Action =
  | { readonly kind: 'start-new' }
  | { readonly kind: 'open-history'; readonly sessionId: string }
  | { readonly kind: 'user-input'; readonly text: string; readonly attachments?: readonly PromptAttachment[] }
  /**
   * SDK 吐出這一場的 session id（規格 §7）。只有 live 收得下：id 是活躍 query 的
   * 身分，收尾之後才遲到的那一筆不可以把 idle 或 viewing 翻回 live。
   */
  | { readonly kind: 'session-started'; readonly sessionId: string }
  | { readonly kind: 'session-ended' }
  | { readonly kind: 'window-closed' }
  /**
   * 專案切到背景且回合已結束(規格 D §3.3):收掉串流只留 sessionId。之後 user-input
   * 會走 viewing 的路徑帶 resume,所以 live 有 id 時轉 viewing 而不是 idle。
   */
  | { readonly kind: 'sleep' }

export type Effect =
  | { readonly kind: 'deny-all-approvals'; readonly reason: string }
  | { readonly kind: 'interrupt-query' }
  | { readonly kind: 'teardown-query' }
  | { readonly kind: 'start-query'; readonly resumeSessionId?: string; readonly initialInput?: string; readonly attachments?: readonly PromptAttachment[] }
  | { readonly kind: 'load-history'; readonly sessionId: string }

export interface TransitionResult {
  readonly state: SessionState
  readonly effects: readonly Effect[]
}

/**
 * 收掉一個活躍 query 的三步驟，順序固定（規格 §3.2）。
 *
 * 先 deny 待決的批准：那些 promise 掛在 SDK 的 canUseTool 上，不結束就會讓
 * interrupt 卡住。再 interrupt 中止進行中的工具。最後才收掉 query。
 */
function teardownLive(reason: string): readonly Effect[] {
  return [
    { kind: 'deny-all-approvals', reason },
    { kind: 'interrupt-query' },
    { kind: 'teardown-query' },
  ]
}

/**
 * 從 idle 狀態出發的轉移。
 * idle 是無任務狀態：已完成或尚未開始。
 */
function fromIdle(action: Action): TransitionResult {
  switch (action.kind) {
    case 'start-new':
      return { state: { kind: 'live' }, effects: [{ kind: 'start-query' }] }
    case 'open-history':
      return {
        state: { kind: 'viewing', sessionId: action.sessionId },
        effects: [{ kind: 'load-history', sessionId: action.sessionId }],
      }
    case 'user-input':
      // idle 沒有 query 可送，這則輸入就是新對話的第一句（規格 §7，2026-09-03 修訂）。
      return {
        state: { kind: 'live' },
        effects: [{ kind: 'start-query', initialInput: action.text, ...(action.attachments?.length ? { attachments: action.attachments } : {}) }],
      }
    case 'session-started':
    case 'session-ended':
    case 'window-closed':
    case 'sleep':
      // 在 idle 沒有意義。不拋錯，回原狀態的複本。
      return { state: { kind: 'idle' }, effects: [] }
  }
}

/**
 * 從 live 狀態出發的轉移。
 * live 是有活躍 query 的狀態，agent 正在思考或執行工具。
 */
function fromLive(state: Extract<SessionState, { kind: 'live' }>, action: Action): TransitionResult {
  switch (action.kind) {
    case 'session-ended':
      // query 自己結束了，不需要收尾
      return { state: { kind: 'idle' }, effects: [] }
    case 'window-closed':
      return { state: { kind: 'idle' }, effects: teardownLive('視窗已關閉') }
    case 'open-history':
      return {
        state: { kind: 'viewing', sessionId: action.sessionId },
        effects: [
          ...teardownLive('切換 session'),
          { kind: 'load-history', sessionId: action.sessionId },
        ],
      }
    case 'start-new':
      return {
        state: { kind: 'live' },
        effects: [...teardownLive('切換 session'), { kind: 'start-query' }],
      }
    case 'user-input':
      // 已經有活躍 query，輸入直接送進去，不經狀態機
      return { state: { ...state }, effects: [] }
    case 'session-started':
      // 這一場的 id 到了。狀態帶上它，側邊欄才有辦法把進行中的對話標成目前這一筆。
      return { state: { kind: 'live', sessionId: action.sessionId }, effects: [] }
    case 'sleep':
      return state.sessionId === undefined
        ? { state: { kind: 'idle' }, effects: teardownLive('專案切到背景') }
        : { state: { kind: 'viewing', sessionId: state.sessionId }, effects: teardownLive('專案切到背景') }
  }
}

/**
 * 從 viewing 狀態出發的轉移。
 * viewing 是檢視歷史記錄的狀態，沒有活躍 query。
 */
function fromViewing(state: Extract<SessionState, { kind: 'viewing' }>, action: Action): TransitionResult {
  switch (action.kind) {
    case 'user-input':
      return {
        state: { kind: 'live', sessionId: state.sessionId },
        effects: [
          { kind: 'start-query', resumeSessionId: state.sessionId, initialInput: action.text, ...(action.attachments?.length ? { attachments: action.attachments } : {}) },
        ],
      }
    case 'open-history':
      return {
        state: { kind: 'viewing', sessionId: action.sessionId },
        effects: [{ kind: 'load-history', sessionId: action.sessionId }],
      }
    case 'start-new':
      return { state: { kind: 'live' }, effects: [{ kind: 'start-query' }] }
    case 'session-started':
    case 'sleep':
      // viewing 沒有活躍 query，重播出來的 session-start 不該改變正在看哪一場。
      return { state: { ...state }, effects: [] }
    case 'window-closed':
    case 'session-ended':
      // viewing 沒有活躍 query，不需要收尾
      return { state: { kind: 'idle' }, effects: [] }
  }
}

export function transition(state: SessionState, action: Action): TransitionResult {
  switch (state.kind) {
    case 'idle':
      return fromIdle(action)
    case 'live':
      return fromLive(state, action)
    case 'viewing':
      return fromViewing(state, action)
  }
}

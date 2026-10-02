import type { Attachment } from '../../shared/conversation-tools.js'
import { PreviewContext } from '../preview-context.js'
import type { ConversationCost } from '../format-cost.js'
import { useElapsedSeconds } from '../elapsed.js'
import { isPeerToolName } from '../../shared/peer-tools.js'
import { PeerQuestion } from './PeerQuestion.js'
import { usePeer } from '../hooks/usePeer.js'
import { PROVIDER_LABELS, type Provider } from '../../shared/projects.js'
import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Icon } from './Icon.js'
import { Conversation, type ToolBlock } from './Conversation.js'
import './Busy.css'
import { PendingStrip, jumpToApproval } from './PendingStrip.js'
import { ApprovalCard } from './ApprovalCard.js'
import { HandoffCard } from './HandoffCard.js'
import { Recents, type SessionScope } from './Recents.js'
import { Sidebar } from './Sidebar.js'
import { useConversation } from '../hooks/useConversation.js'
import { useApprovals } from '../hooks/useApprovals.js'
import { useSessions } from '../hooks/useSessions.js'
import type { Projects } from '../hooks/useProjects.js'
import { applyPendingApprovals, findAskForBlock, openAsks, unmatchedAsks } from '../approvals.js'
import type { ApprovalAskPayload, YesChefApi } from '../../shared/ipc.js'
import type { SessionState } from '../../shared/session-state.js'
import { isViewToolName } from '../../shared/view-tools.js'

export const VIEWING_PLACEHOLDER = '輸入以接續這條對話'
export const LIVE_PLACEHOLDER = '輸入訊息，Enter 送出，Shift+Enter 換行'

interface ComposerProps {
  readonly placeholder: string
  readonly api: Pick<YesChefApi, 'conversationTools'>
  readonly conversationId: string
  /** 有待決的批准請求時停用(規格 §6)。 */
  readonly disabled?: boolean
  /** 有給就在輸入框旁畫一顆「新對話」。讓 codex 分頁在輸入處也能快速開始新對話。 */
  readonly onStartNew?: () => void
}

function Composer({ placeholder, api, conversationId, disabled = false, onStartNew }: ComposerProps) {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const workingRef = useRef(false)
  const aliveRef = useRef(true)
  const focusAfterSend = useRef(false)
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false } }, [])
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const hintId = useId()
  useLayoutEffect(() => { if (!working && focusAfterSend.current) { focusAfterSend.current = false; inputRef.current?.focus() } }, [working])
  useLayoutEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.style.height = 'auto'
    input.style.height = `${Math.min(220, Math.max(72, input.scrollHeight))}px`
    input.style.overflowY = input.scrollHeight > 220 ? 'auto' : 'hidden'
  }, [text])

  const run = async (action: () => Promise<void>) => {
    if (workingRef.current) return
    workingRef.current = true; setWorking(true); setError('')
    try { await action() } catch (error) { if (aliveRef.current) setError(error instanceof Error ? error.message : '操作失敗，請重試') }
    finally { workingRef.current = false; if (aliveRef.current) setWorking(false) }
  }
  const submit = () => {
    const trimmed = text.trim()
    if (disabled || (!trimmed && !attachments.length)) return
    void run(async () => {
      const response = await api.conversationTools({ action: 'send', conversationId, text: trimmed, attachments: attachments.map(a => a.id) })
      if (response.kind === 'error') throw Error(response.message)
      if (response.kind !== 'sent') throw Error('訊息尚未送出')
      if (!aliveRef.current) return
      setText(''); setAttachments([]); focusAfterSend.current = true
    })
  }
  const pick = () => void run(async () => {
    const response = await api.conversationTools({ action: 'pick', conversationId })
    if (response.kind === 'error') throw Error(response.message)
    if (response.kind === 'attachments' && aliveRef.current) setAttachments(previous => [...previous, ...response.attachments])
  })
  const remove = (id: string) => void run(async () => {
    const response = await api.conversationTools({ action: 'remove', conversationId, id })
    if (response.kind === 'error') throw Error(response.message)
    if (aliveRef.current) setAttachments(previous => previous.filter(a => a.id !== id))
  })

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return
    if (e.nativeEvent.isComposing) return
    e.preventDefault()
    submit()
  }

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    submit()
  }

  return (
    <form className="composer" onSubmit={onSubmit}>
      {attachments.length > 0 && <ul className="composer-attachments" aria-label="待送出附件">{attachments.map(a => <li key={a.id}>
        {a.thumbnail && <img src={a.thumbnail} alt={a.name} />}<span title={a.name}>{a.name}<small>{Math.ceil(a.size / 1024)} KB{a.kind === 'file' ? ' · 原始文件' : ''}</small></span>
        <button type="button" aria-label={`移除附件 ${a.name}`} disabled={working || disabled} onClick={() => remove(a.id)}>×</button>
      </li>)}</ul>}
      {error && <p role="alert" className="composer-error">{error}</p>}
      <textarea
        ref={inputRef}
        className="composer-input"
        aria-label="輸入訊息"
        aria-describedby={hintId}
        rows={3}
        value={text}
        placeholder={placeholder}
        disabled={disabled || working}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="composer-toolbar">
      <button type="button" className="composer-attach" aria-label="附加文件或照片" title="最多 8 個；照片 5 MiB、文件 10 MiB，合計 20 MiB" disabled={disabled || working || attachments.length >= 8} onClick={pick}>＋ 附件</button>
      <span className="composer-hint" id={hintId}>{disabled ? '先回覆待批准的請求' : <><kbd>Enter</kbd> 送出 <span>·</span> <kbd>Shift ↵</kbd> 換行</>}</span>
      {onStartNew === undefined ? null : (
        <button type="button" className="composer-new" disabled={disabled || working} onClick={onStartNew}>
          新對話
        </button>
      )}
      <button type="submit" className="composer-send primary" disabled={disabled || working || (!text.trim() && !attachments.length)}>
        <Icon name="arrow" />{working ? '處理中…' : '送出'}
      </button>
      </div>
    </form>
  )
}

/** 輸入框旁邊要不要多一顆「新對話」。Claude 那側的歷史側欄已經有,不重複。 */
const SHOW_START_NEW: Readonly<Record<Provider, boolean>> = { claude: false, codex: true, grok: true }

function placeholderFor(state: SessionState, pendingCount: number): string {
  if (pendingCount > 0) return `有 ${pendingCount} 個工具在等你批准,先回答上面的卡片`
  return state.kind === 'viewing' ? VIEWING_PLACEHOLDER : LIVE_PLACEHOLDER
}

export interface ConversationPaneProps {
  readonly sharedHistory?: boolean
  readonly onOpenChef?: (taskId: string) => void
  readonly jumpToken?: number
  readonly jumpTarget?: { readonly projectId: string; readonly tabId: string }
  readonly api: YesChefApi
  readonly projects: Projects
  readonly projectId: string
  readonly conversationId: string
  /** 清單依 provider 選擇資料來源,避免把不同後端的歷史混在一起。 */
  readonly provider: Provider
  /** 這個對話是不是前景。只有前景那個 pane 回報花費(掛載中的 pane 不只一個)。 */
  readonly isActive: boolean
  /** 把花費交給狀態列。成為前景而自己還沒有花費時要回報 undefined。 */
  readonly onCost?: (conversationId: string, cost: ConversationCost | undefined) => void
}

/**
 * 一個對話分頁的完整畫面(D2 規格 §4):Recents 側欄、對話、批准卡、輸入框。
 * 每個掛載中的對話分頁一份,對話事件只收自己的 `conversationId`,批准另列其他對話的請求。
 *
 * 批准的四個插入點沿用 A/B 的設計(原本在 App.tsx,註解一併搬過來):
 * 1. `applyPendingApprovals`:把命中的 tool block 標成 awaiting-approval
 * 2. `renderToolExtra`:把卡片畫進對應的 ToolCall 底部
 * 3. `unmatchedAsks`:對應不到 block 的請求畫在對話尾端,不靜默丟棄
 * 4. `Composer` 的 `disabled`:有待決請求時輸入框停用
 * 四點全部吃 `openAsks(rawView, pending)` 算出來的 `active`,不是 `useApprovals` 原始的 `pending`:
 * 批准逾時是主程序自己 deny 掉的,`active` 只留下 block 還開著的那些,了結的請求不再擋輸入框。
 *
 * 第 2 點的命中查找一定要走 `findAskForBlock`,不能在這裡重寫一次比對。
 *
 * `Composer` 送到 `api.sendInput`,主行程送給前景對話;能看見這個 pane 的時候它就是前景,兩邊一致。
 */
export function ConversationPane({ sharedHistory = false, onOpenChef, api, projects, projectId, conversationId, provider, isActive, onCost, jumpToken = 0, jumpTarget }: ConversationPaneProps) {
  const openPreview = useContext(PreviewContext)
  const workspaceRef = useRef<HTMLDivElement>(null)
  const historyButtonRef = useRef<HTMLButtonElement>(null)
  const historyRegionRef = useRef<HTMLDivElement>(null)
  const historyId = useId()
  const [compactHistory, setCompactHistory] = useState(false)
  const [historyPreference, setHistoryPreference] = useState<boolean>()
  const historyOpen = !sharedHistory && (historyPreference ?? !compactHistory)
  useLayoutEffect(() => {
    if (!historyOpen && historyRegionRef.current?.contains(document.activeElement)) historyButtonRef.current?.focus()
    if (historyOpen && compactHistory) historyRegionRef.current?.querySelector<HTMLInputElement>('input[type=search]')?.focus()
  }, [historyOpen, compactHistory])
  useLayoutEffect(() => {
    if (sharedHistory) return
    const element = workspaceRef.current
    if (!element) return
    const update = () => {
      const width = element.getBoundingClientRect().width
      if (width > 0) setCompactHistory(width < 700)
    }
    update()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
    observer?.observe(element)
    window.addEventListener('resize', update)
    return () => { observer?.disconnect(); window.removeEventListener('resize', update) }
  }, [sharedHistory])
  const pane = useRef<HTMLElement>(null)
  const onJump = useCallback((requestId: string) => jumpToApproval(pane.current, requestId), [])
  const { view: rawView, sessionState, turnEnds } = useConversation(api, conversationId)
  const peer = usePeer(api)
  /** 每秒重算一次,讓等待秒數會動;沒有未決問題時不起計時器。 */
  const tick = useElapsedSeconds(peer.pending.some((p) => p.askerConversationId === conversationId || p.targetConversationId === conversationId))
  const waitedOf = useCallback(
    (createdAt: number): number => Math.max(0, Math.floor((Date.now() - createdAt) / 1000)),
    // tick 只是為了每秒重算,值本身用不到。
    [tick]
  )

  /** 一個對話同時只會有一則未決提問(規格 §4.1),所以找到第一則就是它。 */
  const myAsking = useMemo(
    () => peer.pending.find((p) => p.askerConversationId === conversationId),
    [peer.pending, conversationId]
  )

  /** 這個對話是回答方時才給按鈕:提問方那邊的介入掛在 ask_peer 的 tool block 上(Task 7)。 */
  const peerFor = useCallback(
    (questionId: string) => {
      const item = peer.pending.find((p) => p.questionId === questionId && p.targetConversationId === conversationId && p.projectId === projectId)
      if (item === undefined) return {}
      return {
        status: { kind: 'waiting' as const, waitedSeconds: waitedOf(item.createdAt) },
        onAnswer: (text: string) => { peer.answer(questionId, text) },
        onCancel: () => { peer.cancel(questionId) },
      }
    },
    [peer, conversationId, projectId, waitedOf]
  )

  const { pending, foreign, reply } = useApprovals(api, conversationId)
  // Recents 的範圍(規格 §3.2):預設本專案,使用者可切成全部;切對話不重設(每個 pane 自己記)。
  const [scope, setScope] = useState<SessionScope>('project')
  const listScope = useMemo(() => ({ projectId: scope === 'all' ? null : projectId, provider }), [scope, projectId, provider])
  const project = useMemo(() => projects.view.projects.find((p) => p.id === projectId), [projects.view, projectId])
  const threads = useMemo(
    () => (scope === 'all' ? projects.view.projects.flatMap((p) => p.threads) : (project?.threads ?? [])),
    [scope, projects.view, project]
  )
  const { sessions, current, error } = useSessions(api, turnEnds, listScope, conversationId, !sharedHistory)

  const active = useMemo(() => openAsks(rawView, pending), [rawView, pending])
  const lastJumpToken = useRef(0)
  const firstRequestId = active[0]?.requestId
  const isJumpTarget = jumpTarget?.projectId === projectId && jumpTarget.tabId === conversationId
  useEffect(() => {
    if (jumpToken > 0 && jumpToken !== lastJumpToken.current && isActive && isJumpTarget && firstRequestId !== undefined) {
      if (compactHistory && historyOpen) { setHistoryPreference(false); return }
      // 只在實際跳轉時記錄，避免背景或尚未收到批准請求時消耗 token。
      lastJumpToken.current = jumpToken
      onJump(firstRequestId)
    }
  }, [jumpToken, isActive, firstRequestId, isJumpTarget, onJump, compactHistory, historyOpen])
  const view = useMemo(() => applyPendingApprovals(rawView, active), [rawView, active])
  const isBusy = project?.busyTabIds.includes(conversationId) ?? false
  const elapsed = useElapsedSeconds(isActive && isBusy, project?.busySince[conversationId])
  // 不從 view 猜：RESET 與重播會清掉歷史，busy 也可能早於使用者訊息回聲。
  const waitingForContent = !(project?.producingTabIds.includes(conversationId) ?? false)
  // 思考中也要換分鐘制:長思考正是這個數字要服務的情況。
  const elapsedLabel = elapsed < 60
    ? ` ${elapsed} 秒`
    : ` ${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒`
  const cost = view.ended ? view.cost : undefined
  useEffect(() => {
    if (!isActive) return
    onCost?.(conversationId, cost)
  }, [isActive, cost, onCost, conversationId])

  const orphans = useMemo(() => unmatchedAsks(view, active), [view, active])

  /** 別的對話的卡:標示用專案名加對話標籤,兩者任一找不到就退成「其他對話」。 */
  const originOf = useCallback(
    (askPayload: ApprovalAskPayload) => {
      const project = projects.view?.projects.find((p) => p.id === askPayload.projectId)
      const tab = project?.tabs.find((t) => t.id === askPayload.conversationId)
      const label =
        project === undefined || tab === undefined
          ? '其他對話'
          : `${project.name} · ${tab.customLabel ?? tab.label}`
      return {
        label,
        onJump: (): void => {
          projects.activate(askPayload.projectId)
          projects.activateTab(askPayload.conversationId, askPayload.projectId)
        },
      }
    },
    [projects]
  )

  const renderToolExtra = useCallback(
    (block: ToolBlock) => {
      if (sessionState.kind !== 'viewing' && isPeerToolName(block.name, 'ask_peer') && block.status === 'running' && myAsking !== undefined) {
        return (
          <div className="peer-asking-actions">
            <PeerQuestion
              question={{ provider: myAsking.targetProvider, fromLinkId: myAsking.targetLinkId.slice(0, 8), questionId: myAsking.questionId, text: myAsking.text }}
              status={{ kind: 'waiting', waitedSeconds: waitedOf(myAsking.createdAt) }}
              onAnswer={(text) => { peer.answer(myAsking.questionId, text) }}
              onCancel={() => { peer.cancel(myAsking.questionId) }}
            />
          </div>
        )
      }
      const ask = findAskForBlock(block, active)
      return ask === undefined ? null : <ApprovalCard ask={ask} onDecide={reply} />
    },
    [active, reply, myAsking, waitedOf, peer, sessionState.kind]
  )

  const renderToolOverride = useCallback(
    (block: ToolBlock, historical: boolean) =>
      isViewToolName(block.name, 'request_handoff') ? (
        <HandoffCard block={block} historical={historical} onDone={api.handoffDone} />
      ) : undefined,
    [api]
  )

  return (
    <div ref={workspaceRef} className={`conversation-workspace${compactHistory ? ' is-compact-history' : ''}`} onKeyDown={event => {
      if (event.key === 'Escape' && compactHistory && historyOpen) {
        setHistoryPreference(false)
        historyButtonRef.current?.focus()
      }
    }}>
      <div className="conversation-toolbar">
        {!sharedHistory && <button ref={historyButtonRef} type="button" className="history-toggle" aria-controls={historyId} aria-expanded={historyOpen}
          onClick={() => setHistoryPreference(!historyOpen)}><Icon name="history" />歷史</button>}
        {openPreview && <button type="button" className="history-toggle" onClick={() => openPreview({ kind: 'diff', conversationId })}>查看 diff</button>}
        <span className={`provider-badge provider-${provider}`}>{PROVIDER_LABELS[provider].name}</span>
        <span className="conversation-mode">{isBusy ? '進行中' : sessionState.kind === 'viewing' ? '接續歷史' : '準備就緒'}</span>
      </div>
      <div className="conversation-layout">
      {compactHistory && historyOpen && <button type="button" className="history-backdrop" aria-label="關閉歷史對話" onClick={() => { setHistoryPreference(false); historyButtonRef.current?.focus() }} />}
      {!sharedHistory && <div ref={historyRegionRef} id={historyId} className="history-region" hidden={!historyOpen}>
      <Sidebar>
        <Recents
          sessions={sessions}
          current={current}
          error={error}
          threads={threads}
          scope={scope}
          onScopeChange={project === undefined ? undefined : setScope}
          onOpen={id => { api.openHistory(id); if (compactHistory) setHistoryPreference(false) }}
          onStartNew={() => { api.startNew(); if (compactHistory) setHistoryPreference(false) }}
        />
      </Sidebar>
      </div>}
      <main className="conversation" ref={pane} inert={compactHistory && historyOpen}>
        {view.turns.length === 0 && view.error === undefined && !isBusy && <div className="conversation-welcome">
          <span className="welcome-mark"><Icon name="chat" /></span>
          <h1>{sessionState.kind === 'viewing' ? '接續這段對話' : '從一個想法開始'}</h1>
          <p>{sessionState.kind === 'viewing'
            ? `${project === undefined ? '' : `在「${project.name}」專案中`}與 ${PROVIDER_LABELS[provider].name} 對話。請在下方輸入訊息，延續目前的工作。`
            : `${project === undefined ? '' : `在「${project.name}」專案中`}與 ${PROVIDER_LABELS[provider].name} 開始對話。描述你想完成的事，讓 agent 和你一起推進。`}</p>
          <div className="welcome-capabilities"><span>修改程式</span><span>檢查畫面</span><span>整理文件</span></div>
        </div>}
        <Conversation
          view={view}
          translate={api.translate}
          assistantLabel={PROVIDER_LABELS[provider].name}
          peerFor={peerFor}
          historical={sessionState.kind === 'viewing'}
          renderToolExtra={renderToolExtra}
          renderToolOverride={renderToolOverride}
        />
        {isActive && isBusy ? (
          <div className="conversation-busy" role="status" aria-live="polite">
            {waitingForContent ? '模型思考中' : '執行中'}<span aria-hidden="true">{elapsedLabel}</span>
          </div>
        ) : null}
        {isActive && active.length > 0 ? <PendingStrip active={active} reply={reply} onJump={onJump} /> : null}
        {orphans.length > 0 || foreign.length > 0 ? (
          <div className="approval-tail">
            {orphans.map((ask) => (
              <ApprovalCard key={ask.requestId} ask={ask} onDecide={reply} unmatched />
            ))}
            {foreign.map((a) => (
              <ApprovalCard key={a.requestId} ask={a} onDecide={reply} unmatched origin={originOf(a)} />
            ))}
          </div>
        ) : null}
        {project?.tabs.find(tab => tab.id === conversationId)?.chefTaskId ? <div className="chef-worker-note"><span>此對話由主廚管理。新增需求或接續工作請使用任務控制台。</span><button type="button" onClick={() => onOpenChef?.(project.tabs.find(tab => tab.id === conversationId)!.chefTaskId!)}>開啟主廚任務</button></div> : <Composer
          placeholder={placeholderFor(sessionState, active.length)}
          api={api}
          conversationId={conversationId}
          disabled={active.length > 0}
          {...(SHOW_START_NEW[provider] ? { onStartNew: api.startNew } : {})}
        />}
      </main>
      </div>
    </div>
  )
}

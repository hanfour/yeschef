import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type React from 'react'
import { onErrorIntakeChanged } from '../error-intake-events.js'
import type { YesChefApi } from '../../shared/ipc.js'
import type { ErrorIntakeResponse } from '../../shared/error-intake.js'
import { activeGroupParticipants, GENERAL_THREAD_ID, GROUP_ALL_THREADS, isMilestone, senderLabel, targetThreadForAll, type GroupMessage, type GroupThread } from '../../shared/group.js'
import { PROVIDER_LABELS } from '../../shared/projects.js'
import { useGroup, type Group, type GroupApi } from '../hooks/useGroup.js'
import type { Projects } from '../hooks/useProjects.js'
import { formatRelativeTime } from './relative-time.js'
import { Icon } from './Icon.js'
import { DialogBoundary } from './ErrorBoundary.js'
import { ErrorPullDialog } from './ErrorPullDialog.js'
import './GroupPane.css'

/** 膠囊列的「全部」不是一條真的 thread，所以用一個不會跟 ChefTask.id 撞的值。 */
export const ALL_THREADS = 'all'
export const GROUP_UI_TEXT = {
  all: '全部',
  placeholder: '輸入訊息，@ 指定對象，Enter 送出，Shift+Enter 換行',
  reconcileAndResume: '確認後接續',
  emptyHint: '還沒有訊息。說一句話,主廚就會開始。',
  status: {
    open: '未分派', queued: '排隊中', running: '進行中', stopping: '停止中',
    completed: '完成', blocked: '卡住', cancelled: '已取消',
  } satisfies Readonly<Record<GroupThread['status'], string>>,
} as const
export const GROUP_EMPTY_HINT = GROUP_UI_TEXT.emptyHint

const STICK_THRESHOLD_PX = 40

function senderKey(from: GroupMessage['from']): string {
  return from.kind === 'agent' ? from.provider : from.kind
}

interface ThreadStripProps {
  readonly threads: readonly GroupThread[]
  readonly selected: string
  readonly onSelect: (id: string) => void
}

function ThreadStrip({ threads, selected, onSelect }: ThreadStripProps): React.ReactElement {
  return (
    <div className="group-threads" role="group" aria-label="群組目標">
      <button type="button" aria-pressed={selected === ALL_THREADS}
        className={`group-thread${selected === ALL_THREADS ? ' is-on' : ''}`}
        onClick={() => onSelect(ALL_THREADS)}><span className="group-thread-label">{GROUP_UI_TEXT.all}</span></button>
      {threads.map((thread) => (
        <button key={thread.id} type="button" aria-pressed={selected === thread.id}
          className={`group-thread${selected === thread.id ? ' is-on' : ''}`}
          title={thread.title}
          onClick={() => onSelect(thread.id)}>
          <span className="group-thread-label">{thread.id === GENERAL_THREAD_ID
            ? thread.title
            : `${thread.title}（${GROUP_UI_TEXT.status[thread.status]} · ${String(thread.participants.length)} 人）`}</span>
        </button>
      ))}
    </div>
  )
}

interface MessageRowProps {
  readonly message: GroupMessage
  readonly now: number
  readonly onJump: (message: GroupMessage) => void
}

function MessageRow({ message, now, onJump }: MessageRowProps): React.ReactElement {
  const from = message.from
  return (
    <div className={`group-message${isMilestone(message) ? ' is-milestone' : ''}`}>
      <span className="group-from" data-from={senderKey(from)}
        title={from.kind === 'agent' ? PROVIDER_LABELS[from.provider].name : undefined}>{senderLabel(from)}</span>
      <span className="group-at">{formatRelativeTime(message.at, now)}</span>
      <span className="group-text">{message.text}</span>
      {from.kind === 'agent' ? (
        <button type="button" className="group-jump" aria-label={`跳到 ${from.label} 的分頁`}
          onClick={() => onJump(message)}><Icon name="forward" /></button>
      ) : null}
    </div>
  )
}

interface GroupStreamProps {
  readonly messages: readonly GroupMessage[]
  readonly selected: string
  readonly loaded: boolean
  readonly now: () => number
  readonly onJump: (message: GroupMessage) => void
}

function GroupStream({ messages, selected, loaded, now, onJump }: GroupStreamProps): React.ReactElement {
  const listRef = useRef<HTMLDivElement | null>(null)
  const stick = useRef(true)
  const visible = useMemo(
    () => (selected === ALL_THREADS ? messages : messages.filter((message) => message.threadId === selected)),
    [messages, selected]
  )
  useLayoutEffect(() => {
    const element = listRef.current
    if (element === null || !stick.current) return
    element.scrollTop = element.scrollHeight
  }, [visible])
  const onScroll = (): void => {
    const element = listRef.current
    if (element === null) return
    stick.current = element.scrollHeight - element.scrollTop - element.clientHeight <= STICK_THRESHOLD_PX
  }
  return (
    <div className="group-stream" ref={listRef} onScroll={onScroll}>
      {loaded && visible.length === 0 ? <p className="group-empty">{GROUP_UI_TEXT.emptyHint}</p> : null}
      {visible.map((message) => (
        <MessageRow key={message.id} message={message} now={now()} onJump={onJump} />
      ))}
    </div>
  )
}

/** 游標前最後一個 `@` 之後的字；沒有就回 undefined。 */
function mentionPrefix(text: string): string | undefined {
  const at = text.lastIndexOf('@')
  if (at < 0) return undefined
  const tail = text.slice(at + 1)
  return /[\s@]/.test(tail) ? undefined : tail
}

export interface GroupPaneProps {
  readonly api: GroupApi & Pick<YesChefApi, 'manageErrorIntake'>
  readonly projects: Pick<Projects, 'activate' | 'activateTab' | 'view'>
  readonly projectId: string
  /** 測試注入，預設 `Date.now`。 */
  readonly now?: () => number
  /** 打開主廚控制台並選好這個任務。 */
  readonly onOpenChef?: (taskId: string) => void
}

interface ComposerProps {
  readonly group: Group
  readonly selected: string
  readonly onOpenErrorPull?: () => void
  readonly errorPullNotice: string
}

function GroupComposer({ group, selected, onOpenErrorPull, errorPullNotice }: ComposerProps): React.ReactElement {
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const participants = useMemo(() => {
    const targetThread = selected === ALL_THREADS
      ? targetThreadForAll(group.threads)
      : group.threads.find((thread) => thread.id === selected)
    return targetThread === undefined ? [] : activeGroupParticipants(targetThread, group.messages)
  }, [group.messages, group.threads, selected])
  const prefix = mentionPrefix(text)
  const suggestions = prefix === undefined
    ? []
    : participants.filter((participant) => participant.label.startsWith(prefix) && participant.label !== prefix)
  const submit = (): void => {
    const trimmed = text.trim()
    if (trimmed === '') return
    const threadId = selected === ALL_THREADS ? GROUP_ALL_THREADS : selected
    void group.send(threadId, trimmed).then((sent) => { if (sent) setText('') })
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    submit()
  }
  const complete = (label: string): void => {
    setText((previous) => `${previous.slice(0, previous.lastIndexOf('@'))}@${label} `)
    inputRef.current?.focus()
  }
  return (
    <div className="group-composer">
      {group.error === undefined ? null : <p role="alert" className="group-error">{group.error}</p>}
      {suggestions.length === 0 ? null : (
        <div className="group-mentions" role="listbox" aria-label="群組成員">
          {suggestions.map((participant) => (
            <button key={participant.conversationId} type="button" onClick={() => complete(participant.label)}>{participant.label}</button>
          ))}
        </div>
      )}
      {errorPullNotice === '' ? null : <p role="status" className="group-pull-notice">{errorPullNotice}</p>}
      {onOpenErrorPull === undefined ? null : <button type="button" className="group-pull-open" onClick={onOpenErrorPull}>
        <Icon name="reload" />拉錯誤
      </button>}
      <textarea ref={inputRef} className="group-input" aria-label="對群組說話" rows={3}
        value={text} placeholder={GROUP_UI_TEXT.placeholder}
        onChange={(event) => setText(event.target.value)} onKeyDown={onKeyDown} />
      <div className="group-composer-bar">
        <span className="group-hint"><kbd>Enter</kbd> 送出 <span>·</span> <kbd>Shift ↵</kbd> 換行</span>
        <button type="button" className="primary" disabled={text.trim() === ''} onClick={submit}>
          <Icon name="arrow" />送出
        </button>
      </div>
    </div>
  )
}

/** 群組分頁由三段區域組成，篩選只改變訊息流的顯示。 */
interface ReconcileNoticeProps {
  readonly thread: GroupThread | undefined
  readonly onOpenChef: ((taskId: string) => void) | undefined
}

/**
 * 卡住且仍佔著工作目錄的任務需要人核對後才能接續，群組回覆不會接續它。
 * 這裡給一個直接打開主廚控制台的入口，勾選確認仍在控制台裡由人完成。
 */
function ReconcileNotice({ thread, onOpenChef }: ReconcileNoticeProps): React.ReactElement | null {
  if (thread === undefined || onOpenChef === undefined || thread.status !== 'blocked' || !thread.holdsWorkspace) return null
  return (
    <div className="chef-worker-note group-reconcile" role="status">
      <span>任務「{thread.title}」卡住，需要核對工作目錄後才能接續。</span>
      <button type="button" onClick={() => onOpenChef(thread.id)}>{GROUP_UI_TEXT.reconcileAndResume}</button>
    </div>
  )
}

export function GroupPane({ api, projects, projectId, now = Date.now, onOpenChef }: GroupPaneProps): React.ReactElement {
  const group = useGroup(api, projectId)
  const [selected, setSelected] = useState<string>(ALL_THREADS)
  const [errorIntakeEnabled, setErrorIntakeEnabled] = useState(false)
  const [errorPullOpen, setErrorPullOpen] = useState(false)
  const [errorPullNotice, setErrorPullNotice] = useState('')
  useEffect(() => {
    let active = true
    setErrorIntakeEnabled(false)
    setErrorPullOpen(false)
    setErrorPullNotice('')
    const load = (): void => {
      void api.manageErrorIntake({ action: 'project', projectId }).then((response: ErrorIntakeResponse) => {
        if (active && response.kind === 'project') setErrorIntakeEnabled(response.enabled)
      }).catch(() => { if (active) setErrorIntakeEnabled(false) })
    }
    load()
    const unsubscribe = onErrorIntakeChanged(projectId, load)
    return () => { active = false; unsubscribe() }
  }, [api, projectId])
  const jump = (message: GroupMessage): void => {
    if (message.from.kind !== 'agent') return
    const conversationId = message.from.conversationId
    const project = projects.view.projects.find((candidate) => candidate.id === projectId)
    const tabIsOpen = project?.tabs.some((tab) => tab.id === conversationId && tab.contentType === 'conversation') === true
    if (tabIsOpen) {
      projects.activate(projectId)
      projects.activateTab(conversationId, projectId)
      return
    }
    void group.openParticipant(message.threadId, conversationId)
  }
  return (
    <div className="group-pane">
      <ThreadStrip threads={group.threads} selected={selected} onSelect={setSelected} />
      <GroupStream messages={group.messages} selected={selected} loaded={group.loaded} now={now} onJump={jump} />
      <ReconcileNotice thread={selected === ALL_THREADS ? targetThreadForAll(group.threads) : group.threads.find((thread) => thread.id === selected)} onOpenChef={onOpenChef} />
      <GroupComposer group={group} selected={selected} onOpenErrorPull={errorIntakeEnabled ? () => { setErrorPullNotice(''); setErrorPullOpen(true) } : undefined} errorPullNotice={errorPullNotice} />
      {errorPullOpen ? <DialogBoundary onClose={() => setErrorPullOpen(false)}>
        <ErrorPullDialog api={api} projectId={projectId} now={now} onClose={() => setErrorPullOpen(false)}
          onStarted={() => setErrorPullNotice('錯誤修正任務已開始')} />
      </DialogBoundary> : null}
    </div>
  )
}

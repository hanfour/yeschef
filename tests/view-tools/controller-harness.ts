import { vi } from 'vitest'
import type { Mock } from 'vitest'
import { createFakeCdp, type FakeCdp } from '../helpers/fake-cdp.js'
import { manualClock } from '../helpers/manual-clock.js'
import { createViewController } from '../../src/main/view-tools/controller.js'
import type { ControllerDeps, ViewController } from '../../src/main/view-tools/controller.js'
import { createHandoff, type Handoff } from '../../src/main/view-tools/handoff.js'
import { createSettleTracker, type SettleTracker } from '../../src/main/view-tools/settle.js'
import { createWatcher, type Watcher } from '../../src/main/view-tools/watch.js'
import type { RefEntry, RefTable } from '../../src/main/view-tools/types.js'

/** 真計時器：把 microtask 與一輪 macrotask 都排空，讓 await 鏈走到下一個等待點。 */
export const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type InputListener = (event: unknown, input: { readonly type: string }) => void

export interface FakeWebContents {
  on(event: 'input-event', listener: InputListener): unknown
  off(event: 'input-event', listener: InputListener): unknown
  isDestroyed(): boolean
  getURL(): string
  getTitle(): string
  setUrl(url: string): void
  setTitle(title: string): void
  destroy(): void
  /** 模擬使用者實際操作右窗格（Electron 的 input-event）。 */
  userInput(type: string): void
}

export function createFakeWebContents(url = 'https://example.test/'): FakeWebContents {
  let currentUrl = url
  let title = '起始頁'
  let destroyed = false
  const listeners = new Set<InputListener>()
  return {
    on: (_event, listener) => listeners.add(listener),
    off: (_event, listener) => listeners.delete(listener),
    isDestroyed: () => destroyed,
    getURL: () => currentUrl,
    getTitle: () => title,
    setUrl: (next) => {
      currentUrl = next
    },
    setTitle: (next) => {
      title = next
    },
    destroy: () => {
      destroyed = true
    },
    userInput: (type) => {
      for (const listener of [...listeners]) listener({}, { type })
    },
  }
}

export interface Harness {
  readonly cdp: FakeCdp
  readonly wc: FakeWebContents
  readonly watcher: Watcher
  readonly settle: SettleTracker
  readonly handoff: Handoff
  readonly controller: ViewController
  readonly logError: Mock
  readonly signal: AbortSignal
  readonly aborter: AbortController
  advance(ms: number): void
  now(): number
}

/** 已送出的 CDP 指令，依 method 過濾。 */
export function sent(cdp: FakeCdp, method: string): { params: unknown; sessionId: string | undefined }[] {
  return (cdp.send as unknown as Mock).mock.calls
    .filter((call) => call[0] === method)
    .map((call) => ({ params: call[1] as unknown, sessionId: call[2] as string | undefined }))
}

export function refTable(snapshotId: number, entries: readonly (readonly [string, RefEntry])[]): RefTable {
  return { snapshotId, entries: new Map(entries) }
}

/**
 * watcher／settle／handoff 一律用上游真實作，只有 CdpSession 與 webContents 是假的。
 * 時間全部走 manualClock，所以逾時測試不需要真的等。
 */
export async function createHarness(
  projectDir = '/tmp/yeschef-proj',
  credentials: ControllerDeps['credentials'] = async () => undefined
): Promise<Harness> {
  const cdp = createFakeCdp()
  const clockKit = manualClock(1_000)
  const wc = createFakeWebContents()
  const logError = vi.fn()

  // createWatcher 建構時做裁決 5 的三個 enable。
  for (const method of ['DOM.enable', 'Network.enable', 'Accessibility.enable']) {
    cdp.onSend(method, () => ({}))
  }

  const watcher = await createWatcher({ cdp, webContents: wc, logError })
  const settle = createSettleTracker(cdp, clockKit.clock)
  const handoff = createHandoff(clockKit.clock, logError)
  const aborter = new AbortController()
  const controller = createViewController({
    cdp,
    webContents: wc,
    watcher,
    settle,
    handoff,
    clock: clockKit.clock,
    projectDir: () => projectDir,
    logError,
    credentials,
  })

  return {
    cdp,
    wc,
    watcher,
    settle,
    handoff,
    controller,
    logError,
    aborter,
    signal: aborter.signal,
    advance: clockKit.advance,
    now: clockKit.now,
  }
}

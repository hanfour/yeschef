import { describe, expect, it, vi } from 'vitest'
import type { WebContents, WebContentsView } from 'electron'
import type { MergerClock } from '../../src/main/agent-host.js'
import type { AttachCdpOptions, CdpSession } from '../../src/main/cdp.js'
import type { ViewToolDeps, ViewTools } from '../../src/main/view-tools/server.js'
import { manualClock } from '../helpers/manual-clock.js'
import {
  ATTACH_CDP_TIMEOUT_MS,
  VIEW_TOOLS_DISABLED_PREFIX,
  startViewTools,
  type ViewToolStartupDeps,
} from '../../src/main/view-tools/startup.js'

interface Rig {
  readonly deps: ViewToolStartupDeps
  readonly calls: string[]
  readonly logged: Error[]
  readonly warned: string[]
  readonly created: ViewToolDeps[]
  readonly attachOpts: AttachCdpOptions[]
  readonly view: WebContentsView
  readonly cdp: CdpSession
  readonly viewTools: ViewTools
  readonly clock: MergerClock
  readonly advance: (ms: number) => void
}

interface RigOptions {
  readonly attachFails?: unknown
  readonly attachHangs?: boolean
  readonly createFails?: unknown
  readonly detachFails?: unknown
  readonly disposeFails?: unknown
}

function setup(options: RigOptions = {}): Rig {
  const calls: string[] = []
  const logged: Error[] = []
  const warned: string[] = []
  const created: ViewToolDeps[] = []
  const attachOpts: AttachCdpOptions[] = []
  const clockKit = manualClock()
  const webContents = { id: 7 } as unknown as WebContents
  const view = { webContents } as unknown as WebContentsView

  const cdp = {
    send: () => Promise.reject(new Error('未使用')),
    detach: () => {
      calls.push('cdp.detach')
      if (options.detachFails !== undefined) throw options.detachFails
    },
    getAttachedTargets: () => [],
    getRearmErrors: () => [],
    onEvent: () => () => {},
  } as unknown as CdpSession

  const viewTools: ViewTools = {
    invoke: () => Promise.reject(new Error('startup 測試不該叫 invoke')),
    handoffDone: () => {},
    abortPending: () => {},
    busy: () => false,
    dispose: () => {
      calls.push('viewTools.dispose')
      return options.disposeFails === undefined
        ? Promise.resolve()
        : Promise.reject(options.disposeFails)
    },
  }

  const deps: ViewToolStartupDeps = {
    view,
    clock: clockKit.clock,
    projectDir: () => '/proj',
    logError: (error) => logged.push(error),
    warn: (line) => warned.push(line),
    credentials: async () => undefined,
    attach: (wc, opts) => {
      calls.push(`attach(${(wc as unknown as { id: number }).id})`)
      attachOpts.push(opts)
      if (options.attachHangs === true) return new Promise<CdpSession>(() => {})
      return options.attachFails === undefined ? Promise.resolve(cdp) : Promise.reject(options.attachFails)
    },
    create: (createDeps) => {
      calls.push('create')
      created.push(createDeps)
      return options.createFails === undefined
        ? Promise.resolve(viewTools)
        : Promise.reject(options.createFails)
    },
  }

  return { deps, calls, logged, warned, created, attachOpts, view, cdp, viewTools, clock: clockKit.clock, advance: clockKit.advance }
}

describe('契約 §13：成功路徑', () => {
  it('成功時 viewTools 是 create 回來的那一個', async () => {
    const rig = setup()
    const startup = await startViewTools(rig.deps)

    expect(startup.viewTools).toBe(rig.viewTools)
    expect(rig.warned).toEqual([])
    expect(rig.logged).toEqual([])
  })

  it('create 拿到的是 attach 回來的那一個 cdp，attach 拿到 onListenerError', async () => {
    const rig = setup()
    await startViewTools(rig.deps)

    expect(rig.calls).toEqual(['attach(7)', 'create'])
    expect(rig.created).toHaveLength(1)
    expect(rig.created[0]?.cdp).toBe(rig.cdp)
    expect(rig.created[0]?.view).toBe(rig.view)
    expect(rig.created[0]?.clock).toBe(rig.clock)
    expect(rig.created[0]?.projectDir()).toBe('/proj')
    expect(rig.created[0]?.logError).toBe(rig.deps.logError)
    expect(rig.attachOpts[0]?.onListenerError).toBe(rig.deps.logError)
  })

  it('onBusyChange 原樣交給 create', async () => {
    const rig = setup()
    const onBusyChange = vi.fn()
    await startViewTools({ ...rig.deps, onBusyChange })

    expect(rig.created[0]?.onBusyChange).toBe(onBusyChange)
  })

  it('credentials 原樣交給 create', async () => {
    const rig = setup()
    const credentials = async () => undefined
    await startViewTools({ ...rig.deps, credentials })

    expect(rig.created[0]?.credentials).toBe(credentials)
  })

  it('dispose 先收 viewTools 再 detach cdp', async () => {
    const rig = setup()
    const startup = await startViewTools(rig.deps)
    rig.calls.length = 0
    await startup.dispose()
    await startup.dispose()

    expect(rig.calls).toEqual(['viewTools.dispose', 'cdp.detach'])
  })

  it('viewTools.dispose 失敗時仍 detach，且原錯誤往外傳', async () => {
    const rig = setup({ disposeFails: new Error('工具收尾失敗') })
    const startup = await startViewTools(rig.deps)
    rig.calls.length = 0

    await expect(startup.dispose()).rejects.toThrow('工具收尾失敗')

    expect(rig.calls).toEqual(['viewTools.dispose', 'cdp.detach'])
  })
})

describe('裁決 17／34：attachCdp 失敗', () => {
  it('不建 view tools、不 detach，viewTools 是 undefined', async () => {
    const rig = setup({ attachFails: new Error('debugger 已被佔用') })
    const startup = await startViewTools(rig.deps)

    expect(startup.viewTools).toBeUndefined()
    expect(rig.calls).toEqual(['attach(7)'])
    expect(rig.warned).toEqual([`${VIEW_TOOLS_DISABLED_PREFIX}debugger 已被佔用`])
    expect(rig.logged.map((e) => e.message)).toEqual(['debugger 已被佔用'])
  })

  it('dispose 是 no-op：沒有 cdp 可以 detach', async () => {
    const rig = setup({ attachFails: new Error('debugger 已被佔用') })
    const startup = await startViewTools(rig.deps)
    rig.calls.length = 0
    await startup.dispose()
    await startup.dispose()

    expect(rig.calls).toEqual([])
  })

  it('丟出的不是 Error 時照樣印得出訊息', async () => {
    const rig = setup({ attachFails: 'debugger 沒回應' })
    await startViewTools(rig.deps)

    expect(rig.warned).toEqual([`${VIEW_TOOLS_DISABLED_PREFIX}debugger 沒回應`])
    expect(rig.logged[0]).toBeInstanceOf(Error)
    expect(rig.logged[0]?.message).toBe('debugger 沒回應')
  })
})

describe('裁決 34：createViewToolServer 失敗', () => {
  it('先 detach cdp 再走無工具路徑', async () => {
    const rig = setup({ createFails: new Error('Accessibility.enable 失敗') })
    const startup = await startViewTools(rig.deps)

    expect(startup.viewTools).toBeUndefined()
    expect(rig.calls).toEqual(['attach(7)', 'create', 'cdp.detach'])
    expect(rig.warned).toEqual([`${VIEW_TOOLS_DISABLED_PREFIX}Accessibility.enable 失敗`])
  })

  it('detach 自己也丟例外時兩個錯誤都記下來，順序是先啟動失敗後收尾失敗', async () => {
    const rig = setup({
      createFails: new Error('Accessibility.enable 失敗'),
      detachFails: new Error('debugger 已 detach'),
    })
    const startup = await startViewTools(rig.deps)

    expect(rig.logged.map((e) => e.message)).toEqual(['Accessibility.enable 失敗', 'debugger 已 detach'])
    expect(startup.viewTools).toBeUndefined()
  })

  it('dispose 不會第二次 detach', async () => {
    const rig = setup({ createFails: new Error('Accessibility.enable 失敗') })
    const startup = await startViewTools(rig.deps)
    rig.calls.length = 0
    await startup.dispose()

    expect(rig.calls).toEqual([])
  })
})

describe('裁決 17：attachCdp 逾時', () => {
  it('attach 永遠 pending 時依注入時鐘走無工具路徑', async () => {
    const rig = setup({ attachHangs: true })
    const pending = startViewTools(rig.deps)

    rig.advance(ATTACH_CDP_TIMEOUT_MS)
    const startup = await pending

    expect(startup.viewTools).toBeUndefined()
    expect(rig.calls).toEqual(['attach(7)'])
    expect(rig.warned).toEqual([
      `${VIEW_TOOLS_DISABLED_PREFIX}CDP 附著逾時（${ATTACH_CDP_TIMEOUT_MS} 毫秒）`,
    ])
    expect(rig.logged.map((error) => error.message)).toEqual([
      `CDP 附著逾時（${ATTACH_CDP_TIMEOUT_MS} 毫秒）`,
    ])
  })
})

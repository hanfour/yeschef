import { WebSocket } from 'ws'
import { describe, it, expect, vi } from 'vitest'
import {
  createOwnClientTracker,
  findInPath,
  handleConnection,
  isValidTerminalToken,
  isAllowedOrigin,
  killTmuxSession,
  startTerminalServer,
  tmuxSessionName,
  type PtyLike,
  type ResolveCwd,
  type SocketLike,
  type SpawnPty,
} from '../src/main/terminal-server.js'

function fakePty() {
  let dataCb = (_data: string): void => {}
  let exitCb = (_event: { exitCode: number }): void => {}
  let writes: readonly string[] = []
  let resizes: readonly (readonly number[])[] = []
  let killed = false
  return {
    pid: 123,
    get writes() { return writes }, get resizes() { return resizes }, get killed() { return killed },
    dataCb: (data: string) => dataCb(data), exitCb: (event: { exitCode: number }) => exitCb(event),
    onData: (cb: (data: string) => void) => { dataCb = cb },
    onExit: (cb: (event: { exitCode: number }) => void) => { exitCb = cb },
    write: (data: string) => { writes = [...writes, data] },
    resize: (cols: number, rows: number) => { resizes = [...resizes, [cols, rows]] },
    kill: () => { killed = true },
  } satisfies PtyLike & { readonly writes: readonly string[]; readonly resizes: readonly (readonly number[])[]; readonly killed: boolean; dataCb(data: string): void; exitCb(event: { exitCode: number }): void }
}

function fakeSocket() {
  let msgCb = (_raw: string): void => {}
  let closeCb = (): void => {}
  let sent: readonly string[] = []
  let closed = false
  return {
    get sent() { return sent }, get closed() { return closed },
    msgCb: (raw: string) => msgCb(raw), closeCb: () => closeCb(),
    on: (event: 'message' | 'close', cb: (raw: string) => void) => {
      if (event === 'message') msgCb = cb
      else closeCb = () => cb('')
    },
    send: (text: string) => { sent = [...sent, text] },
    close: () => { closed = true },
  }
}

const noop = () => {}
/** 登錄表只認得 p1;其他 id 一律查不到 */
const resolveCwd: ResolveCwd = (id) => (id === 'p1' ? '/proj' : undefined)
const OPEN = { type: 'open', cols: 80, rows: 24, projectId: 'p1', tabId: 'tab-0001-aaaa' }
/** 沒有 tmux 的環境:PATH 查不到任何東西 */
const noTmux = () => false

function connectWebSocket(url: string): Promise<{ accepted: boolean; statusCode?: number }> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url)
    const timeout = setTimeout(() => {
      socket.terminate()
      resolve({ accepted: false })
    }, 2000)
    const finish = (result: { accepted: boolean; statusCode?: number }): void => {
      clearTimeout(timeout)
      resolve(result)
    }
    socket.once('unexpected-response', (_request, response) => {
      finish({ accepted: false, statusCode: response.statusCode })
      socket.terminate()
    })
    socket.once('error', () => finish({ accepted: false }))
    socket.once('open', () => {
      socket.close()
      socket.once('close', () => finish({ accepted: true }))
    })
  })
}

describe('isValidTerminalToken', () => {
  it('只接受相同且非空的 token', () => {
    expect(isValidTerminalToken('right-token', 'right-token')).toBe(true)
    expect(isValidTerminalToken('wrong-token', 'right-token')).toBe(false)
    expect(isValidTerminalToken(null, 'right-token')).toBe(false)
    expect(isValidTerminalToken(undefined, 'right-token')).toBe(false)
    expect(isValidTerminalToken('short', 'right-token')).toBe(false)
    expect(isValidTerminalToken('', 'right-token')).toBe(false)
  })
})

describe('startTerminalServer 認證', () => {
  it('缺 token 與錯 token 拒絕升級,正確 token 才能連線', async () => {
    const server = await startTerminalServer(resolveCwd, noop)
    try {
      const base = `ws://127.0.0.1:${server.port}/`
      expect(server.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
      for (const url of [base, `${base}?token=wrong`]) {
        const result = await connectWebSocket(url)
        expect(result.accepted).toBe(false)
        if (result.statusCode !== undefined) expect(result.statusCode).toBe(401)
      }
      expect((await connectWebSocket(`${base}?token=${encodeURIComponent(server.token)}`)).accepted).toBe(true)
    } finally {
      await server.close()
    }
  }, 10000)
})

describe('isAllowedOrigin', () => {
  it('放行本機 renderer 的 origin 與無 origin 連線', () => {
    expect(isAllowedOrigin(undefined)).toBe(true)
    expect(isAllowedOrigin('')).toBe(true)
    expect(isAllowedOrigin('null')).toBe(true)
    expect(isAllowedOrigin('file://')).toBe(true)
    expect(isAllowedOrigin('http://localhost:5173')).toBe(true)
    expect(isAllowedOrigin('http://127.0.0.1:3000')).toBe(true)
  })

  it('拒絕外部來源與無法解析的 origin', () => {
    expect(isAllowedOrigin('https://evil.com')).toBe(false)
    expect(isAllowedOrigin('http://example.com')).toBe(false)
    expect(isAllowedOrigin('亂字串')).toBe(false)
  })
})

describe('handleConnection', () => {
  it('open 用 projectId 查到的 cwd 與給的 cols/rows spawn,command 寫進 pty 帶 \\r', () => {
    const socket = fakeSocket(); const pty = fakePty()
    const spawn: SpawnPty = vi.fn(() => pty)
    handleConnection(socket, spawn, resolveCwd, noop, noTmux)
    socket.msgCb(JSON.stringify({ ...OPEN, cols: 100, rows: 30, command: 'codex' }))
    expect(spawn).toHaveBeenCalledWith({ cols: 100, rows: 30, cwd: '/proj', shell: expect.any(String), args: [] })
    expect(pty.writes).toEqual(['codex\r'])
  })

  it('open 帶不認得的 projectId:log、送 exit 1、關 socket,不 spawn', () => {
    const socket = fakeSocket(); const logError = vi.fn()
    const spawn: SpawnPty = vi.fn(() => fakePty())
    handleConnection(socket, spawn, resolveCwd, logError)
    socket.msgCb(JSON.stringify({ ...OPEN, projectId: 'nope' }))
    expect(spawn).not.toHaveBeenCalled()
    expect(socket.sent).toEqual([JSON.stringify({ type: 'exit', code: 1 })])
    expect(socket.closed).toBe(true)
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError.mock.calls[0]?.[0]?.message).toBe('終端機 open 的 projectId 不合法或不認得(nope),已拒絕')
  })

  it('open 缺 projectId 或 projectId 不是字串:同樣拒絕,不退回預設目錄', () => {
    for (const bad of [{ type: 'open', cols: 80, rows: 24 }, { ...OPEN, projectId: 42 }]) {
      const socket = fakeSocket(); const logError = vi.fn()
      const spawn: SpawnPty = vi.fn(() => fakePty())
      handleConnection(socket, spawn, resolveCwd, logError)
      socket.msgCb(JSON.stringify(bad))
      expect(spawn).not.toHaveBeenCalled()
      expect(socket.sent).toEqual([JSON.stringify({ type: 'exit', code: 1 })])
      expect(socket.closed).toBe(true)
      expect(logError).toHaveBeenCalledTimes(1)
    }
  })

  it('被拒絕的連線之後再送訊息仍不會 spawn', () => {
    const socket = fakeSocket()
    const spawn: SpawnPty = vi.fn(() => fakePty())
    handleConnection(socket, spawn, resolveCwd, noop)
    socket.msgCb(JSON.stringify({ ...OPEN, projectId: 'nope' }))
    socket.msgCb(JSON.stringify({ type: 'input', data: 'ls\r' }))
    socket.msgCb(JSON.stringify(OPEN))
    expect(spawn).not.toHaveBeenCalled()
    expect(socket.sent).toHaveLength(1)
  })

  it('open 之前的訊息一律忽略', () => {
    const socket = fakeSocket(); const spawn: SpawnPty = vi.fn(() => fakePty())
    handleConnection(socket, spawn, resolveCwd, noop)
    socket.msgCb(JSON.stringify({ type: 'input', data: 'x' }))
    expect(spawn).not.toHaveBeenCalled()
  })

  it('open 後 input 寫進 pty、resize 呼叫 pty.resize', () => {
    const socket = fakeSocket(); const pty = fakePty()
    handleConnection(socket, () => pty, resolveCwd, noop)
    socket.msgCb(JSON.stringify(OPEN))
    socket.msgCb(JSON.stringify({ type: 'input', data: 'ls\r' }))
    socket.msgCb(JSON.stringify({ type: 'resize', cols: 90, rows: 20 }))
    expect(pty.writes).toEqual(['ls\r'])
    expect(pty.resizes).toEqual([[90, 20]])
  })

  it('open 與 resize 的 cols、rows 都夾在 1 到 500', () => {
    const socket = fakeSocket(); const pty = fakePty()
    const spawn: SpawnPty = vi.fn(() => pty)
    handleConnection(socket, spawn, resolveCwd, noop, noTmux)
    socket.msgCb(JSON.stringify({ ...OPEN, cols: 0, rows: 900 }))
    socket.msgCb(JSON.stringify({ type: 'resize', cols: -5, rows: 501 }))
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ cols: 1, rows: 500 }))
    expect(pty.resizes).toEqual([[1, 500]])
  })

  it('open 的 command 超過 4096 字元時拒絕並記錄錯誤', () => {
    const socket = fakeSocket(); const logError = vi.fn()
    const spawn: SpawnPty = vi.fn(() => fakePty())
    handleConnection(socket, spawn, resolveCwd, logError, noTmux)
    socket.msgCb(JSON.stringify({ ...OPEN, command: 'x'.repeat(4097) }))
    expect(spawn).not.toHaveBeenCalled()
    expect(socket.closed).toBe(true)
    expect(logError).toHaveBeenCalledTimes(1)
  })

  it('pty 輸出送成 output,結束送 exit 再關 socket', () => {
    const socket = fakeSocket(); const pty = fakePty()
    handleConnection(socket, () => pty, resolveCwd, noop)
    socket.msgCb(JSON.stringify(OPEN))
    pty.dataCb('hello')
    expect(socket.sent).toContain(JSON.stringify({ type: 'output', data: 'hello' }))
    pty.exitCb({ exitCode: 0 })
    expect(socket.sent).toContain(JSON.stringify({ type: 'exit', code: 0 }))
    expect(socket.closed).toBe(true)
  })

  it('socket 關閉時 kill pty', () => {
    const socket = fakeSocket(); const pty = fakePty()
    handleConnection(socket, () => pty, resolveCwd, noop)
    socket.msgCb(JSON.stringify(OPEN))
    socket.closeCb()
    expect(pty.killed).toBe(true)
  })

  it('pty spawn 失敗時送 exit、關 socket、log 錯誤且維持未開啟', () => {
    const socket = fakeSocket(); const pty = fakePty(); const logError = vi.fn()
    const spawn: SpawnPty = () => { throw 'spawn failed' }
    handleConnection(socket, spawn, resolveCwd, logError)
    socket.msgCb(JSON.stringify(OPEN))
    expect(socket.sent).toEqual([JSON.stringify({ type: 'exit', code: 1 })])
    expect(socket.closed).toBe(true)
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError.mock.calls[0]?.[0]).toBeInstanceOf(Error)
    expect(() => socket.msgCb(JSON.stringify({ type: 'input', data: 'ls\r' }))).not.toThrow()
    expect(pty.writes).toEqual([])
  })

  it('壞訊息 log 後忽略,不關連線', () => {
    const socket = fakeSocket(); const logError = vi.fn()
    handleConnection(socket, () => fakePty(), resolveCwd, logError)
    socket.msgCb('這不是 json')
    socket.msgCb(JSON.stringify({ nope: 1 }))
    expect(socket.closed).toBe(false)
    expect(logError).toHaveBeenCalled()
  })
})

describe('findInPath', () => {
  it('PATH 任一段找到就算存在', () => {
    const exists = (p: string) => p === '/usr/local/bin/tmux'
    expect(findInPath('tmux', '/bin:/usr/local/bin', exists)).toBe(true)
  })

  it('PATH 都找不到就是不存在', () => {
    expect(findInPath('grok', '/bin:/usr/bin', () => false)).toBe(false)
  })

  it('沒有 PATH 就是不存在', () => {
    expect(findInPath('grok', undefined, () => true)).toBe(false)
  })

  it('帶斜線的指令直接檢查該路徑,不併 PATH', () => {
    const exists = (p: string) => p === './bin/tool'
    expect(findInPath('./bin/tool', '/bin', exists)).toBe(true)
    expect(findInPath('./bin/missing', '/bin', exists)).toBe(false)
  })
})

describe('handleConnection 的缺裝提示', () => {
  it('指令不在 PATH 時先送繁中提示,指令仍照送', () => {
    const socket = fakeSocket(); const pty = fakePty()
    handleConnection(socket, () => pty, resolveCwd, noop, () => false)
    socket.msgCb(JSON.stringify({ ...OPEN, command: 'grok' }))
    const hint = socket.sent.find((t: string) => t.includes('找不到'))
    expect(hint).toBeTruthy()
    expect(JSON.parse(hint ?? '{}').type).toBe('output')
    expect(JSON.parse(hint ?? '{}').data).toContain('grok')
    expect(pty.writes).toEqual(['grok\r'])
  })

  it('指令在 PATH 時不送提示', () => {
    const socket = fakeSocket(); const pty = fakePty()
    handleConnection(socket, () => pty, resolveCwd, noop, () => true)
    socket.msgCb(JSON.stringify({ ...OPEN, command: 'codex' }))
    expect(socket.sent.filter((t: string) => t.includes('找不到'))).toEqual([])
    expect(pty.writes).toEqual(['codex\r'])
  })

  it('查的是指令第一個詞,不含參數', () => {
    const socket = fakeSocket(); const pty = fakePty()
    const commandExists = vi.fn(() => true)
    handleConnection(socket, () => pty, resolveCwd, noop, commandExists)
    socket.msgCb(JSON.stringify({ ...OPEN, command: 'claude --resume' }))
    expect(commandExists).toHaveBeenCalledWith('claude')
  })
})

describe('tmux 接線', () => {
  const tmuxPresent = (cmd: string) => cmd === 'tmux'

  it('session 名字從 tabId 取前 8 碼,重開 app 後同一個分頁拿到同一個名字', () => {
    expect(tmuxSessionName('tab-0001-aaaa-bbbb')).toBe('sp-tab-0001')
    expect(tmuxSessionName('abcdefgh-1234')).toBe('sp-abcdefgh')
  })

  it('有 tmux 且 session 不存在:spawn tmux new -A,快捷指令照送', () => {
    const socket = fakeSocket(); const pty = fakePty()
    const spawn: SpawnPty = vi.fn(() => pty)
    handleConnection(socket, spawn, resolveCwd, noop, tmuxPresent, () => false)
    socket.msgCb(JSON.stringify({ ...OPEN, command: 'claude' }))
    expect(spawn).toHaveBeenCalledWith({
      cols: 80, rows: 24, cwd: '/proj', shell: 'tmux', args: ['new', '-A', '-s', 'sp-tab-0001'],
    })
    expect(pty.writes).toEqual(['claude\r'])
  })

  it('有 tmux 且 session 已存在:attach 回去,快捷指令不重送(還原不重跑舊指令)', () => {
    const socket = fakeSocket(); const pty = fakePty()
    const spawn: SpawnPty = vi.fn(() => pty)
    handleConnection(socket, spawn, resolveCwd, noop, tmuxPresent, () => true)
    socket.msgCb(JSON.stringify({ ...OPEN, command: 'claude' }))
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ shell: 'tmux', args: ['new', '-A', '-s', 'sp-tab-0001'] }))
    expect(pty.writes).toEqual([])
  })

  it('沒有 tmux:起裸 shell,並先送一行提示', () => {
    const socket = fakeSocket(); const pty = fakePty()
    const spawn: SpawnPty = vi.fn(() => pty)
    handleConnection(socket, spawn, resolveCwd, noop, noTmux)
    socket.msgCb(JSON.stringify(OPEN))
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ args: [], shell: expect.not.stringMatching(/^tmux$/) }))
    const notice = socket.sent.map((t: string) => JSON.parse(t)).find((m: { type?: string; data?: string }) => m.type === 'output')
    expect(notice?.data).toContain('未安裝 tmux')
  })

  it('open 缺 tabId:拒絕,不 spawn', () => {
    const socket = fakeSocket(); const logError = vi.fn()
    const spawn: SpawnPty = vi.fn(() => fakePty())
    handleConnection(socket, spawn, resolveCwd, logError, tmuxPresent, () => false)
    const { tabId: _t, ...noTab } = OPEN
    socket.msgCb(JSON.stringify(noTab))
    expect(spawn).not.toHaveBeenCalled()
    expect(socket.closed).toBe(true)
    expect(logError.mock.calls[0]?.[0]?.message).toContain('tabId')
  })

  it('往上滾之後打字:先叫 tmux 離開捲動模式,再把按鍵寫進 pty', () => {
    const socket = fakeSocket(); const pty = fakePty()
    let order: readonly string[] = []
    const cancel = vi.fn((name: string) => { order = [...order, `cancel ${name}`] })
    const tracked = { ...pty, write: (data: string) => { order = [...order, `write ${JSON.stringify(data)}`]; pty.write(data) } }
    handleConnection(socket, () => tracked, resolveCwd, noop, tmuxPresent, () => true, cancel)
    socket.msgCb(JSON.stringify(OPEN))
    socket.msgCb(JSON.stringify({ type: 'input', data: '\x1b[<64;10;5M' }))
    socket.msgCb(JSON.stringify({ type: 'input', data: 'l' }))
    socket.msgCb(JSON.stringify({ type: 'input', data: 's' }))
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(order).toEqual([`write ${JSON.stringify('\x1b[<64;10;5M')}`, 'cancel sp-tab-0001', 'write "l"', 'write "s"'])
  })

  it('沒有 tmux 時不叫 cancel,離開捲動模式失敗也照樣送出按鍵', () => {
    const socket = fakeSocket(); const pty = fakePty()
    const cancel = vi.fn()
    handleConnection(socket, () => pty, resolveCwd, noop, noTmux, () => false, cancel)
    socket.msgCb(JSON.stringify(OPEN))
    socket.msgCb(JSON.stringify({ type: 'input', data: '\x1b[<64;10;5M' }))
    socket.msgCb(JSON.stringify({ type: 'input', data: 'l' }))
    expect(cancel).not.toHaveBeenCalled()

    const tmuxSocket = fakeSocket(); const tmuxPty = fakePty()
    handleConnection(tmuxSocket, () => tmuxPty, resolveCwd, noop, tmuxPresent, () => true, () => { throw new Error('not in a mode') })
    tmuxSocket.msgCb(JSON.stringify(OPEN))
    tmuxSocket.msgCb(JSON.stringify({ type: 'input', data: '\x1b[<64;10;5M' }))
    tmuxSocket.msgCb(JSON.stringify({ type: 'input', data: 'l' }))
    expect(tmuxPty.writes).toEqual(['\x1b[<64;10;5M', 'l'])
  })

  it('killTmuxSession 用同一個命名規則下 kill-session,失敗不丟', () => {
    let runs: readonly (readonly string[])[] = []
    killTmuxSession('tab-0001-aaaa', (args) => { runs = [...runs, args] })
    expect(runs).toEqual([['kill-session', '-t', 'sp-tab-0001']])
    expect(() => killTmuxSession('x', () => { throw new Error('no server') })).not.toThrow()
  })
})


describe('自己的 tmux client PID', () => {
  it('只追蹤 tmux,直到 exit 才移除,舊快照不受更新影響', () => {
    let exits: readonly (() => void)[] = []
    let pid = 100
    const tracker = createOwnClientTracker(() => ({
      pid: pid++, onExit: (cb) => { exits = [...exits, () => cb({ exitCode: 0 })] },
      onData: noop, write: noop, resize: noop, kill: noop,
    }))
    const opts = { cols: 80, rows: 24, cwd: '/proj', shell: 'tmux', args: [] }
    const first = tracker.spawn(opts)
    const snapshot = tracker.ownClientPids()
    tracker.spawn(opts)
    tracker.spawn({ ...opts, shell: 'zsh' })
    expect(tracker.ownClientPids()).toEqual(new Set([100, 101]))
    expect(snapshot).toEqual(new Set([100]))
    first.kill()
    expect(tracker.ownClientPids()).toEqual(new Set([100, 101]))
    exits[0]?.()
    expect(tracker.ownClientPids()).toEqual(new Set([101]))
    exits[1]?.()
    expect(tracker.ownClientPids()).toEqual(new Set())
    expect(snapshot).toEqual(new Set([100]))
  })

  it('spawn 失敗不留下 PID', () => {
    const tracker = createOwnClientTracker(() => { throw new Error('spawn failed') })
    expect(() => tracker.spawn({ cols: 80, rows: 24, cwd: '/proj', shell: 'tmux', args: [] })).toThrow('spawn failed')
    expect(tracker.ownClientPids()).toEqual(new Set())
  })
})

import { WebSocketServer, type WebSocket } from 'ws'
import * as nodePty from 'node-pty'
import * as crypto from 'node:crypto'
import { accessSync, constants } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { createCopyModeGuard } from './tmux-copy-mode.js'

/**
 * 查一個指令在不在 PATH。抽成純函式以便測試。
 * 帶斜線的當成路徑直接查,不併 PATH。
 */
export function findInPath(
  command: string,
  pathEnv: string | undefined,
  isExecutable: (p: string) => boolean
): boolean {
  if (command.includes('/')) return isExecutable(command)
  if (pathEnv === undefined || pathEnv.length === 0) return false
  return pathEnv.split(':').some((dir) => dir.length > 0 && isExecutable(join(dir, command)))
}

const realCommandExists = (command: string): boolean =>
  findInPath(command, process.env['PATH'], (p) => {
    try {
      accessSync(p, constants.X_OK)
      return true
    } catch {
      return false
    }
  })

const MIN_TERMINAL_DIMENSION = 1
const MAX_TERMINAL_DIMENSION = 500
const MAX_COMMAND_LENGTH = 4096

function terminalDimension(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback
  return Math.max(MIN_TERMINAL_DIMENSION, Math.min(MAX_TERMINAL_DIMENSION, Math.trunc(value)))
}

export function isValidTerminalToken(candidate: string | null | undefined, expected: string): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length !== expected.length) return false
  const actual = Buffer.from(candidate, 'utf8')
  const known = Buffer.from(expected, 'utf8')
  if (actual.byteLength !== known.byteLength) return false
  return crypto.timingSafeEqual(actual, known)
}

export interface PtyLike {
  readonly pid: number
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

export interface SocketLike {
  on(event: 'message', cb: (raw: string) => void): void
  on(event: 'close', cb: () => void): void
  send(text: string): void
  close(): void
}

export interface SpawnPtyOptions {
  cols: number
  rows: number
  cwd: string
  shell: string
  /** 給 shell 的引數。裸 shell 是空陣列;tmux 是 `new -A -s <名字>`。 */
  args: readonly string[]
}
export type SpawnPty = (opts: SpawnPtyOptions) => PtyLike

/** 由 projectId 查該專案的根目錄;查不到回 undefined,由呼叫端拒絕連線 */
export type ResolveCwd = (projectId: string) => string | undefined

/** tmux session 名字。tabId 是狀態檔裡持久化的 UUID,重開 app 後同一個分頁拿到同一個名字,`new -A` 就接回原本的 session。 */
export function tmuxSessionName(tabId: string): string {
  return 'sp-' + tabId.slice(0, 8)
}

const TMUX = 'tmux'

/** `tmux has-session` 的 exit code:0 存在、1 不存在。抽成可注入的函式,測試不必真的有 tmux。 */
const realHasTmuxSession = (name: string): boolean => {
  try {
    execFileSync(TMUX, ['has-session', '-t', name], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const realRunTmux = (args: readonly string[]): void => {
  execFileSync(TMUX, [...args], { stdio: 'ignore' })
}

/** 同步執行：cancel 要在按鍵寫進 pty 之前生效，不然第一個字還是被捲動模式吃掉。 */
const realCancelCopyMode = (name: string): void => {
  realRunTmux(['send-keys', '-t', name, '-X', 'cancel'])
}

/**
 * 使用者關掉分頁或移除專案時收掉對應的 tmux session。best-effort:tmux 沒裝、
 * session 早就不在、tmux server 沒起來,都不是錯誤,分頁本來就要關。
 */
export function killTmuxSession(tabId: string, run: (args: readonly string[]) => void = realRunTmux): void {
  try {
    run(['kill-session', '-t', tmuxSessionName(tabId)])
  } catch {
    /* 見上方說明 */
  }
}

export function handleConnection(
  socket: SocketLike,
  spawn: SpawnPty,
  resolveCwd: ResolveCwd,
  logError: (e: Error) => void,
  commandExists: (command: string) => boolean = realCommandExists,
  hasTmuxSession: (name: string) => boolean = realHasTmuxSession,
  cancelCopyMode: (name: string) => void = realCancelCopyMode
): void {
  let pty: PtyLike | null = null
  let beforeInput: (data: string) => void = () => {}
  let rejected = false
  const shell = process.env.SHELL ?? 'zsh'

  const reject = (error: Error): void => {
    rejected = true
    logError(error)
    socket.send(JSON.stringify({ type: 'exit', code: 1 }))
    socket.close()
  }

  socket.on('message', (raw) => {
    if (rejected) return // 被拒絕的連線之後的訊息一律忽略,不會再次嘗試 spawn
    let msg: unknown
    try {
      msg = JSON.parse(raw)
    } catch {
      logError(new Error('終端機收到非 JSON 訊息,已忽略'))
      return
    }
    if (typeof msg !== 'object' || msg === null || !('type' in msg)) {
      logError(new Error('終端機收到缺 type 的訊息,已忽略'))
      return
    }
    const m = msg as { type: string; [k: string]: unknown }

    if (m.type === 'open') {
      if (pty !== null) return
      if (typeof m.command === 'string' && m.command.length > MAX_COMMAND_LENGTH) {
        reject(new Error('終端機 open 的 command 超過 4096 字元,已拒絕'))
        return
      }
      // 規格 §3.1:renderer 只送 id,cwd 由主行程查表決定;查不到不退回任何預設目錄(§6)。
      const cwd = typeof m.projectId === 'string' ? resolveCwd(m.projectId) : undefined
      if (cwd === undefined) {
        reject(new Error(`終端機 open 的 projectId 不合法或不認得(${String(m.projectId)}),已拒絕`))
        return
      }
      if (typeof m.tabId !== 'string' || m.tabId.length === 0) {
        reject(new Error('終端機 open 缺 tabId,已拒絕'))
        return
      }
      const cols = terminalDimension(m.cols, 80)
      const rows = terminalDimension(m.rows, 24)
      // roadmap 第 4 項:程序存活交給 tmux。pty 起的是 tmux client,socket 斷了只殺 client,
      // session 活在 tmux server 裡,重開 app 用同一個名字 new -A 就接回來(RESULTS-07)。
      const useTmux = commandExists(TMUX)
      const sessionName = tmuxSessionName(m.tabId)
      // 只有新建 session 才送快捷指令:attach 回既有 session 時再送一次等於重跑舊指令。
      const sendCommand = !useTmux || !hasTmuxSession(sessionName)
      try {
        pty = useTmux
          ? spawn({ cols, rows, cwd, shell: TMUX, args: ['new', '-A', '-s', sessionName] })
          : spawn({ cols, rows, cwd, shell, args: [] })
      } catch (cause) {
        reject(cause instanceof Error ? cause : new Error(String(cause)))
        return
      }
      pty.onData((data) => socket.send(JSON.stringify({ type: 'output', data })))
      pty.onExit(({ exitCode }) => {
        socket.send(JSON.stringify({ type: 'exit', code: exitCode }))
        socket.close()
      })
      if (useTmux) {
        beforeInput = createCopyModeGuard(() => {
          try {
            cancelCopyMode(sessionName)
          } catch {
            /* 已經不在捲動模式（例如滾回底部時 tmux 自己離開了），按鍵照送 */
          }
        })
      } else {
        socket.send(JSON.stringify({ type: 'output', data: '\r\n[yeschef] 未安裝 tmux,此分頁關閉後工作不保留。\r\n' }))
      }
      if (sendCommand && typeof m.command === 'string' && m.command.length > 0) {
        // 快捷指令沒裝時,先給一行繁中提示再照送:有 shell 別名的情況仍能正常執行。
        const bin = m.command.trim().split(/\s+/)[0] ?? ''
        if (bin.length > 0 && !commandExists(bin)) {
          socket.send(
            JSON.stringify({
              type: 'output',
              data: `\r\n[yeschef] PATH 中找不到 ${bin},若尚未安裝請先安裝。\r\n`,
            })
          )
        }
        pty.write(m.command + '\r')
      }
      return
    }
    if (pty === null) return // open 之前(或被拒絕後)的其他訊息忽略
    if (m.type === 'input' && typeof m.data === 'string') { beforeInput(m.data); pty.write(m.data); return }
    if (m.type === 'resize' && typeof m.cols === 'number' && typeof m.rows === 'number') {
      pty.resize(terminalDimension(m.cols, 80), terminalDimension(m.rows, 24)); return
    }
    logError(new Error(`終端機收到不認得的訊息 type=${m.type},已忽略`))
  })

  socket.on('close', () => { if (pty !== null) pty.kill() })
}

/** 每次回傳獨立快照,呼叫端不能改掉內部追蹤狀態。 */
export function createOwnClientTracker(spawn: SpawnPty) {
  let pids: ReadonlySet<number> = new Set()
  return {
    ownClientPids: (): ReadonlySet<number> => new Set(pids),
    spawn: (opts: SpawnPtyOptions): PtyLike => {
      const pty = spawn(opts)
      if (opts.shell === TMUX) {
        pids = new Set([...pids, pty.pid])
        pty.onExit(() => { pids = new Set([...pids].filter((pid) => pid !== pty.pid)) })
      }
      return pty
    },
  }
}

export interface TerminalServer { port: number; token: string; ownClientPids(): ReadonlySet<number>; close(): Promise<void> }

const realSpawn: SpawnPty = ({ cols, rows, cwd, shell, args }) =>
  nodePty.spawn(shell, [...args], { name: 'xterm-color', cols, rows, cwd, env: process.env }) as unknown as PtyLike

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === '' || origin === 'null') return true
  try {
    const url = new URL(origin)
    // 打包後的 renderer 從 file:// 載入,其 origin 是 'file://'(hostname 為空),放行。
    if (url.protocol === 'file:') return true
    const hostname = url.hostname
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
  } catch {
    return false
  }
}

export function startTerminalServer(resolveCwd: ResolveCwd, logError: (e: Error) => void): Promise<TerminalServer> {
  const tracker = createOwnClientTracker(realSpawn)
  const token = crypto.randomBytes(32).toString('base64url')
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      verifyClient: ({ origin, req }: { origin: string; req: { url?: string } }) => {
        const candidate = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('token')
        return isAllowedOrigin(origin) && isValidTerminalToken(candidate, token)
      },
    })
    wss.on('error', reject)
    wss.on('listening', () => {
      const addr = wss.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      wss.on('error', logError)
      wss.on('connection', (ws: WebSocket) => {
        ws.on('error', (e) => logError(e instanceof Error ? e : new Error(String(e))))
        const socket: SocketLike = {
          on: (ev: 'message' | 'close', cb: (raw: string) => void) => {
            if (ev === 'message') ws.on('message', (d) => cb(d.toString()))
            else ws.on('close', () => cb(''))
          },
          send: (t) => ws.send(t),
          close: () => ws.close(),
        }
        handleConnection(socket, tracker.spawn, resolveCwd, logError)
      })
      resolve({
        port,
        token,
        ownClientPids: tracker.ownClientPids,
        close: () => new Promise<void>((r) => wss.close(() => r())),
      })
    })
  })
}

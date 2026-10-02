import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createRemoteClientsWatcher } from '../src/main/remote-clients.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function setup(output = '', intervalMs?: number) {
  const run = vi.fn(async () => output)
  const onChange = vi.fn()
  const logError = vi.fn()
  const ownPids = vi.fn((): ReadonlySet<number> => new Set([123]))
  const watcher = createRemoteClientsWatcher({ run, onChange, logError, ownPids, intervalMs })
  return { watcher, run, onChange, logError, ownPids }
}

it.each([
  ['', false], ['sp-tab 123', false], ['other 456', false],
  ['sp-tab 456', true], ['sp-tab 123\nother 456\n sp-other 789\r\n', true],
  ['sp-tab nope\nsp-tab 0\nsp-tab -1\nsp-tab 1.5\nsp-tab 12 extra\nsp-tab 9007199254740992', false],
])('解析 client 清單 %j', async (output, remote) => {
  const { watcher, run, onChange } = setup(output)
  watcher.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(run).toHaveBeenCalledWith(['list-clients', '-F', '#{session_name} #{client_pid}'])
  expect(onChange.mock.calls).toEqual(remote ? [[true]] : [])
  watcher.stop()
})

it('立即查詢且重複 start 不加輪詢;預設每 15 秒查詢,只通知變化', async () => {
  const { watcher, run, onChange, ownPids } = setup('sp-tab 456')
  watcher.start()
  watcher.start()
  await vi.advanceTimersByTimeAsync(14999)
  expect(run).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(onChange.mock.calls).toEqual([[true]])
  ownPids.mockReturnValue(new Set([456]))
  await vi.advanceTimersByTimeAsync(15000)
  expect(onChange.mock.calls).toEqual([[true], [false]])
  watcher.stop()
  watcher.stop()
  await vi.advanceTimersByTimeAsync(30000)
  expect(run).toHaveBeenCalledTimes(3)
})

it('指令失敗視為 false,不記錯誤且繼續輪詢', async () => {
  const { watcher, run, onChange, logError } = setup('sp-tab 456', 10)
  watcher.start()
  await vi.advanceTimersByTimeAsync(0)
  run.mockRejectedValueOnce(Object.assign(new Error('no server'), { code: 1 }))
  run.mockRejectedValueOnce(Object.assign(new Error('not installed'), { code: 'ENOENT' }))
  await vi.advanceTimersByTimeAsync(20)
  expect(onChange.mock.calls).toEqual([[true], [false]])
  expect(logError).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(10)
  expect(onChange.mock.calls).toEqual([[true], [false], [true]])
  watcher.stop()
})

it('慢查詢不重疊,stop 後的舊結果不通知也不影響重新啟動', async () => {
  const { watcher, run, onChange } = setup('', 10)
  let finish: (output: string) => void = () => {}
  run.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve }))
  watcher.start()
  await vi.advanceTimersByTimeAsync(100)
  expect(run).toHaveBeenCalledTimes(1)
  watcher.stop()
  watcher.start()
  await vi.advanceTimersByTimeAsync(0)
  finish('sp-tab 456')
  await vi.advanceTimersByTimeAsync(0)
  expect(onChange).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(10)
  expect(run).toHaveBeenCalledTimes(3)
  watcher.stop()
})

it.each([new Error('callback'), 'callback'])('非指令錯誤會記錄並繼續輪詢', async (cause) => {
  const { watcher, ownPids, logError } = setup('', 10)
  ownPids.mockImplementationOnce(() => { throw cause })
  watcher.start()
  await vi.advanceTimersByTimeAsync(10)
  expect(logError).toHaveBeenCalledWith(expect.any(Error))
  expect(ownPids).toHaveBeenCalledTimes(2)
  watcher.stop()
})

it('可注入時鐘,通知中 stop 不會留下排程', async () => {
  const clock = { setTimer: vi.fn(), clearTimer: vi.fn() }
  const watcher = createRemoteClientsWatcher({
    run: async () => 'sp-tab 456', ownPids: () => new Set(),
    onChange: () => watcher.stop(), logError: vi.fn(), clock,
  })
  watcher.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(clock.setTimer).not.toHaveBeenCalled()
  expect(clock.clearTimer).toHaveBeenCalled()
})

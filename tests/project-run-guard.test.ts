import { describe, expect, it } from 'vitest'
import { blocksManagedServiceStop } from '../src/main/project-run/guard.js'

const services = [{ pid: 8123, pgid: 8100, processName: 'node', port: 3000 }]

describe('blocksManagedServiceStop', () => {
  it.each([
    'kill 8123',
    'kill -9 8123',
    'kill -TERM 8123',
    'kill --signal=KILL 8123',
    'kill -8100',
    'kill -- -8100',
    'pkill node',
    'pkill -f "node server.js"',
    'killall node',
    'kill $(lsof -ti :3000)',
    'lsof -ti TCP:3000 | xargs kill -9',
    'fuser -k 3000/tcp',
  ])('拒絕停止受管服務的寫法：%s', (command) => {
    expect(blocksManagedServiceStop(command, services)).toBe(true)
  })

  it.each([
    'lsof -i :3000',
    'lsof -ti :3000; kill 9999',
    'lsof -ti :3000 | head -1',
    'ps -p 8123',
    'kill -0 8123',
    'kill 9999',
    'pkill python',
    'fuser 3000/tcp',
    'curl http://127.0.0.1:3000/',
    'echo "kill 8123"',
  ])('不阻擋查詢或未命中服務的命令：%s', (command) => {
    expect(blocksManagedServiceStop(command, services)).toBe(false)
  })

  it('沒有受管服務時不改變批准流程', () => {
    expect(blocksManagedServiceStop('kill 8123', [])).toBe(false)
  })
})

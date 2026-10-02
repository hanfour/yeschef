import { describe, expect, it } from 'vitest'
// 純函式部分獨立成 src/main/agent-partition.ts,不從 agent-view.js 匯入:
// agent-view.ts 會 `import { WebContentsView } from 'electron'`,vitest 底下沒有
// 真正的 Electron 執行期，直接匯入會失敗。agent-view.ts 只是重新 export 這個函式。
import { agentPartitionFor } from '../src/main/agent-partition.js'

describe('agentPartitionFor', () => {
  it('不同對話 id 給不同的 partition 字串', () => {
    expect(agentPartitionFor('a')).not.toBe(agentPartitionFor('b'))
  })

  it('一律以 agent: 開頭', () => {
    expect(agentPartitionFor('a')).toBe('agent:a')
    expect(agentPartitionFor('b')).toBe('agent:b')
  })

  it('不帶 persist: 前綴:只在記憶體裡,對話關閉就清掉', () => {
    expect(agentPartitionFor('a').startsWith('persist:')).toBe(false)
    expect(agentPartitionFor('b').startsWith('persist:')).toBe(false)
  })
})

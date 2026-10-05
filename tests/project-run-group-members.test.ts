import { expect, it } from 'vitest'
import { parseLiveGroupMembers } from '../src/main/project-run/node-adapters.js'

it('程序群組成員排除 zombie，其他群組不算', () => {
  // macOS 對只剩 zombie 的群組送訊號回 EPERM；判斷是否結束要看活著的成員。
  const ps = ['  100   100 Ss', '  101   100 Z', '  102   100 S+', '  200   200 R', ''].join('\n')
  expect(parseLiveGroupMembers(ps, 100)).toEqual([100, 102])
  expect(parseLiveGroupMembers(['  101   100 Z', '  103   100 Z+'].join('\n'), 100)).toEqual([])
  expect(parseLiveGroupMembers(ps, 999)).toEqual([])
})

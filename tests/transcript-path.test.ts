import { describe, it, expect } from 'vitest'
import { encodeCwd, transcriptPathFor } from '../src/main/transcript-path.js'

describe('transcriptPathFor', () => {
  it('cwd 的每個非英數字元都換成 -(含點與斜線),對照本機真實目錄名', () => {
    expect(encodeCwd('/Users/me/multi-repo-agent/.claude/worktrees/corpus'))
      .toBe('-Users-me-multi-repo-agent--claude-worktrees-corpus')
    expect(encodeCwd('/private/tmp/yeschef-acceptance')).toBe('-private-tmp-yeschef-acceptance')
  })
  it('組成 ~/.claude/projects/<encoded>/<sessionId>.jsonl', () => {
    expect(transcriptPathFor('/Users/me', '/Users/me/demo', 'abc-123'))
      .toBe('/Users/me/.claude/projects/-Users-me-demo/abc-123.jsonl')
  })
})

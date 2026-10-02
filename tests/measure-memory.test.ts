import { describe, it, expect, vi } from 'vitest'
import { filterHits, GROUPS, displayWidth, padEndDisplay } from '../spikes/measure-memory.js'

// 匯入腳本會列印統計;注入程序快照,測試不查詢宿主的真實程序。
vi.mock('node:child_process', () => ({
  execSync: () => 'RSS COMM COMMAND\n1024 Electron yeschef Electron\n',
}))

describe('displayWidth / padEndDisplay（CJK 對齊）', () => {
  it('純 ASCII 字串的顯示寬度等於字元數', () => {
    expect(displayWidth('yeschef')).toBe(7)
  })

  it('CJK 字元算 2 個寬度', () => {
    expect(displayWidth('其中')).toBe(4)
  })

  it('中英混合標籤的顯示寬度是兩者加總', () => {
    // '其中 electron-vite（dev 專用）' 是 measure-memory.ts 裡實際會印的標籤
    expect(displayWidth('其中 ab')).toBe(2 * 2 + 1 + 2)
  })

  it('padEndDisplay 讓 CJK 標籤跟純 ASCII 標籤補到同一個顯示寬度', () => {
    const cjk = padEndDisplay('其中', 10)
    const ascii = padEndDisplay('yeschef', 10)
    expect(displayWidth(cjk)).toBe(10)
    expect(displayWidth(ascii)).toBe(10)
  })

  it('字串本身已經超過 targetWidth 時不截斷、原樣回傳', () => {
    expect(padEndDisplay('yeschef-is-long', 4)).toBe('yeschef-is-long')
  })
})

describe('filterHits with real GROUPS', () => {
  describe('yeschef group - critical regression tests', () => {
    const yeschefGroup = GROUPS[0]!

    it('should match Electron.app with yeschef project path', () => {
      const lines = [
        '156128 /Users/me /Users/me/Projects/yeschef/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .',
      ]
      const result = filterHits(lines, yeschefGroup)
      expect(result).toHaveLength(1)
    })

    it('should match electron-vite process in yeschef', () => {
      const lines = [
        '99104 node             node /Users/me/Projects/yeschef/node_modules/.bin/electron-vite dev',
      ]
      const result = filterHits(lines, yeschefGroup)
      expect(result).toHaveLength(1)
    })

    it('should NOT match Electron.app WITHOUT yeschef in path (round-2 regression)', () => {
      // This is the critical test: path contains literal "Electron.app" but NOT "yeschef"
      // Round 2 bug: matching just ['Electron.app'] would incorrectly catch this
      const lines = [
        '150000 /Applications/Ot /Users/someone/other-project/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
      ]
      const result = filterHits(lines, yeschefGroup)
      expect(result).toHaveLength(0)
    })

    it('should exclude the measurement script itself', () => {
      const lines = [
        '2000 node             node --experimental-strip-types /Users/me/Projects/yeschef/spikes/measure-memory.ts',
      ]
      const result = filterHits(lines, yeschefGroup)
      expect(result).toHaveLength(0)
    })
  })

  describe('claude CLI group - real GROUPS validation', () => {
    const claudeGroup = GROUPS[2]!

    it('should match claude process by comm field', () => {
      const lines = [
        '321000 claude          claude -p project',
      ]
      const result = filterHits(lines, claudeGroup)
      expect(result).toHaveLength(1)
    })

    it('should NOT match shell snapshot paths', () => {
      const lines = [
        '3472 /bin/zsh         /bin/zsh -c source /Users/me/.claude/shell-snapshots/snapshot-zsh-1234.sh',
      ]
      const result = filterHits(lines, claudeGroup)
      expect(result).toHaveLength(0)
    })

    it('should match multiple claude processes', () => {
      const lines = [
        '321000 claude          claude -p project1',
        '320000 claude          claude -p project2',
        '319000 claude          claude -p project3',
      ]
      const result = filterHits(lines, claudeGroup)
      expect(result).toHaveLength(3)
    })
  })

  describe('iTerm2 group - real GROUPS validation', () => {
    const itermGroup = GROUPS[3]!

    it('should match iTerm.app processes', () => {
      const lines = [
        '349000 /Applications/iT /Applications/iTerm.app/Contents/MacOS/iTerm2',
      ]
      const result = filterHits(lines, itermGroup)
      expect(result).toHaveLength(1)
    })

    it('should NOT match other apps with similar names', () => {
      const lines = [
        '100000 /Applications/Ot /Applications/Terminal.app/Contents/MacOS/Terminal',
      ]
      const result = filterHits(lines, itermGroup)
      expect(result).toHaveLength(0)
    })
  })

  describe('chrome-devtools-mcp group - real GROUPS validation', () => {
    const chromeGroup = GROUPS[4]!

    it('should match Chrome with chrome-devtools-mcp profile path', () => {
      const lines = [
        '500000 /Users/me /Users/me/.config/chrome-devtools-mcp/chrome-profile/Google Chrome --type=renderer',
      ]
      const result = filterHits(lines, chromeGroup)
      expect(result).toHaveLength(1)
    })

    it('should NOT match regular Chrome without chrome-devtools-mcp profile', () => {
      const lines = [
        '500000 /Applications/Gl /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ]
      const result = filterHits(lines, chromeGroup)
      expect(result).toHaveLength(0)
    })
  })

  describe('electron-vite group - real GROUPS validation', () => {
    const evGroup = GROUPS[1]!

    it('should match electron-vite processes', () => {
      const lines = [
        '99104 node             node /Users/me/Projects/yeschef/node_modules/.bin/electron-vite dev',
      ]
      const result = filterHits(lines, evGroup)
      expect(result).toHaveLength(1)
    })

    it('should NOT match other node processes without electron-vite', () => {
      const lines = [
        '50000 node             node /some/other/script.js',
      ]
      const result = filterHits(lines, evGroup)
      expect(result).toHaveLength(0)
    })
  })
})

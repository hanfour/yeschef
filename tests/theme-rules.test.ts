import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const RENDERER = join(import.meta.dirname, '../src/renderer')
const THEME = join(RENDERER, 'theme.css')

const RADIUS_OK = /^(var\(--radius-(s|m|l)\)|0|50%|999px)$/
const FONT_SIZE_OK = /^(var\(--text-(xs|s|m|l|xl)\)|inherit)$/
const NAMED_COLOR = /\b(white|black|red|blue|green|gray|grey)\b/i
const BORDER_CORNER_RADIUS = /^border-(top|bottom)-(left|right)-radius$/

function cssFiles(): readonly { name: string; text: string }[] {
  const dirs = [RENDERER, join(RENDERER, 'components')]
  return dirs.flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith('.css') && f !== 'theme.css').map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') })))
}

/** 去掉註解,再依 `屬性: 值` 逐一切出來。 */
function declarations(text: string): readonly { prop: string; value: string }[] {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, '')
  return [...clean.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)[;}]/g)].map((m) => ({ prop: m[1]!, value: m[2]!.trim() }))
}

describe('theme.css', () => {
  const theme = readFileSync(THEME, 'utf8')
  it('不用 hex', () => {
    expect(theme.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })
  it(':root 與深色區塊定義同一組 token', () => {
    const blocks = [...theme.matchAll(/(:root|prefers-color-scheme:\s*dark[^{]*\{\s*:root)\s*\{([^}]*)\}/g)].map((m) => m[2]!)
    expect(blocks.length).toBeGreaterThanOrEqual(2)
    const names = blocks.map((b) => [...b.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!).sort())
    const color = names[0]!.filter((n) => !n.startsWith('--radius') && !n.startsWith('--text') && !n.startsWith('--font'))
    expect(names[1]).toEqual(color)
  })
  it('沒有 --ui- 開頭的 token', () => {
    expect(theme).not.toMatch(/--ui-/)
  })
  it(':where(.app, dialog) button 用 min-height,不鎖死固定 height', () => {
    const rule = theme.match(/:where\(\.app, dialog\) button \{([^}]*)\}/)?.[1] ?? ''
    const props = rule.split(';').map((d) => d.split(':')[0]!.trim())
    expect(props).toContain('min-height')
    expect(props).not.toContain('height')
  })
  it('prefers-reduced-motion 開啟時,button:active 不再縮放', () => {
    const start = theme.indexOf('@media (prefers-reduced-motion: reduce)')
    expect(start).toBeGreaterThanOrEqual(0)
    let depth = 0
    let end = start
    for (let i = start; i < theme.length; i++) {
      if (theme[i] === '{') depth++
      else if (theme[i] === '}') {
        depth--
        if (depth === 0) { end = i; break }
      }
    }
    const block = theme.slice(start, end)
    expect(block).toMatch(/button:active:not\(:disabled\)\s*\{[^}]*transform:\s*none/)
  })
})

describe('已搬遷的元件 CSS', () => {
  it('群組 Claude、Codex 與 Grok 色彩沿用分頁 provider 色彩', () => {
    const files = cssFiles()
    const leftPane = files.find((file) => file.name === 'LeftPane.css')?.text ?? ''
    const groupPane = files.find((file) => file.name === 'GroupPane.css')?.text ?? ''
    for (const provider of ['claude', 'codex', 'grok']) {
      const providerToken = leftPane.match(new RegExp(`\\.tab\\[data-provider=${provider}\\]::before\\s*\\{[^}]*background:\\s*var\\(--([\\w-]+)\\)`))?.[1]
      const defaultToken = leftPane.match(/\.tab::before\s*\{[^}]*background:\s*var\(--([\w-]+)\)/)?.[1]
      const tabToken = providerToken ?? defaultToken
      const groupToken = groupPane.match(new RegExp(`\\.group-from\\[data-from="${provider}"\\]\\s*\\{[^}]*background:\\s*color-mix\\(in srgb,\\s*var\\(--([\\w-]+)\\)`))?.[1]
      expect(groupToken, provider).toBe(tabToken)
    }
  })

  it('沒有 hex、rgb、hsl 字面值', () => {
    for (const f of cssFiles()) expect(f.text.replace(/\/\*[\s\S]*?\*\//g, ''), f.name).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/)
  })
  it('border-radius 只用尺度', () => {
    for (const f of cssFiles()) for (const d of declarations(f.text)) if (d.prop === 'border-radius') expect(d.value, `${f.name}: ${d.value}`).toMatch(RADIUS_OK)
  })
  it('font-size 只用尺度', () => {
    for (const f of cssFiles()) for (const d of declarations(f.text)) if (d.prop === 'font-size') expect(d.value, `${f.name}: ${d.value}`).toMatch(FONT_SIZE_OK)
  })
  it('沒有 transition: all,也沒有 --ui- token', () => {
    for (const f of cssFiles()) {
      expect(f.text, f.name).not.toMatch(/transition:\s*all\b/)
      expect(f.text, f.name).not.toMatch(/--ui-/)
    }
  })
  it('沒有 !important', () => {
    for (const f of cssFiles()) expect(f.text, f.name).not.toMatch(/!important/)
  })
  it('border-*-radius(單邊)只用尺度', () => {
    for (const f of cssFiles()) for (const d of declarations(f.text)) if (BORDER_CORNER_RADIUS.test(d.prop)) expect(d.value, `${f.name}: ${d.prop}: ${d.value}`).toMatch(RADIUS_OK)
  })
  it('沒有具名色彩當值,color-mix( 裡面除外', () => {
    for (const f of cssFiles()) for (const d of declarations(f.text)) {
      const withoutColorMix = d.value.replace(/color-mix\([^)]*\)/g, '')
      expect(withoutColorMix, `${f.name}: ${d.prop}: ${d.value}`).not.toMatch(NAMED_COLOR)
    }
  })
})

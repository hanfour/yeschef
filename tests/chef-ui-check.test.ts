import { describe, expect, it } from 'vitest'
import { scanUiFiles } from '../src/main/chef/ui-check/scan.js'
import { uiCheckRules } from '../src/main/chef/ui-check/rules/index.js'

const file = (text: string, path = 'src/Card.css') => ({ path, text })
const rule = (id: string) => {
  const found = uiCheckRules.find((candidate) => candidate.id === id)
  if (!found) throw Error(`missing rule: ${id}`)
  return found
}

describe('主廚介面檢查規則', () => {
  it('side-stripe 抓超過 1px 的側邊框，排除 blockquote，1px 為邊界', () => {
    expect(rule('side-stripe').check(file('.card { border-left: 2px solid red; }'))).toHaveLength(1)
    expect(rule('side-stripe').check(file('blockquote { border-left: 4px solid red; }'))).toHaveLength(0)
    expect(rule('side-stripe').check(file('blockquote + .card { border-left: 4px solid red; }'))).toHaveLength(1)
    expect(rule('side-stripe').check(file('.card { border-right: 1px solid red; }'))).toHaveLength(0)
    // 樣式寫在寬度前面、rem 單位、關鍵字寬度都要抓到。
    expect(rule('side-stripe').check(file('.card { border-left: solid 4px red; }'))).toHaveLength(1)
    expect(rule('side-stripe').check(file('.card { border-left: 0.25rem solid var(--accent); }'))).toHaveLength(1)
    expect(rule('side-stripe').check(file('.card { border-left: thick solid red; }'))).toHaveLength(1)
    expect(rule('side-stripe').check(file('.card { border-left: thin solid red; }'))).toHaveLength(0)
    expect(rule('side-stripe').check(file('.card { border-left: 0.0625rem solid red; }'))).toHaveLength(0)
    expect(rule('side-stripe').check(file('.card { border-left-width: 4px; }'))).toHaveLength(0)
  })

  it('gradient-text 需要同一個樣式區塊同時有漸層與文字裁切', () => {
    expect(rule('gradient-text').check(file('.title { background: linear-gradient(red, blue); background-clip: text; }'))).toHaveLength(1)
    expect(rule('gradient-text').check(file('.title { background: linear-gradient(red, blue); }'))).toHaveLength(0)
    expect(rule('gradient-text').check(file('.title { background: red; background-clip: text; }'))).toHaveLength(0)
  })

  it('eyebrow-label 抓緊接標題前的 eyebrow/kicker 類別', () => {
    expect(rule('eyebrow-label').check(file('<span class="eyebrow">Section</span>\n<h2>Title</h2>', 'src/Card.tsx'))).toHaveLength(1)
    expect(rule('eyebrow-label').check(file('<p class:kicker={active}>Section</p>\n<h3>Title</h3>', 'src/Card.svelte'))).toHaveLength(1)
    expect(rule('eyebrow-label').check(file('<span class="eyebrow">Section</span>\n<p>Body</p>', 'src/Card.vue'))).toHaveLength(0)
    expect(rule('eyebrow-label').check(file('<h2>Title</h2>\n<span class="kicker">Section</span>', 'src/Card.html'))).toHaveLength(0)
  })

  it('tiny-text 小於 11px 才觸發，11px 為邊界', () => {
    expect(rule('tiny-text').check(file('.badge { font-size: 10.5px; }'))).toHaveLength(1)
    expect(rule('tiny-text').check(file('.badge { font-size: 12px; }'))).toHaveLength(0)
    expect(rule('tiny-text').check(file('.badge { font-size: 11px; }'))).toHaveLength(0)
  })

  it('focus-removed 只在沒有 focus-visible 規則時抓 outline none/0', () => {
    expect(rule('focus-removed').check(file('button { outline: none; }'))).toHaveLength(1)
    expect(rule('focus-removed').check(file('button { outline: 0 solid red; }'))).toHaveLength(1)
    expect(rule('focus-removed').check(file('button { outline: 0; }\nbutton:focus-visible { outline: 2px solid blue; }'))).toHaveLength(0)
    expect(rule('focus-removed').check(file('button { outline: 1px solid blue; }'))).toHaveLength(0)
  })

  it.each([
    'black', 'WHITE', '#000', '#000000', '#fff', '#ffffff',
    '#000F', '#000000FF', '#FFFF', '#FFFFFFFF',
    'rgb(0,0,0)', 'rgb(255, 255, 255)', 'rgb(0 0 0)', 'rgb(255 255 255)',
  ])('pure-black-white 抓純黑白背景值 %s', (color) => {
    expect(rule('pure-black-white').check(file('.surface { background: ' + color + '; }'))).toHaveLength(1)
    expect(rule('pure-black-white').check(file('.surface { background-color: ' + color + '; }'))).toHaveLength(1)
  })

  it('pure-black-white 只抓根元素或 main 的純黑白文字色', () => {
    for (const selector of ['html', 'body.dark', ':root', 'article main p', 'div, main.notice']) {
      expect(rule('pure-black-white').check(file(selector + ' { color: #000; }'))).toHaveLength(1)
    }
    expect(rule('pure-black-white').check(file('.main { color: #000; }'))).toHaveLength(0)
    expect(rule('pure-black-white').check(file('.card { color: white; }'))).toHaveLength(0)
  })

  it('pure-black-white 排除透明色、混合色與邊框陰影外框', () => {
    expect(rule('pure-black-white').check(file('.surface { background: #000000fe; }'))).toHaveLength(0)
    expect(rule('pure-black-white').check(file('.surface { background: #ffffff00; }'))).toHaveLength(0)
    expect(rule('pure-black-white').check(file('.surface { background: rgb(0, 0 0); }'))).toHaveLength(0)
    expect(rule('pure-black-white').check(file('.surface { border: 1px solid #000; box-shadow: 0 0 0 #fff; outline: 1px solid white; }'))).toHaveLength(0)
  })

  it('有效略過註解不配置 F 編號並保留原因，缺少原因則繼續檢查', () => {
    const ignored = scanUiFiles([file('/* yeschef-ui-ignore tiny-text: 資訊密度需求 */\n.badge { font-size: 10px; }')])
    expect(ignored.findings).toHaveLength(0)
    expect(ignored.identities).toHaveLength(0)
    expect(ignored.skipped).toMatchObject([{ ruleId: 'tiny-text', reason: '資訊密度需求' }])
    expect(ignored.skipped[0]).not.toHaveProperty('id')

    const missing = scanUiFiles([file('/* yeschef-ui-ignore tiny-text:   */\n.badge { font-size: 10px; }')])
    expect(missing.findings).toHaveLength(1)
    expect(missing.invalidIgnores).toMatchObject([{ ruleId: 'tiny-text' }])

    const wrongRule = scanUiFiles([file('/* yeschef-ui-ignore side-stripe: 理由 */\n.badge { font-size: 10px; }')])
    expect(wrongRule.findings).toHaveLength(1)
    expect(wrongRule.skipped).toHaveLength(0)
  })
})

describe('介面檢查掃描入口', () => {
  it('依檔案與行號排序，重複掃描保留同一發現的編號', () => {
    const files = [
      file('.x { font-size: 10px; }\n.y { font-size: 9px; }', 'z.css'),
      file('.x { font-size: 10px; }', 'a.css'),
    ]
    const first = scanUiFiles(files)
    expect(first.findings.map(({ id, path, line }) => ({ id, path, line }))).toEqual([
      { id: 'F1', path: 'a.css', line: 1 },
      { id: 'F2', path: 'z.css', line: 1 },
      { id: 'F3', path: 'z.css', line: 2 },
    ])
    const second = scanUiFiles([...files].reverse(), first.identities)
    expect(second.findings.map(({ id, path, line }) => ({ id, path, line }))).toEqual(first.findings.map(({ id, path, line }) => ({ id, path, line })))
  })
})

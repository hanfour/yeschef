import { describe, expect, it } from 'vitest'
import { extractImages, redactImages, toDataUrl } from '../src/shared/tool-images.js'

const shot = [
  { type: 'text', text: '可視範圍 799×833' },
  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
]

describe('extractImages', () => {
  it('從結果陣列取出 image block', () => {
    expect(extractImages(shot)).toEqual([{ mimeType: 'image/png', dataBase64: 'AAAA' }])
  })

  it('不是陣列、沒有圖、形狀不對都回空陣列', () => {
    expect(extractImages('text')).toEqual([])
    expect(extractImages(undefined)).toEqual([])
    expect(extractImages([{ type: 'text', text: 'x' }])).toEqual([])
    expect(extractImages([{ type: 'image', source: { type: 'url', url: 'https://x' } }])).toEqual([])
    expect(extractImages([{ type: 'image', source: { type: 'base64', media_type: 'text/html', data: 'AAAA' } }])).toEqual([])
  })
})

describe('redactImages', () => {
  it('把圖片資料換成說明,文字留著,原物件不動', () => {
    const out = redactImages(shot)
    expect(out).toEqual([
      { type: 'text', text: '可視範圍 799×833' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '(圖片,4 字元,已畫在上方)' } },
    ])
    expect((shot[1] as { source: { data: string } }).source.data).toBe('AAAA')
  })

  it('不是陣列就原樣回傳', () => {
    expect(redactImages('text')).toBe('text')
  })
})

describe('toDataUrl', () => {
  it('組成 data URL', () => {
    expect(toDataUrl({ mimeType: 'image/png', dataBase64: 'AAAA' })).toBe('data:image/png;base64,AAAA')
  })
})

describe('codex 的 MCP 結果', () => {
  // codex app-server 協定的 McpToolCallResult 是 { content: [...] },content 原樣轉傳 MCP 的內容區塊;
  // MCP 的圖片是 { type: 'image', data, mimeType },不是 Anthropic 的 source 形狀。
  const mcp = {
    content: [
      { type: 'text', text: '截好了' },
      { type: 'image', data: 'BBBB', mimeType: 'image/png' },
    ],
    structuredContent: null,
  }

  it('外面包一層 content 也取得到,MCP 形狀的圖片也認得', () => {
    expect(extractImages(mcp)).toEqual([{ mimeType: 'image/png', dataBase64: 'BBBB' }])
  })

  it('MCP 形狀的 mimeType 一樣走白名單', () => {
    expect(extractImages({ content: [{ type: 'image', data: 'x', mimeType: 'image/svg+xml' }] })).toEqual([])
  })

  it('去掉圖片資料時保留外層與其他欄位,原物件不動', () => {
    expect(redactImages(mcp)).toEqual({
      content: [
        { type: 'text', text: '截好了' },
        { type: 'image', data: '(圖片,4 字元,已畫在上方)', mimeType: 'image/png' },
      ],
      structuredContent: null,
    })
    expect(mcp.content[1]).toEqual({ type: 'image', data: 'BBBB', mimeType: 'image/png' })
  })

  it('content 不是陣列的物件照舊不動', () => {
    const odd = { content: 'x' }
    expect(extractImages(odd)).toEqual([])
    expect(redactImages(odd)).toBe(odd)
  })
})

describe('codex 的 dynamicTool 結果', () => {
  // codex 的 contentItems 是 { type: 'inputImage', imageUrl }(RESULTS-22 §1、§2);
  // imageUrl 只吃 data: URL,https 會被 app-server 擋掉,file:// 走 codex 自己的 view_image。
  const items = [
    { type: 'inputText', text: '可視範圍 800×600' },
    { type: 'inputImage', imageUrl: 'data:image/png;base64,CCCC' },
  ]

  it('從 inputImage 的 data URL 取出 mimeType 與 base64', () => {
    expect(extractImages(items)).toEqual([{ mimeType: 'image/png', dataBase64: 'CCCC' }])
  })

  it('包在 contentItems 外層的 content 物件也取得到', () => {
    expect(extractImages({ content: items })).toEqual([{ mimeType: 'image/png', dataBase64: 'CCCC' }])
  })

  it('不是 data URL、不是 base64、mimeType 不在白名單的都不認', () => {
    expect(extractImages([{ type: 'inputImage', imageUrl: 'https://x.test/a.png' }])).toEqual([])
    expect(extractImages([{ type: 'inputImage', imageUrl: 'file:///tmp/a.png' }])).toEqual([])
    expect(extractImages([{ type: 'inputImage', imageUrl: 'data:image/png,notbase64' }])).toEqual([])
    expect(extractImages([{ type: 'inputImage', imageUrl: 'data:image/svg+xml;base64,CCCC' }])).toEqual([])
    expect(extractImages([{ type: 'inputImage', imageUrl: 7 }])).toEqual([])
    expect(extractImages([{ type: 'inputImage' }])).toEqual([])
  })

  it('去掉圖片資料時換掉 imageUrl,文字項與原物件都不動', () => {
    expect(redactImages(items)).toEqual([
      { type: 'inputText', text: '可視範圍 800×600' },
      { type: 'inputImage', imageUrl: '(圖片,4 字元,已畫在上方)' },
    ])
    expect(items[1]).toEqual({ type: 'inputImage', imageUrl: 'data:image/png;base64,CCCC' })
  })

  it('toDataUrl 轉回去與原本的 imageUrl 一字不差', () => {
    const found = extractImages(items)[0]
    expect(found === undefined ? '' : toDataUrl(found)).toBe('data:image/png;base64,CCCC')
  })
})

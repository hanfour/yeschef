/**
 * 對比量測(規格 §6.3 第 4 項)。兩部分:
 *   (a) 算的:讀 theme.css 的 token 值,套 WCAG 相對亮度公式,rgba 的文字色先合成到背景上。
 *   (b) 量的:讀 .spike-out/ui/light-main-short.png、dark-main-short.png 的實際像素。
 * node_modules 沒有 pngjs / sharp / jimp,PNG 解碼自己寫(只支援 8-bit、非交錯的
 * colorType 2/6,兩張截圖都是這個格式,夠用,不多做)。
 *
 * 跑法:node --experimental-strip-types spikes/contrast.ts(先跑一次 npm run spike:screenshots)。
 */
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const THEME_PATH = join(HERE, '../src/renderer/theme.css')
const UI_DIR = join(HERE, '../.spike-out/ui')

/* ---------------------------- PNG 解碼(純 JS) ---------------------------- */

interface DecodedPng {
  readonly width: number
  readonly height: number
  readonly channels: 3 | 4
  readonly data: Uint8Array
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/** PNG 的每一列在濾波前都要用前一列與同列前一個像素還原(規格見 PNG spec 9.2)。 */
function unfilter(raw: Buffer, width: number, height: number, channels: number): Uint8Array {
  const stride = width * channels
  const out = new Uint8Array(stride * height)
  let pos = 0
  for (let row = 0; row < height; row++) {
    const filterType = raw[pos]
    pos += 1
    const rowStart = row * stride
    for (let i = 0; i < stride; i++) {
      const x = raw[pos + i] ?? 0
      const a = i >= channels ? (out[rowStart + i - channels] ?? 0) : 0
      const b = row > 0 ? (out[rowStart - stride + i] ?? 0) : 0
      const c = row > 0 && i >= channels ? (out[rowStart - stride + i - channels] ?? 0) : 0
      const recon =
        filterType === 0 ? x
        : filterType === 1 ? x + a
        : filterType === 2 ? x + b
        : filterType === 3 ? x + Math.floor((a + b) / 2)
        : filterType === 4 ? x + paeth(a, b, c)
        : (() => { throw new Error(`不支援的 PNG filter type:${filterType}`) })()
      out[rowStart + i] = recon & 0xff
    }
    pos += stride
  }
  return out
}

export function decodePng(path: string): DecodedPng {
  const buf = readFileSync(path)
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (!buf.subarray(0, 8).equals(sig)) throw new Error(`${path} 不是 PNG`)
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = -1
  const idatChunks: Buffer[] = []
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    const data = buf.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data.readUInt8(8)
      colorType = data.readUInt8(9)
      if (data.readUInt8(12) !== 0) throw new Error(`${path}:不支援 interlace PNG`)
    } else if (type === 'IDAT') {
      idatChunks.push(Buffer.from(data))
    } else if (type === 'IEND') {
      break
    }
    offset = offset + 8 + length + 4 // 資料 + 4 bytes CRC
  }
  if (bitDepth !== 8) throw new Error(`${path}:只支援 8-bit PNG,實際 ${bitDepth}`)
  if (colorType !== 2 && colorType !== 6) throw new Error(`${path}:只支援 colorType 2/6,實際 ${colorType}`)
  const channels = colorType === 6 ? 4 : 3
  const data = unfilter(inflateSync(Buffer.concat(idatChunks)), width, height, channels)
  return { width, height, channels, data }
}

function getPixel(png: DecodedPng, x: number, y: number): Rgb {
  const idx = (y * png.width + x) * png.channels
  return { r: png.data[idx] ?? 0, g: png.data[idx + 1] ?? 0, b: png.data[idx + 2] ?? 0 }
}

/* ------------------------------ 顏色與對比 ------------------------------ */

interface Rgb { readonly r: number; readonly g: number; readonly b: number }
interface Rgba extends Rgb { readonly a: number }

function relLuminance({ r, g, b }: Rgb): number {
  const lin = (c: number): number => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relLuminance(a)
  const lb = relLuminance(b)
  const lighter = Math.max(la, lb)
  const darker = Math.min(la, lb)
  return (lighter + 0.05) / (darker + 0.05)
}

function compositeOver(fg: Rgba, bg: Rgb): Rgb {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
  }
}

/* ------------------------------ theme.css 解析 ------------------------------ */

function parseColorTokens(block: string): Record<string, string> {
  const tokens: Record<string, string> = {}
  const re = /--([\w-]+):\s*([^;]+);/g
  let m: RegExpExecArray | null
  while ((m = re.exec(block))) {
    const [, name, value] = m
    if (name !== undefined && value !== undefined) tokens[name] = value.trim()
  }
  return tokens
}

function parseRgba(value: string): Rgba {
  const m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/.exec(value)
  const [, r, g, b, a] = m ?? []
  if (r === undefined || g === undefined || b === undefined) throw new Error(`無法解析顏色值:${value}`)
  return { r: Number(r), g: Number(g), b: Number(b), a: a === undefined ? 1 : Number(a) }
}

/** tokens 來自 theme.css 解析,名字打錯或漏寫時直接失敗,不要默默當成透明黑。 */
function requireToken(tokens: Record<string, string>, name: string): string {
  const value = tokens[name]
  if (value === undefined) throw new Error(`theme.css 缺少 token:--${name}`)
  return value
}

function loadTokens(): { readonly light: Record<string, string>; readonly dark: Record<string, string> } {
  const css = readFileSync(THEME_PATH, 'utf8')
  const rootBlock = /:root\s*\{([^}]*)\}/.exec(css)?.[1]
  const darkBlock = /prefers-color-scheme:\s*dark\s*\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css)?.[1]
  if (rootBlock === undefined || darkBlock === undefined) throw new Error('theme.css 找不到 :root 或深色 :root 區塊')
  return { light: parseColorTokens(rootBlock), dark: parseColorTokens(darkBlock) }
}

/* ------------------------------ 像素採樣 ------------------------------ */

interface Patch { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

function meanColor(png: DecodedPng, p: Patch): Rgb {
  let r = 0, g = 0, b = 0, n = 0
  for (let y = p.y; y < p.y + p.h; y++) {
    for (let x = p.x; x < p.x + p.w; x++) {
      const c = getPixel(png, x, y)
      r += c.r; g += c.g; b += c.b; n += 1
    }
  }
  return { r: r / n, g: g / n, b: b / n }
}

/** 在 patch 內找跟 bg 亮度差最大的像素,當成文字墨色的近似值(不管深底淺字還是淺底深字)。 */
function extremeColor(png: DecodedPng, p: Patch, bg: Rgb): Rgb {
  const bgL = relLuminance(bg)
  let best: Rgb = bg
  let bestDiff = -1
  for (let y = p.y; y < p.y + p.h; y++) {
    for (let x = p.x; x < p.x + p.w; x++) {
      const c = getPixel(png, x, y)
      const diff = Math.abs(relLuminance(c) - bgL)
      if (diff > bestDiff) { bestDiff = diff; best = c }
    }
  }
  return best
}

export { relLuminance, contrastRatio, compositeOver, parseRgba, meanColor, extremeColor }

/* ------------------------------ 量測座標 ------------------------------ */

/**
 * 座標從 light-main-short.png(2880×1800,1440×900 視窗的 2x 截圖)量出來;
 * dark-main-short.png 同一份 fixture、同一個視窗尺寸,版面相同,座標共用。
 * 每個位置給一塊小區域而不是單一像素:bg patch 取平均當背景色,
 * text patch 用 extremeColor() 在區域裡找跟背景亮度差最大的像素當墨色,
 * 不用對到字的某一筆畫,也不怕抗鋸齒的邊緣像素把顏色量偏。
 */
const CONTENT_TEXT: Patch = { x: 590, y: 701, w: 300, h: 20 } // 對話區「好,先看現在的表單結構。」
const CONTENT_BG: Patch = { x: 1080, y: 701, w: 100, h: 18 }
const RAISED_TEXT: Patch = { x: 626, y: 487, w: 300, h: 20 } // 使用者訊息泡泡第一行
const RAISED_BG: Patch = { x: 1296, y: 490, w: 60, h: 18 }
const LABEL2_TEXT: Patch = { x: 29, y: 288, w: 100, h: 20 } // 側欄「歷史對話」標題
const LABEL2_BG: Patch = { x: 144, y: 662, w: 280, h: 40 }
/**
 * 主要按鈕的量測不用 main-short 的「送出」:那顆按鈕在這份 fixture 底下永遠卡在
 * disabled(有 1 個待批准的工具擋著送出),量到的是 opacity .4 洗淡後的顏色,不是
 * 規格要看的主要按鈕本色。改用測試機對話框的「儲存」按鈕(enabled,light/dark 都是)。
 */
const BUTTON_TEXT: Patch = { x: 660, y: 1764, w: 50, h: 24 } // 「儲存」兩個字
const BUTTON_FILL: Patch = { x: 712, y: 1755, w: 18, h: 38 }

/* ------------------------------ 主流程 ------------------------------ */

interface PairResult { readonly fg: Rgb; readonly bg: Rgb; readonly ratio: number }

function computedPair(fg: Rgba, bg: Rgb): PairResult {
  const composited = compositeOver(fg, bg)
  return { fg: composited, bg, ratio: contrastRatio(composited, bg) }
}

function measuredPair(png: DecodedPng, textPatch: Patch, bgPatch: Patch): PairResult {
  const bg = meanColor(png, bgPatch)
  const fg = extremeColor(png, textPatch, bg)
  return { fg, bg, ratio: contrastRatio(fg, bg) }
}

const fmtRgb = (c: Rgb): string => `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`
const round2 = (n: number): number => Math.round(n * 100) / 100

function report(
  pair: string,
  theme: string,
  computed: PairResult,
  measured: PairResult,
  threshold: number | null,
  note: string,
): boolean {
  const pass = threshold === null ? null : measured.ratio >= threshold
  console.log(JSON.stringify({
    pair,
    theme,
    computed: { fg: fmtRgb(computed.fg), bg: fmtRgb(computed.bg), ratio: round2(computed.ratio) },
    measured: { fg: fmtRgb(measured.fg), bg: fmtRgb(measured.bg), ratio: round2(measured.ratio) },
    threshold,
    pass,
    note,
  }))
  return pass === false
}

function runTheme(theme: 'light' | 'dark', tokens: Record<string, string>): boolean {
  const png = decodePng(join(UI_DIR, `${theme}-main-short.png`))
  const bgContent = parseRgba(requireToken(tokens, 'bg-content'))
  const bgRaised = parseRgba(requireToken(tokens, 'bg-raised'))
  let anyFail = false

  anyFail = report('label vs bg-content', theme,
    computedPair(parseRgba(requireToken(tokens, 'label')), bgContent),
    measuredPair(png, CONTENT_TEXT, CONTENT_BG),
    4.5, '對話區主體文字(assistant 回覆)') || anyFail

  anyFail = report('label-2 vs bg-content', theme,
    computedPair(parseRgba(requireToken(tokens, 'label-2')), bgContent),
    measuredPair(png, LABEL2_TEXT, LABEL2_BG),
    3, '側欄「歷史對話」標題;側欄現在整條透空(材質區),spike 沒開 vibrancy,量到的是 BaseWindow 的視窗底色,不是 --bg-window 也不是 --bg-content,算的那欄仍照規格用 --bg-content') || anyFail

  anyFail = report('label vs bg-raised', theme,
    computedPair(parseRgba(requireToken(tokens, 'label')), bgRaised),
    measuredPair(png, RAISED_TEXT, RAISED_BG),
    null, '使用者訊息泡泡文字(規格沒有替這組定門檻,列出來對照)') || anyFail

  const buttonPng = decodePng(join(UI_DIR, `${theme}-test-machines.png`))
  const measuredButton = measuredPair(buttonPng, BUTTON_TEXT, BUTTON_FILL)
  const systemBlue: Rgb = { r: 0, g: 122, b: 255 }
  report('accent-text vs systemBlue(rgb(0,122,255))', theme,
    { fg: measuredButton.fg, bg: systemBlue, ratio: contrastRatio(measuredButton.fg, systemBlue) },
    measuredButton,
    null, '測試機對話框「儲存」主要按鈕(main-short 的「送出」在這份 fixture 底下永遠 disabled,量不到本色);--accent-text 是 AccentColorText 關鍵字,theme.css 沒有可解析的數值,算的那欄用實際量到的按鈕文字色代入,背景用規格 §3.1 給的系統藍字面值')

  return anyFail
}

function main(): void {
  const tokens = loadTokens()
  const lightFail = runTheme('light', tokens.light)
  const darkFail = runTheme('dark', tokens.dark)
  const anyFail = lightFail || darkFail
  if (anyFail) console.error('有量到的對比低於規格 §6.3 第 4 項的門檻(--label 4.5:1,--label-2 3:1),見上面 pass:false 的那幾行。')
  // 統一輸出契約:每項一行 {check, ok, detail},全部通過才 exit 0(見上面逐對的 pass 欄位)。
  console.log(JSON.stringify({
    check: '對比門檻:--label 對 --bg-content ≥ 4.5:1、--label-2 對 --bg-content ≥ 3:1(淺色與深色都要過)',
    ok: !anyFail,
    detail: anyFail ? '至少一項量到的對比低於門檻,見上面各對 pass:false 的那一行' : '淺色與深色、兩組門檻皆通過',
  }))
  if (anyFail) process.exitCode = 1
}

main()

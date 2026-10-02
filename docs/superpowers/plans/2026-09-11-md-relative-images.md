# 預覽 Markdown 裡的相對路徑圖片 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 預覽分頁裡的 Markdown,`![](docs/shot.png)` 這種相對路徑的圖片顯示得出來。

**Architecture:** `Markdown` 加一個選填的 `renderImage`,只有預覽分頁傳。預覽分頁把相對路徑以該 Markdown 檔所在目錄為基準解析,經既有的 `preview:read` 讀(主行程的四道檢查照舊)。renderer 端讀檔一律排隊、同時最多 2 個,不去碰主行程的同時讀取上限。

**Tech Stack:** React 19、react-markdown、TypeScript strict、vitest

**Spec:** `docs/specs/2026-09-11-shell-regions-design.md` 增量 3b;`docs/RESULTS-21-preview.md` §8

## Global Constraints

- TypeScript strict,`noUncheckedIndexedAccess` 開著,不可用 `any` 或 `!`。不可就地修改。
- 註解用繁體中文,說明為什麼。commit 訊息 `<type>: <描述>`,繁體中文,不加 trailer。
- 測試不用 jest-dom,不新增 `tests/setup.ts`、不改 `vitest.config.ts`。Stmts ≥ 93、Branch ≥ 86。
- 對話裡的 Markdown(沒有傳 `renderImage` 的地方)行為完全不變。遠端圖片(`http`、`https`、`data:`)照舊直接交給 `<img>`,使用者 2026-09-11 決定全放。
- 不動 `src/main`、`src/preload`,不新增 IPC。
- renderer 端同時讀取上限固定為 2,跟主行程的 `PREVIEW_MAX_IN_FLIGHT` 相同。
- 圖片讀不到時顯示的文字固定為:`(圖片讀取失敗:<原因>)`;讀取中顯示 alt 文字,沒有 alt 顯示 `圖片`。

---

### Task 1: 相對路徑圖片經 preview:read 顯示

**Files:**
- Modify: `src/shared/preview.ts`(加 `resolveImageSrc`)
- Create: `src/renderer/read-queue.ts`
- Modify: `src/renderer/components/Markdown.tsx`(加 `renderImage`)
- Modify: `src/renderer/components/PreviewPane.tsx`(讀檔改走排隊、傳 `renderImage`)
- Test: `tests/preview.test.ts`(新增或加在既有的 preview 相關測試檔)、`tests/read-queue.test.ts`(新增)、`tests/preview-pane.test.tsx`(加)、`tests/markdown.test.tsx`(加;檔名以現場為準)

**Interfaces:**
- `resolveImageSrc(markdownPath: string, src: string): string | undefined`:回傳要交給 `preview:read` 的路徑;
  `src` 是遠端或 data URL 時回 `undefined`(照舊交給 `<img>`)。
- `queuedReader(api: Pick<YesChefApi, 'readPreview'>): (payload: PreviewReadPayload) => Promise<PreviewReadResult>`:
  同一個 api 物件拿到同一個排隊函式(用 `WeakMap` 快取),同時最多 2 個。
- `MarkdownProps.renderImage?: (src: string, alt: string) => ReactNode`

解析規則:

| `src` | 結果 |
|---|---|
| `https://…`、`http://…`、`data:…`、`//cdn…`、任何有 scheme 的 | `undefined`(照舊交給 `<img>`) |
| `docs/shot.png`、`./shot.png`、`../img/a.png` | 以 Markdown 檔所在目錄為基準合併,`.` 與 `..` 正規化 |
| `/Users/me/proj/shot.png` | 原樣(檔案系統的絕對路徑,主行程檢查是否在專案內) |
| 帶 `?raw=1` 或 `#frag` | 去掉 query 與 hash 再算 |
| 帶 `%20` | 先 `decodeURIComponent`,解不開就原樣 |

`markdownPath` 可能是絕對路徑也可能是相對於專案根目錄的路徑(`preview-test.md`),兩種都要能合併。
`..` 往上超過起點時保留在結果裡(例如 `a.md` 旁邊的 `../x.png` 得到 `../x.png`),交給主行程判斷是否跳出專案,
renderer 不自己擋。

- [ ] **Step 1: 寫失敗測試**

`resolveImageSrc`:

```ts
import { describe, expect, it } from 'vitest'
import { resolveImageSrc } from '../src/shared/preview.js'

describe('resolveImageSrc', () => {
  it('遠端與 data URL 不處理', () => {
    for (const src of ['https://img.shields.io/x.svg', 'http://a/b.png', 'data:image/png;base64,AAAA', '//cdn.example.com/a.png', 'mailto:x@y']) {
      expect(resolveImageSrc('/p/README.md', src)).toBeUndefined()
    }
  })

  it('相對路徑以 Markdown 檔所在目錄為基準', () => {
    expect(resolveImageSrc('/p/docs/a.md', 'shot.png')).toBe('/p/docs/shot.png')
    expect(resolveImageSrc('/p/docs/a.md', './img/shot.png')).toBe('/p/docs/img/shot.png')
    expect(resolveImageSrc('/p/docs/a.md', '../shot.png')).toBe('/p/shot.png')
  })

  it('Markdown 檔是相對於專案根目錄的路徑也能合併', () => {
    expect(resolveImageSrc('README.md', 'docs/shot.png')).toBe('docs/shot.png')
    expect(resolveImageSrc('docs/a.md', '../shot.png')).toBe('shot.png')
    expect(resolveImageSrc('a.md', '../x.png')).toBe('../x.png')
  })

  it('絕對路徑原樣', () => {
    expect(resolveImageSrc('/p/a.md', '/Users/me/p/shot.png')).toBe('/Users/me/p/shot.png')
  })

  it('去掉 query 與 hash,解開 %20', () => {
    expect(resolveImageSrc('/p/a.md', 'my%20shot.png?raw=1#top')).toBe('/p/my shot.png')
    expect(resolveImageSrc('/p/a.md', 'bad%zz.png')).toBe('/p/bad%zz.png')
  })
})
```

`tests/read-queue.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { queuedReader } from '../src/renderer/read-queue.js'
import type { PreviewReadResult } from '../src/shared/ipc.js'

describe('queuedReader', () => {
  it('同時最多送出 2 個,前面的回來才送下一個', async () => {
    const pending: (() => void)[] = []
    let inFlight = 0
    let peak = 0
    const api = {
      readPreview: () => new Promise<PreviewReadResult>((resolve) => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        pending.push(() => { inFlight -= 1; resolve({ kind: 'markdown', text: 'x' }) })
      }),
    }
    const read = queuedReader(api)
    const all = Promise.all([1, 2, 3, 4, 5].map((i) => read({ projectId: 'p', path: `${String(i)}.md` })))
    await Promise.resolve()
    expect(pending).toHaveLength(2)
    while (pending.length > 0) {
      pending.shift()?.()
      await new Promise((r) => setTimeout(r, 0))
    }
    expect((await all).map((r) => r.kind)).toEqual(['markdown', 'markdown', 'markdown', 'markdown', 'markdown'])
    expect(peak).toBe(2)
  })

  it('同一個 api 拿到同一個排隊函式;失敗也會讓出名額', async () => {
    let calls = 0
    const api = { readPreview: async (): Promise<PreviewReadResult> => { calls += 1; throw new Error('boom') } }
    expect(queuedReader(api)).toBe(queuedReader(api))
    const read = queuedReader(api)
    const results = await Promise.allSettled([1, 2, 3].map(() => read({ projectId: 'p', path: 'a.md' })))
    expect(results.every((r) => r.status === 'rejected')).toBe(true)
    expect(calls).toBe(3)
  })
})
```

`tests/preview-pane.test.tsx` 加:

```tsx
it('Markdown 裡的相對路徑圖片經 readPreview 讀,以檔案所在目錄為基準;遠端圖片照舊', async () => {
  const asked: string[] = []
  const api = {
    readPreview: async ({ path }: { projectId: string; path: string }): Promise<PreviewReadResult> => {
      asked.push(path)
      if (path.endsWith('.md')) return { kind: 'markdown', text: '![本機](img/a.png)\n\n![遠端](https://example.com/b.png)' }
      return { kind: 'image', mimeType: 'image/png', dataBase64: 'AQID' }
    },
  }
  const { container } = render(<PreviewPane api={api} source={{ kind: 'file', projectId: 'p1', path: '/p/docs/r.md' }} />)
  await screen.findByRole('img', { name: '本機' })
  await vi.waitFor(() => { expect(container.querySelector('img[alt="本機"]')?.getAttribute('src')).toBe('data:image/png;base64,AQID') })
  expect(container.querySelector('img[alt="遠端"]')?.getAttribute('src')).toBe('https://example.com/b.png')
  expect(asked).toEqual(['/p/docs/r.md', '/p/docs/img/a.png'])
})

it('相對路徑圖片讀不到就顯示原因', async () => {
  const api = {
    readPreview: async ({ path }: { projectId: string; path: string }): Promise<PreviewReadResult> =>
      path.endsWith('.md') ? { kind: 'markdown', text: '![x](../../etc/a.png)' } : { kind: 'rejected', message: '不在專案資料夾內' },
  }
  render(<PreviewPane api={api} source={{ kind: 'file', projectId: 'p1', path: 'a.md' }} />)
  expect(await screen.findByText('(圖片讀取失敗:不在專案資料夾內)')).not.toBeNull()
})
```

Markdown 的測試檔加一條:沒有傳 `renderImage` 時,`![a](x.png)` 仍是 `<img src="x.png">`(對話裡的行為不變)。

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/read-queue.test.ts tests/preview-pane.test.tsx` 加上 resolveImageSrc 所在的測試檔
Expected: FAIL

- [ ] **Step 3: resolveImageSrc**

`src/shared/preview.ts` 加:

```ts
/** 有 scheme(https:、data:、mailto:…)或 `//` 開頭的,不是專案裡的檔案。 */
function isRemote(src: string): boolean {
  return src.startsWith('//') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src)
}

function normalize(parts: readonly string[], absolute: boolean): string {
  const out: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    // 往上超過起點時保留 `..`,交給主行程判斷是否跳出專案;renderer 不自己擋。
    if (part === '..' && out.length > 0 && out[out.length - 1] !== '..') out.pop()
    else if (part === '..' && absolute) continue
    else out.push(part)
  }
  return (absolute ? '/' : '') + out.join('/')
}

/**
 * 預覽 Markdown 裡的圖片路徑要交給 preview:read 的那個路徑。
 * 相對路徑以 Markdown 檔所在的目錄為基準,不是專案根目錄:README 裡的 `docs/a.png` 指的是 README 旁邊的 docs。
 * 回傳 undefined 表示是遠端或 data URL,照舊交給 <img>。
 */
export function resolveImageSrc(markdownPath: string, src: string): string | undefined {
  if (isRemote(src)) return undefined
  const bare = src.split(/[?#]/)[0] ?? ''
  let decoded = bare
  try {
    decoded = decodeURIComponent(bare)
  } catch {
    // %zz 這種解不開的,原樣
  }
  if (decoded.startsWith('/')) return decoded
  const dir = markdownPath.split('/').slice(0, -1)
  return normalize([...dir, ...decoded.split('/')], markdownPath.startsWith('/'))
}
```

- [ ] **Step 4: 排隊**

`src/renderer/read-queue.ts`:

```ts
import type { PreviewReadPayload, PreviewReadResult, YesChefApi } from '../shared/ipc.js'

/** 跟主行程的 PREVIEW_MAX_IN_FLIGHT 一樣。renderer 自己排隊,正常使用永遠不會被主行程以「太多」拒絕。 */
const MAX_IN_FLIGHT = 2

type Read = (payload: PreviewReadPayload) => Promise<PreviewReadResult>

const readers = new WeakMap<Pick<YesChefApi, 'readPreview'>, Read>()

/**
 * 一份 README 可能有十幾張相對路徑的圖,每張一個 readPreview。全部同時送出的話,
 * 主行程第 3 個起就回「同時開啟的預覽太多」。這裡排隊,一次最多送 2 個。
 */
export function queuedReader(api: Pick<YesChefApi, 'readPreview'>): Read {
  const cached = readers.get(api)
  if (cached !== undefined) return cached
  let inFlight = 0
  const waiting: (() => void)[] = []
  const release = (): void => {
    inFlight -= 1
    waiting.shift()?.()
  }
  const read: Read = async (payload) => {
    if (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((resolve) => { waiting.push(resolve) })
    inFlight += 1
    try {
      return await api.readPreview(payload)
    } finally {
      release()
    }
  }
  readers.set(api, read)
  return read
}
```

- [ ] **Step 5: Markdown 與 PreviewPane**

`Markdown.tsx`:`MarkdownProps` 加 `readonly renderImage?: (src: string, alt: string) => ReactNode`。
有給時傳 `components={{ img: ({ src, alt }) => renderImage(typeof src === 'string' ? src : '', alt ?? '') }}` 給 `ReactMarkdown`;
`components` 物件用 `useMemo` 依 `renderImage` 建立(react-markdown 以參考判斷)。
沒給時不傳 `components`,行為跟現在一模一樣。`body` 的 `useMemo` 依賴要加上 `renderImage`。
`Markdown` 是 `memo` 過的,呼叫端要傳參考穩定的 `renderImage`。

`PreviewPane.tsx`:

- 讀 Markdown 檔本身也改走 `queuedReader(api)`(原本直接呼叫 `api.readPreview`)。
- 新增一個小元件 `ProjectImage({ api, projectId, path, alt })`:掛載時經 `queuedReader(api)` 讀,
  讀取中顯示 alt(沒有 alt 顯示 `圖片`),成功是 `<img src="data:…" alt={alt}>`,
  失敗顯示 `(圖片讀取失敗:<原因>)`。effect 用 `alive` 旗標,卸載後回來的結果不寫。
- 用 `useCallback` 建 `renderImage`,依賴 `[api, projectId, path]`:
  `resolveImageSrc(path, src)` 是 `undefined` 就回 `<img src={src} alt={alt} />`,否則回 `<ProjectImage … />`。
  只有 Markdown 那一支傳 `renderImage`。

- [ ] **Step 6: 跑測試確認通過,全部跑綠**

Run: `npm run typecheck` → 0 errors
Run: `npx vitest run` → 全部 PASS
Run: `npm run test:coverage` → Stmts ≥ 93、Branch ≥ 86
Run: `npm run build` → 成功

- [ ] **Step 7: Commit**

```bash
git add src/shared/preview.ts src/renderer/read-queue.ts src/renderer/components/Markdown.tsx src/renderer/components/PreviewPane.tsx tests
git commit -m "feat: 預覽 Markdown 裡的相對路徑圖片經 preview:read 顯示"
```

## 驗收

| # | 做什麼 | 應該看到 |
|---|---|---|
| 1 | 專案裡 `docs/r.md` 引用 `img/a.png`、`../top.png`、一張 https 圖,按預覽 | 三張都畫出來;主行程收到的路徑是 `docs/img/a.png` 與 `top.png`(相對於根目錄) |
| 2 | 同一份檔案引用 6 張相對路徑圖 | 6 張都畫出來,沒有「同時開啟的預覽太多」 |
| 3 | 引用 `../../../etc/x.png` | 顯示「(圖片讀取失敗:…)」 |
| 4 | 對話裡模型輸出 `![a](x.png)` | 行為不變 |

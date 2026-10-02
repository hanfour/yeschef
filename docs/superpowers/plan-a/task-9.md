### Task 9: React 版面與 Markdown 渲染元件

**範圍限定**：只做外殼（`main.tsx`／`App.tsx`）與 `Markdown` 元件本身。對話元件（`Conversation`／`Turn`／`ToolCall`，會用到 `ConversationView`）是 Task 9B；批准卡片是 Task 10；Recents 側邊欄的實際內容是 Task 11。這裡的 `App.tsx` 兩欄都只放靜態佔位文字。

`react-markdown@10.1.0` / `remark-gfm@4.0.1` / `rehype-highlight@7.0.2` 的實際行為（HTML 是否被跳脫、`rehype-highlight` 預設語言集、直接渲染 `<Markdown>` 進 jsdom 的輸出）已用真實套件版本、`vite build`、`vitest run`（jsdom）逐一跑過驗證，不是查文件推論；下面「已驗證」字樣指的就是這件事，實際指令與輸出見 Step 5。

**設計依據：`App.tsx` 這一層不畫右窗格的第三欄，這是裁決 9 定案的結論。**

裁決 9（`CONTRACT.md`）判定：規格 §3 的「左＋中窗格」是同一個 React renderer（Recents 側邊欄＋對話），右窗格是子專案 B 的 `agent-view.ts`，一個獨立的 Electron `WebContentsView`，不在這個 React tree 裡渲染。Electron 層維持兩欄，側邊欄與對話的分割是 React 內部的 CSS grid，不經過 Electron 的 view 幾何，也不需要 IPC。Task 7（layout 擴三欄）因此不進計畫，既有的 `splitBounds` 已經夠用。所以這裡的 `App.tsx` 只需要兩個真的 DOM 區塊：`sidebar` 與 `conversation`，不留空白的第三欄佔位 div，那個位置本來就不在這個 React tree 裡。

補一句給下游：`App.tsx` 的兩個佔位區塊會依序被 Task 11（`sidebar` 換成 `Recents`）與 Task 9B（`conversation` 換成 `Conversation` 加輸入框）取代，Task 10 再加批准疊加；本 task 只交付佔位。

側邊欄寬度是 renderer 自己的版面常數，不 import 任何 `src/main/` 的東西。`src/main/layout.ts` 管的是 Electron view 的像素幾何（左 renderer 與右 `WebContentsView` 的分割，裁決 9），側邊欄在 renderer 內部是 CSS grid 的事，兩者沒有共用值的必要，renderer bundle 也不該 import main 的模組。寬度定成 `App.css` 的 CSS 自訂屬性 `--sidebar-width: 280px`。

**Files:**
- Create: `src/renderer/main.tsx`
- Create: `src/renderer/App.tsx`
- Create: `src/renderer/App.css`
- Create: `src/renderer/components/Markdown.tsx`
- Create: `src/renderer/components/Markdown.css`
- Create: `tests/markdown-component.test.tsx`
- Modify: `src/renderer/index.html`（整份改寫）
- Modify: `tsconfig.json`（加一行 `"jsx": "react-jsx"`）
- Modify: `vitest.config.ts`（`test.include` 的 glob 加上 `tsx`，見 Step 1 前的說明）
- Modify: `package.json`（加相依，見 Step 3）

`App.css`／`Markdown.css` 是原始清單沒列的追加檔案：元件與樣式分檔，符合每檔聚焦、避免把版面樣式硬塞進 JSX inline style 的原則。都很小，不算擴大範圍。

`electron.vite.config.ts` 不需要動。renderer 的 build target 已經指向 `src/renderer/index.html`，改的只是在 Task 0 留下的佔位 `index.html` 加一個 `<script>` 指到 `main.tsx`。Vite 的 esbuild 轉譯本來就會讀 `tsconfig.json` 的 `jsx` 設定去轉譯 `.tsx`，不需要另外裝 `@vitejs/plugin-react`。已用 `vite build` 對這幾個檔案實測成功（Step 5）。代價是開發模式沒有 React Fast Refresh（元件狀態不會在存檔後保留，會整頁重載），這是本 task 可以接受的取捨，不在阻塞範圍；之後如果覺得 dev loop 太慢，加這個外掛是後續 task 的事，不影響本 task 產出的正確性。

**Interfaces:**
- Consumes:
  - `function closeIncomplete(text: string): string`（Task 2，`src/shared/markdown-stream.ts`）
- Produces:
  - `interface MarkdownProps { readonly markdown: string; readonly complete: boolean }`
  - `const Markdown: React.MemoExoticComponent<(props: MarkdownProps) => ...>`（`src/renderer/components/Markdown.tsx`）
  - `class MarkdownBoundary extends Component<{ readonly markdown: string; readonly children: ReactNode }, { readonly failed: boolean }>`（`src/renderer/components/Markdown.tsx`，裁決 26：markdown 解析失敗時該 block 退回純文字，供測試直接掛載）
  - `function App(): ...`（`src/renderer/App.tsx`，掛載 sidebar／conversation 兩個佔位區塊）
  - renderer 的掛載點：`main.tsx` 對 `#root` 呼叫 `createRoot(...).render(<App />)`

  **下游用法（Task 9B 必看）**：`Markdown` 的 props 是**兩個原始值**（`markdown: string`、`complete: boolean`），不是整個 `Block`。Task 9B 畫 `Turn`／`ToolCall` 時，對 `kind === 'text'` 的 block 要呼叫 `<Markdown markdown={block.markdown} complete={block.complete} />`，**不能**寫成 `<Markdown block={block} />`。原因見下面「效能決策」一節：把整個 `block` 物件當單一 prop 丟進去，會讓這裡做的 memo 完全失效，因為 `fold()` 每幀都會產生新的 `Block` 物件（即使內容沒變）。

## 效能與體積的兩個技術決策

### 1. 逐幀重新渲染：memo 鍵是「markdown 字串與 complete 的值」，不是 block 物件

規格 §4.2／§5 定的路是：`fold(events) → ConversationView` 是純函式，沒有累積狀態；§5 又明講選「逐幀整份重解析」不做增量解析。合起來看：main 側每幀（約 16ms）把新事件推給 renderer，renderer 每次都重新呼叫 `fold(全部事件)`，而 `fold` 是純函式、不可變資料。這代表**就算某個早就結束的 turn 內容完全沒變，它在新一輪 `fold()` 產出的 `ConversationView` 裡也是一個全新的 `Block` 物件**（`readonly` 陣列與物件字面量每次都重建，這正是 CLAUDE.md 的不可變規則要求的行為，不是 bug）。

如果 `Markdown` 元件的 prop 是「整個 block 物件」，`React.memo` 預設的淺比較會比對 `block` 這個 prop 本身的參照，每幀都不同，於是每個已完成的歷史 block 都會被判定為「變了」而重新跑一次 `closeIncomplete` 加 `react-markdown` 的完整解析管線。這正是逐幀整份重解析要付的代價，且完全是白付的，因為內容根本沒變。

修法不是「更聰明地比較物件」，是**把 prop 換成基本型別**：`markdown: string`、`complete: boolean`。JS 字串是值比較（`"a" === "a"` 恆真，不看是哪次配置出來的），所以只要呼叫端傳的是 `block.markdown` 與 `block.complete` 這兩個基本值而不是整個物件，`React.memo` 的預設淺比較天生就是正確的「內容沒變就跳過重繪」，不需要寫自訂比較函式。元件內部再用 `useMemo(() => ..., [markdown])` 包住 `closeIncomplete` 加 `<ReactMarkdown>` 的建立，雙重保險：即使外層因為別的原因重繪（例如父層多傳了一個沒變的 prop 導致 `memo` 沒擋下來),只要 `markdown` 這個依賴值沒變，也不會重新建立 `ReactMarkdown` 元素。

還在串流中的最後一個 block 每幀 `markdown` 內容都在變長，這條 memo 天生擋不住它、也不該擋：那正是規格 §5 說「訊息長度有限，重解析便宜」所指的那一個 block。這個決策省的是其餘 N-1 個已完成 block 的重複解析，不是省正在串流那一個的。

已用突變測試驗證：把 `useMemo` 的依賴陣列從 `[markdown]` 改成 `[]`，畫面會卡在第一次渲染的內容，串流看起來像是停住了（Step 5 突變 2 有實際紅燈輸出）。

### 2. `rehype-highlight` 只用預設的 `common` 語言集（37 種），不傳 `languages: all`

查了 `rehype-highlight@7.0.2` 原始碼（`lib/index.js`）：`languages` 選項不給就是 `lowlight` 的 `common` 匯出，37 種語言（含 `javascript`／`typescript`／`python`／`bash`／`json`／`yaml`／`sql`／`css`／`xml`／`markdown`／`diff` 等）；`all` 是完整 190 種。也就是說**「只註冊常用語言」是這個套件不寫 `languages` 選項時的內建行為，不需要自己動手挑一份清單去維護**。維護一份子集清單只會製造一個要跟著 highlight.js 版本更新的額外負擔，解決一個套件作者已經解決過的問題。

體積差異已用 `vite build`（production, minify）實測，把 `Markdown` 元件真的接進一個入口點量測（不是憑印象）：

| `languages` 選項 | JS 產出（min） | gzip |
|---|---:|---:|
| 不傳（預設 `common`，37 種） | 513.49 kB | 159.34 kB |
| 傳 `all`（190 種） | 1,256.48 kB | 407.34 kB |

`all` 比 `common` 重了約 248 kB（gzip 後）。決定：**不傳 `languages` 選項，用預設值**。理由除了體積，還有一個：`rehype-highlight` 對辨識不出的語言不會丟例外：原始碼裡遇到 `Unknown language` 只是呼叫 `file.message`（等於一筆警告）然後 `return`，該 code block 保留純文字不高亮，不會讓整則訊息壞掉。這剛好符合規格 §8「markdown 解析失敗，該 block 退回純文字，不讓整則訊息壞掉」的精神，即使遇到 37 種之外的語言也一樣安全，不需要額外包 try/catch。

## `vitest.config.ts`：`jsdom` 用 per-file 註記，`include` 加 `tsx`

**決定**：`tests/markdown-component.test.tsx` 檔案最上方加 `// @vitest-environment jsdom` 這一行註記（Vitest 官方支援的逐檔覆寫語法），`vitest.config.ts` 的 `environment` 不動。`test.include` 則必須改：現在是 `'tests/**/*.test.ts'`，`.tsx` 測試檔完全不會被收進來（在本 repo 實測 `npx vitest run tests/foo.test.tsx` 得到「No test files found」）。改成 `'tests/**/*.test.{ts,tsx}'`，這一行是 Step 1 的一部分，寫測試之前先改。

理由：現有 4 個測試檔（`layout`／`cdp`／`ipc`／`measure-memory`；`spawn-args` 已在 Task 0 刪除）全是純 Node 函式測試，沒有一個碰 DOM。把 `vitest.config.ts` 的 `test.environment` 整個改成 `'jsdom'` 會讓這 4 個檔案也套上 jsdom 全域（`window`／`document`／`navigator`），其中 `measure-memory.test.ts` 量的是真實 process 記憶體，跟渲染完全無關，沒理由承擔 jsdom 初始化的額外開銷與潛在的全域污染風險。per-file 註記把影響範圍精確收在唯一需要它的檔案，改動也只有一行。

`package.json` 需要加 `jsdom` 當 devDependency（環境套件本身，Vitest 執行期才會真的 `require` 它），這件事跟上面的「加在哪」是兩回事，兩者都需要。

- [ ] **Step 1: 寫失敗的測試**

`tests/markdown-component.test.tsx`：

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { Markdown, MarkdownBoundary } from '../src/renderer/components/Markdown.js'

afterEach(() => {
  cleanup()
})

/** 涵蓋表格、程式碼圍欄、行內程式碼、粗體四種語法，跟 Task 2 的 CRAFTED 同一份文件。 */
const CRAFTED = [
  '# 標題',
  '',
  '這是一段**粗體**與 `行內程式碼` 的文字。',
  '',
  '| 欄位 | 說明 |',
  '|---|---|',
  '| foo | 第一列 |',
  '',
  '```ts',
  'const x: number = 1',
  '```',
  '',
  '結尾，含 `token` 與 **強調**。',
].join('\n')

describe('Markdown', () => {
  it('表格渲染成對應的 DOM 元素', () => {
    const { container } = render(
      <Markdown markdown={'| a | b |\n|---|---|\n| 1 | 2 |'} complete />
    )
    expect(container.querySelector('table')).not.toBeNull()
    expect(container.querySelectorAll('th')).toHaveLength(2)
    expect(container.querySelectorAll('td')).toHaveLength(2)
  })

  it('程式碼區塊渲染成 pre/code 並套用語法高亮', () => {
    const { container } = render(<Markdown markdown={'```js\nconst x = 1\n```'} complete />)
    expect(container.querySelector('pre code')).not.toBeNull()
    // 語法高亮的 span 存在，確認 rehype-highlight 真的接上了，不是只有 <pre><code> 空殼
    expect(container.querySelector('.hljs-keyword')).not.toBeNull()
  })

  it('行內程式碼渲染成 code，且不在 pre 裡面', () => {
    const { container } = render(<Markdown markdown="hello `world`" complete />)
    const code = container.querySelector('code')
    expect(code).not.toBeNull()
    expect(code?.closest('pre')).toBeNull()
  })

  it('complete 為 false 時尾端有游標，為 true 時沒有', () => {
    const streaming = render(<Markdown markdown="hi" complete={false} />)
    expect(streaming.container.querySelector('.markdown-cursor')).not.toBeNull()

    const done = render(<Markdown markdown="hi" complete />)
    expect(done.container.querySelector('.markdown-cursor')).toBeNull()
  })

  it('原始 <script> 不會被執行，只以文字呈現', () => {
    const { container } = render(
      <Markdown markdown="before <script>alert(1)</script> after" complete />
    )
    expect(container.querySelector('script')).toBeNull()
    expect(container.textContent).toContain('<script>alert(1)</script>')
  })

  it('帶 onerror 的 <img> 不會被建成真的 DOM 元素', () => {
    const { container } = render(
      <Markdown markdown="<img src=x onerror=alert(1)>" complete />
    )
    expect(container.querySelector('img')).toBeNull()
  })

  it('未完成的 markdown 不會讓元件崩潰：每個前綴都渲染出東西且不拋錯', () => {
    for (let i = 1; i <= CRAFTED.length; i += 1) {
      const prefix = CRAFTED.slice(0, i)
      expect(() => {
        const { container, unmount } = render(<Markdown markdown={prefix} complete={false} />)
        // 用「掛了一個元素」而非「文字不為空」判斷有渲染出東西：
        // 單一 `#`（合法但無文字的 ATX 標題）這種前綴，textContent 是空的，
        // 但 wrapper 底下確實掛了 <h1></h1>，不是渲染失敗。
        expect(container.firstElementChild).not.toBeNull()
        unmount()
      }).not.toThrow()
    }
  })

  // 這一條專門擋「拿掉 closeIncomplete 這一步」的錯誤實作：
  // 表格資料列送到一半（`| f`，還沒收到第二欄與收尾的 |）時，
  // closeIncomplete 會把這一列整條扣住，畫面只有表頭；
  // 拿掉這一步，remark-gfm 會把 `| f` 當成一列已完成的資料列直接渲染出 <td>f</td>，
  // 使用者會看到半列資料閃一下，下一個 token 到齊後內容才「跳一下」變成正確的列。
  it('串流中的表格資料列在收尾前不會提前渲染出資料格', () => {
    const partial = '| 欄位 | 說明 |\n|---|---|\n| f'
    const { container } = render(<Markdown markdown={partial} complete={false} />)
    expect(container.querySelector('table')).not.toBeNull()
    expect(container.querySelector('tbody')).toBeNull()
    expect(container.querySelectorAll('td')).toHaveLength(0)
  })

  // 這一條專門擋「memo 的依賴陣列寫錯」（例如把 [markdown] 誤寫成 []）：
  // 那樣的錯誤實作會讓元件第一次渲染後就再也不重新解析，畫面卡在第一幀，
  // 逐字串流會整段停住不動。
  it('markdown 內容改變時，畫面要換成新內容（防止 memo 依賴寫錯）', () => {
    const { container, rerender } = render(<Markdown markdown="第一段" complete={false} />)
    expect(container.textContent).toContain('第一段')

    rerender(<Markdown markdown="第一段，接上更多字" complete={false} />)
    expect(container.textContent).toContain('第一段，接上更多字')
  })
})

// 裁決 26：markdown 解析失敗時該 block 退回純文字，不讓整則訊息壞掉。
// 直接掛載 MarkdownBoundary（不經過 Markdown），子元件在 render() 就 throw，
// 用來確認退回邏輯本身，跟 react-markdown 會不會真的拋錯是兩回事。
describe('MarkdownBoundary', () => {
  function Boom(): never {
    throw new Error('boom')
  }

  it('子元件渲染拋錯時，退回顯示傳入的 markdown 純文字', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { container } = render(
      <MarkdownBoundary markdown={'# 標題\n\n未完成的 **粗體**'}>
        <Boom />
      </MarkdownBoundary>
    )
    const fallback = container.querySelector('pre.markdown-fallback')
    expect(fallback).not.toBeNull()
    expect(fallback?.textContent).toBe('# 標題\n\n未完成的 **粗體**')
    consoleError.mockRestore()
  })

  it('markdown 換掉之後重設，children 不再拋錯時改顯示 children', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { container, rerender } = render(
      <MarkdownBoundary markdown="第一段">
        <Boom />
      </MarkdownBoundary>
    )
    expect(container.querySelector('pre.markdown-fallback')).not.toBeNull()

    rerender(
      <MarkdownBoundary markdown="第二段">
        <p>正常內容</p>
      </MarkdownBoundary>
    )
    expect(container.querySelector('pre.markdown-fallback')).toBeNull()
    expect(container.textContent).toContain('正常內容')
    consoleError.mockRestore()
  })
})
```

- [ ] **Step 2: 執行測試，確認失敗**

先確認 `vitest.config.ts` 的 `include` 已改成 `'tests/**/*.test.{ts,tsx}'`。若看到「No test files found」，是 glob 沒改，不是預期的失敗。

Run: `npm test tests/markdown-component.test.tsx`
Expected: FAIL，無法解析 `../src/renderer/components/Markdown.js`（檔案還不存在），也無法解析 `@testing-library/react`（還沒裝）。

- [ ] **Step 3: 寫最小實作**

**3a. `package.json`**：`dependencies` 加四個、`devDependencies` 加五個，版本用 2026-09-02 當天 `npm view` 查到的最新版釘死：

```diff
   "dependencies": {
+    "react": "^19.2.8",
+    "react-dom": "^19.2.8",
+    "react-markdown": "^10.1.0",
+    "remark-gfm": "^4.0.1",
+    "rehype-highlight": "^7.0.2"
   },
```

Task 0 已把 `@xterm/*`、`node-pty`、`@electron/rebuild` 移除；`@anthropic-ai/claude-agent-sdk` 由 Task 7 加（裁決 24），此時 `dependencies` 只有它一項。

```diff
   "devDependencies": {
     "@types/node": "^26.4.0",
+    "@types/react": "^19.2.18",
+    "@types/react-dom": "^19.2.5",
+    "@testing-library/react": "^16.3.3",
+    "jsdom": "^30.0.1",
     "@vitest/coverage-v8": "^4.1.11",
     "electron": "^44.0.0",
     "electron-vite": "^5.0.0",
     "typescript": "^7.0.2",
     "vite": "^7.3.6",
     "vitest": "^4.1.11"
   },
```

不加 `@testing-library/jest-dom`：上面的測試全部用 `.not.toBeNull()`／`.toHaveLength()`／`.toContain()`，都是 vitest 內建的 `expect` 就有的斷言，沒有用到 `toBeInTheDocument()` 這類 jest-dom 專屬 matcher，裝了也是死重量。

**3a 之後（裁決 24）：** 改完 `package.json` 立刻跑一次安裝。

Run: `npm install`
Expected: 成功結束，`node_modules/react` 存在。

**3b. `tsconfig.json`**：只加一行。

```diff
     "strict": true,
     "noUncheckedIndexedAccess": true,
     "esModuleInterop": true,
     "skipLibCheck": true,
+    "jsx": "react-jsx",
     "types": ["node"]
```

`"types"` 陣列不用加 `"react"`。已用 `tsc --noEmit` 實測：只要檔案本身有 `import { ... } from 'react'`（本 task 每個 `.tsx` 都有），`@types/react` 對全域 `JSX` 命名空間的擴充就會被 program 讀到，`"types": ["node"]` 這個限制只擋「沒被任何檔案匯入、純靠自動全域掃描」的套件，不擋顯式 import 帶進來的型別。唯一要避開的坑是**不要**幫函式回傳型別標 `: JSX.Element`：那樣寫需要額外顯式 import `JSX` 型別（TypeScript 5.1 之後 automatic JSX runtime 的已知限制），不標註、讓 TS 自己推論回傳型別就沒事，也更省事。下面所有元件都不標。

**3c. `src/renderer/index.html`（整份改寫）**：

```html
<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="utf-8" />
    <title>yeschef</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

**3d. `src/renderer/main.tsx`**：

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'

const container = document.getElementById('root')
if (!container) {
  throw new Error('yeschef: index.html 缺少 #root，renderer 無法掛載')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
```

沒有 `#root` 就丟出明確錯誤而不是靜默失敗，呼應全域約束「不得靜默丟棄」：找不到掛載點是設定錯誤，應該讓它在畫面上炸出一個看得到的錯誤，不是留一個空白視窗讓人猜發生了什麼事。

**3e. `src/renderer/App.tsx`**：

```tsx
import './App.css'

/**
 * 三窗格架構（規格 §3）裡「左＋中」這一個 React renderer（裁決 9）。
 *
 * 右窗格（agent-view，子專案 B）是獨立的 Electron WebContentsView，Electron 層
 * 維持兩欄，不在這個 tree 裡渲染，這裡也不留空白第三欄佔位：那個位置由主程序決定，
 * 跟這裡的 CSS 佈局無關。
 *
 * 側邊欄寬度是 renderer 自己的版面常數（App.css 的 --sidebar-width），不 import
 * 任何 src/main/ 的東西：主程序的 layout.ts 管的是 Electron view 的像素幾何，
 * 側邊欄在這裡是 CSS grid 的事，兩者沒有共用值的必要。
 *
 * 側邊欄與對話目前都只有靜態佔位，會依序被下游 task 取代：
 * - sidebar → Recents（Task 11）
 * - conversation → Conversation 加輸入框（Task 9B），Task 10 再加批准疊加
 */
export function App() {
  return (
    <div className="app">
      <aside className="sidebar">
        <p className="placeholder">Recents（Task 11）</p>
      </aside>
      <main className="conversation">
        <p className="placeholder">對話（Task 9B／10）</p>
      </main>
    </div>
  )
}
```

**3f. `src/renderer/App.css`**：

```css
html,
body,
#root {
  height: 100%;
  margin: 0;
}

.app {
  --sidebar-width: 280px;

  display: grid;
  grid-template-columns: var(--sidebar-width) 1fr;
  height: 100%;
  font-family: ui-monospace, Menlo, monospace;
  color: #d8dcd4;
  background: #12140f;
}

.sidebar {
  border-right: 1px solid #2a2d24;
  overflow-y: auto;
}

.conversation {
  overflow-y: auto;
}

.placeholder {
  padding: 12px;
  opacity: 0.6;
}
```

**3g. `src/renderer/components/Markdown.tsx`**：

```tsx
import { Component, memo, useMemo, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { closeIncomplete } from '../../shared/markdown-stream.js'
import './Markdown.css'

export interface MarkdownProps {
  readonly markdown: string
  readonly complete: boolean
}

// 模組層級常數，不是每次渲染重建的陣列字面量：react-markdown 拿 remarkPlugins／
// rehypePlugins 陣列的參照去判斷要不要重跑 unified 的 processor 快取，如果這兩個
// 陣列每次渲染都是新的字面量，等於每次都告訴它「外掛設定變了」，白白多一層失效。
const remarkPlugins = [remarkGfm]
const rehypePlugins = [rehypeHighlight]

interface MarkdownBoundaryProps {
  readonly markdown: string
  readonly children: ReactNode
}

interface MarkdownBoundaryState {
  readonly failed: boolean
}

/**
 * markdown 解析失敗時該 block 退回純文字，不讓整則訊息壞掉（裁決 26）。
 * React 19 仍只能用類別元件攔截子樹渲染時拋出的錯誤，沒有對應的 hooks 寫法。
 */
export class MarkdownBoundary extends Component<MarkdownBoundaryProps, MarkdownBoundaryState> {
  state: MarkdownBoundaryState = { failed: false }

  static getDerivedStateFromError(): MarkdownBoundaryState {
    return { failed: true }
  }

  componentDidUpdate(prevProps: MarkdownBoundaryProps) {
    if (this.props.markdown !== prevProps.markdown && this.state.failed) {
      this.setState({ failed: false })
    }
  }

  render() {
    if (this.state.failed) {
      return <pre className="markdown-fallback">{this.props.markdown}</pre>
    }
    return this.props.children
  }
}

/**
 * 把一段可能未完成的 markdown 字串渲染成內容。
 *
 * 逐字串流下每幀都可能重新收到同一個 block 的最新內容（規格 §5：逐幀整份
 * 重解析，不做增量解析）。解析前一律先過 closeIncomplete（Task 2）把奇數圍欄、
 * 未閉合的行內標記、寫到一半的表格列處理掉，再交給 react-markdown，不分
 * complete 是 true 還是 false 都跑這一步：complete 為 true 時的輸入本來就是
 * 結構完整的文字，closeIncomplete 對它是不動作（Task 2 已證明「完整文件原樣
 * 通過」），統一跑一次比分兩條路徑判斷更簡單，也不會漏掉「以為完整結果其實
 * 是舊資料」這種特殊情況。
 *
 * 不用 rehype-raw：react-markdown 預設就不把 markdown 裡的原始 HTML 解析成
 * 真的元素（模型輸出的 `<script>`／`<img onerror=...>` 會被當成文字跳脫顯示），
 * 這正是規格 §5.1 選 react-markdown 而非「轉 HTML 字串+ dangerouslySetInnerHTML」
 * 的理由。加 rehype-raw 或任何把原始 HTML 放行的外掛都會打破這個保護，本元件
 * 刻意不加。
 *
 * ReactMarkdown 外面包一層 MarkdownBoundary（裁決 26）：react-markdown 在渲染期
 * 解析失敗會拋錯，沒有它會一路炸到 React 根，一個 block 壞掉就變成整則訊息消失。
 * 接住之後改顯示原始 markdown 純文字，下一幀內容換了（markdown prop 改變）才
 * 重新嘗試解析。
 */
function MarkdownImpl({ markdown, complete }: MarkdownProps) {
  const body = useMemo(() => {
    const safe = closeIncomplete(markdown)
    return (
      <MarkdownBoundary markdown={markdown}>
        <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>
          {safe}
        </ReactMarkdown>
      </MarkdownBoundary>
    )
  }, [markdown])

  return (
    <div className="markdown-block">
      {body}
      {!complete && <span className="markdown-cursor" aria-hidden="true" />}
    </div>
  )
}

// 用 memo 包起來，且 props 只收基本型別（markdown 字串、complete 布林值），
// 不收整個 Block 物件，理由見計畫的「效能決策」一節，呼叫端必須配合這個約定。
export const Markdown = memo(MarkdownImpl)
```

**3h. `src/renderer/components/Markdown.css`**：

```css
.markdown-block {
  white-space: normal;
}

.markdown-cursor {
  display: inline-block;
  width: 0.5em;
  height: 1em;
  vertical-align: text-bottom;
  background: currentColor;
  animation: markdown-cursor-blink 1s steps(1) infinite;
}

@keyframes markdown-cursor-blink {
  50% {
    opacity: 0;
  }
}
```

- [ ] **Step 4: 執行測試，確認通過**

Run: `npm test tests/markdown-component.test.tsx`
Expected: PASS，11 個測試（9 個 `Markdown` 加 2 個 `MarkdownBoundary`，裁決 26）。實跑輸出：

```
 Test Files  1 passed (1)
      Tests  11 passed (11)
   Duration  922ms (transform 38ms, setup 0ms, import 174ms, tests 352ms, environment 311ms)
```

Run: `npm run typecheck`
Expected: 無錯誤。這一步已用上面完整的九個檔案（`main.tsx`／`App.tsx`／`App.css`／`Markdown.tsx`／`Markdown.css`／`index.html`／`tsconfig.json` 的 diff／`package.json` 的 diff／測試檔）在一個獨立目錄裡裝了真實版本的套件實測過 `tsc --noEmit`，通過，不是憑印象寫的程式碼。

Run: `npm test`
Expected: PASS，總數在既有基礎上加 11。實測（Task 0 的 4 個既有測試檔加本 task 加 Task 2）：`Test Files 6 passed (6)`、`Tests 72 passed (72)`。

- [ ] **Step 5: 突變測試（強制步驟，已用上面同一份實作跑過，不是紙上談兵）**

三個突變，每一個都已經照 Step 3 的完整程式碼實際改過、跑過 `vitest run` 拿到紅燈、還原後確認回綠燈：

| # | 突變 | 預期紅的測試 | 實測結果 |
|---|---|---|---|
| 1（**強制**：拿掉 closeIncomplete 這一步） | 把 `MarkdownImpl` 裡的 `const safe = closeIncomplete(markdown)` 改成 `const safe = markdown` | 「串流中的表格資料列在收尾前不會提前渲染出資料格」 | 紅。`tbody`／`td` 提前出現：`<tbody><tr><td>f</td><td /></tr></tbody>`，斷言 `toBeNull()` 收到一個真的 `<tbody>` 元素，失敗。其餘測試仍綠（1 failed \| 10 passed） |
| 2 | `useMemo` 的依賴陣列從 `[markdown]` 改成 `[]` | 「markdown 內容改變時，畫面要換成新內容」 | 紅。`AssertionError: expected '第一段' to contain '第一段，接上更多字'`：`rerender` 後畫面沒換，卡在第一次渲染的內容（1 failed \| 10 passed） |
| 3 | 把 `{!complete && <span className="markdown-cursor" .../>}` 改成無條件的 `<span className="markdown-cursor" .../>` | 「complete 為 false 時尾端有游標，為 true 時沒有」 | 紅。`complete: true` 時仍然渲染出 `<span aria-hidden="true" class="markdown-cursor" />`，斷言 `toBeNull()` 收到真的元素，失敗（1 failed \| 10 passed） |
| 4（裁決 26） | `MarkdownBoundary` 的 `getDerivedStateFromError` 改成 `return { failed: false }` | 「子元件渲染拋錯時，退回顯示傳入的 markdown 純文字」與「markdown 換掉之後重設，children 不再拋錯時改顯示 children」 | 紅。子元件拋出的 `Error: boom` 沒被接住，兩條 `MarkdownBoundary` 測試都失敗（2 failed \| 9 passed） |

四次都在改完後單獨跑 `vitest run`，還原程式碼後再跑一次確認回到「11 passed」，且與備份逐位元組比對一致。任何一個突變後測試仍然全綠，代表該條測試沒測到它宣稱要測的東西，要停下來回報。這裡四個都如預期變紅，不需要回報。

（第 5 個非強制項一併做了：拿掉 `rehypePlugins`，只留 `remarkPlugins`，`.hljs-keyword` 那條斷言變紅：`rehype-highlight` 沒接上時 code block 只有裸的 `<pre><code>`，沒有語法高亮的 span，1 failed \| 10 passed。）

- [ ] **Step 6: 執行完整測試套件與建置**

Run: `npm test`
Expected: PASS，總數在前面 task 的基礎上加 11（本 task 新增的 `markdown-component.test.tsx`，含 `MarkdownBoundary` 的 2 條）。

Run: `npm run typecheck`
Expected: 無錯誤。

Run: `npm run build`（`electron-vite build`）
Expected: main／preload／renderer 三端都成功打包，`out/renderer/index.html` 這條鏈含 `main.tsx`／`App.tsx`／`Markdown.tsx`。實跑輸出：`out/renderer/assets/index-*.js  555.26 kB`，超過 vite 的 500 kB chunk size 預設警告門檻，這是 `react` + `react-markdown` 的解析管線加 37 種語法高亮語言本身的重量，不是本 task 的退步；要不要上 code splitting（動態 `import()`）是效能調校階段的事，這裡先記一筆，留給之後量測記憶體與啟動時間的 task 判斷。單獨跑 `npx vite build --config electron.vite.config.ts`（不經 `electron-vite` CLI）會因為解析不了 electron-vite 的三段式設定而失敗（`Could not resolve entry module "index.html"`），這裡改成一律用 `npm run build`。

- [ ] **Step 7: 提交**

```bash
git add src/renderer/main.tsx src/renderer/App.tsx src/renderer/App.css \
  src/renderer/components/Markdown.tsx src/renderer/components/Markdown.css \
  src/renderer/index.html tests/markdown-component.test.tsx \
  tsconfig.json vitest.config.ts package.json package-lock.json
git commit -m "feat: React 版面與 Markdown 渲染元件，逐幀重解析改用基本型別 prop 做 memo"
```

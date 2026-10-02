import { app, BaseWindow, type WebContentsView } from 'electron'
import { attachCdp } from '../src/main/cdp.js'
import { createAgentView } from '../src/main/agent-view.js'

/** 頁面載入完成後，讓跨站 iframe 有時間完成自己的載入與 CDP attach，才去數 target。 */
const LOAD_SETTLE_MS = 9000

/**
 * attachCdp() 回傳之後，遞迴 re-arm 的附著事件級聯（子代 → 對子代再發一次
 * setAutoAttach → 收到孫代的附著事件 → 再對孫代發一次……）還需要一點時間才會
 * 穩定下來，太早讀 getAttachedTargets() 會漏掉還沒附著完成的深層 target。
 */
const ATTACH_SETTLE_MS = 2000

/** 規格判準：跨站 iframe 的 CDP target 附著覆蓋率須達 95%。 */
const COVERAGE_THRESHOLD = 0.95

/**
 * 這些站都含跨站 iframe。若某站已改版，換成同類型的站並在結果文件註明換了哪個、為什麼。
 *
 * Google Maps Embed API 文件頁（上一輪換進來的站）在改用 CDP frame 樹當分母後拿掉了：
 * 它內嵌的 www.google.com iframe 跟頂層 developers.google.com 同 eTLD+1，不是跨站，
 * 在新分母定義下量到 0 個跨站 frame，沒有測試價值（詳見 docs/RESULTS-03-oopif.md）。
 * Cloudflare Turnstile demo 與 Facebook Page Plugin 文件頁在更早一輪就已經拿掉
 * （分別是 closed shadow DOM 結構性盲點、頁面不渲染 widget，換 URL 都解不了）。
 */
const SITES: readonly string[] = [
  'https://developer.mozilla.org/en-US/docs/Web/HTML/Element/iframe',
  'https://docs.stripe.com/payments/quickstart',
  'https://developers.google.com/identity/gsi/web/tools/configurator',
]

interface RawTargetInfo {
  readonly targetId: string
  readonly type: string
  readonly url: string
  readonly parentId?: string
  readonly parentFrameId?: string
}

/**
 * 用 hostname 最後兩段近似 eTLD+1（不是完整 public suffix list）。
 *
 * 已知誤差：對 `co.uk`、`appspot.com` 這種本身就是（或近似）public suffix
 * 的兩段式網域，「取最後兩段」會把整個 `appspot.com` 當成一個 site，而不是
 * 正確的 `X.appspot.com`。這個 spike 的測站清單裡就有一個這樣的網域——
 * `developers-dot-devsite-v2-prod.appspot.com`（Google Identity configurator
 * 頁面裡巢狀的 configurator iframe）。引入正式的 public suffix 套件超出
 * spike 範圍，這裡用簡化規則。
 *
 * 誤差方向對本次判準是有利通過的：這個規則比真正的 eTLD+1 更粗（會把更多
 * 東西判成「同站」），只會讓分母變小、覆蓋率看起來更高，不會漏算成更低。
 * 就本次三站量測而言，這個誤差沒有實際改變任何一個 frame 的分類——
 * `appspot.com` 這個 site 跟頂層 `developers.google.com`（site=`google.com`）
 * 本來就不同，簡化規則跟真正的 eTLD+1 在這個案例上判斷一致，reviewer 已逐
 * frame 核對過（詳見 docs/RESULTS-03-oopif.md）。但這是巧合，不是這個簡化
 * 規則本身可靠的保證。
 */
function approximateSite(rawUrl: string): string | null {
  try {
    const host = new URL(rawUrl).hostname
    if (!host) return null
    const labels = host.split('.')
    return labels.length <= 2 ? host : labels.slice(-2).join('.')
  } catch {
    // about:srcdoc、data: URL 等無法解析出 hostname 的情況，回傳 null。
    return null
  }
}

/**
 * 兩個 URL 是否跨站（eTLD+1 不同）。任一邊判定不出 site（例如 about:srcdoc，
 * 這是 iframe 用 srcdoc 屬性內嵌內容、語意上跟父層同源）保守地當同站處理，
 * 不計入分母——寧可少算，不要把判定不出站別的東西也算進跨站缺口。
 */
function isCrossSite(url: string, topUrl: string): boolean {
  const site = approximateSite(url)
  const topSite = approximateSite(topUrl)
  return site !== null && topSite !== null && site !== topSite
}

interface PageIframeTarget {
  readonly targetId: string
  readonly url: string
  /** 相對頂層文件的巢狀深度：直接子代為 1，孫代為 2，以此類推。 */
  readonly depth: number
  /** 跟自己的直接父層比 eTLD+1 是否跨站；false 代表被排除出分母（同站，或 URL 解析不出 hostname）。 */
  readonly crossSite: boolean
}

/**
 * 從 Target.getTargets() 的全域清單重建這一頁的 frame 樹（沿 parentId／
 * parentFrameId 鏈往下走），列出屬於這一頁的每個 iframe target，並標出巢狀
 * 深度與「跟直接父層比是否跨站」。分母（給 measureSite 用）是這裡面
 * crossSite === true 的子集；crossSite === false 的子集用來做下面
 * findExcludedButAttached() 的一致性檢查。
 *
 * 分母不再靠頁面內 JS 查 DOM：
 * 1. JS 的 document.querySelectorAll／TreeWalker 穿不透另一個跨站 iframe 的
 *    contentDocument，巢狀跨站 iframe 永遠進不了分母（上一輪 detector-blind
 *    大量觸發的根因）。Target.getTargets() 的 parentId 鏈不受這個限制——
 *    Chromium 在瀏覽器行程層級知道完整的 frame 結構，不管是不是跨行程渲染。
 * 2. 「JS 端 contentDocument === null」量的是跨 origin，不是跨 site，會把
 *    同站不同源（例如 www.google.com 內嵌於 developers.google.com，兩者
 *    eTLD+1 都是 google.com）誤判成跨站，量出一個 Chromium 根本不會建立
 *    target 的「缺口」（上一輪 Google Maps Embed 案例）。改成直接比較
 *    eTLD+1，跟 Chromium 自己 site-per-process 的判斷基準一致。
 *
 * 每一層跟「直接父層」比 eTLD+1，不是跟「頂層文件」比：Google Identity
 * configurator 頁面實測到一個「回頭」案例——深度 1 是 appspot.com（跟頂層
 * google.com 跨站），深度 2 是 accounts.google.com/gsi/button（SSO 登入框，
 * 跟頂層同樣是 google.com，但跟它的直接父層 appspot.com 跨站）。若跟頂層比，
 * 這個 SSO 登入框會被判成「同站」而整個消失於分母——但它是本輪從頭到尾要驗證
 * 「遞迴 re-arm 附著不附著得到」的那個真實案例，Chromium 也確實把它獨立成一個
 * target。跟直接父層比才對得上 Chromium 實際的 site isolation 邊界：隔離邊界
 * 發生在「相鄰兩層之間」，不是「這一層跟最外層」。
 */
function findPageIframeTargets(
  targets: readonly RawTargetInfo[],
  topTargetId: string,
  topUrl: string
): readonly PageIframeTarget[] {
  const byParent = new Map<string, RawTargetInfo[]>()
  for (const t of targets) {
    const parentId = t.parentId ?? t.parentFrameId
    if (!parentId) continue
    byParent.set(parentId, [...(byParent.get(parentId) ?? []), t])
  }

  const result: PageIframeTarget[] = []
  const walk = (parentId: string, parentUrl: string, depth: number): void => {
    for (const child of byParent.get(parentId) ?? []) {
      if (child.type === 'iframe') {
        result.push({
          targetId: child.targetId,
          url: child.url,
          depth,
          crossSite: isCrossSite(child.url, parentUrl),
        })
      }
      walk(child.targetId, child.url, depth + 1)
    }
  }
  walk(topTargetId, topUrl, 1)
  return result
}

interface DepthBreakdown {
  readonly depth: number
  readonly total: number
  readonly attached: number
}

/** 把跨站 frame 依深度分組，每組算總數與其中已附著的數量，用於驗證遞迴 re-arm 真的看得到巢狀。 */
function summarizeByDepth(frames: readonly PageIframeTarget[], attachedIds: ReadonlySet<string>): readonly DepthBreakdown[] {
  const depths = [...new Set(frames.map((f) => f.depth))].sort((a, b) => a - b)
  return depths.map((depth) => {
    const atDepth = frames.filter((f) => f.depth === depth)
    return {
      depth,
      total: atDepth.length,
      attached: atDepth.filter((f) => attachedIds.has(f.targetId)).length,
    }
  })
}

interface ExcludedButAttached {
  readonly targetId: string
  readonly url: string
}

/**
 * 一致性檢查（跟 classifySiteStatus 的分類無關，純粹是診斷用的另一條訊號）：
 * 這個 session 附著到的 iframe target 裡，有哪些屬於這一頁的 frame 樹、卻被
 * findPageIframeTargets() 的 eTLD+1 比較判定成「同站」（因此沒被算進
 * crossSiteFrames、沒進分母）？
 *
 * 這個數字大於 0 不代表分母算錯——最常見的原因是 about:srcdoc／about:blank／
 * data: 這類 URL 本來就解析不出 hostname，isCrossSite() 保守地當同站處理
 * （見該函式註解），Chromium 仍然可能為它們建立獨立 target 並附著（MDN 頁面
 * 就有一個 about:srcdoc 的 iframe target，實測 attached=true）。這是預期會
 * 發生的情況，不是 bug。但如果印出來的 URL 不是這幾種已知類型，就代表
 * eTLD+1 比較本身可能有問題，值得回頭檢查。
 *
 * 不把這個檢查接進 classifySiteStatus／加權平均：接進去會讓 MDN 因為那個
 * srcdoc frame 被排除出 measured，跟 reviewer 已經逐 frame 核對過的 5/9/2
 * 結果不一致，也違反「不要動量測邏輯」的邊界。這裡純粹是印出來給人看的
 * 診斷資訊。
 */
function findExcludedButAttached(
  pageIframes: readonly PageIframeTarget[],
  attachedIds: ReadonlySet<string>
): readonly ExcludedButAttached[] {
  return pageIframes
    .filter((f) => !f.crossSite && attachedIds.has(f.targetId))
    .map((f) => ({ targetId: f.targetId, url: f.url }))
}

type SiteStatus = 'measured' | 'no-cross-site-iframe' | 'detector-blind' | 'load-failed'

interface SiteResult {
  readonly site: string
  readonly status: SiteStatus
  readonly crossSiteCount: number
  readonly attachedCount: number
  readonly depthBreakdown: readonly DepthBreakdown[]
  readonly excludedButAttached: readonly ExcludedButAttached[]
  readonly rateLabel: string
  readonly detail?: string
}

/**
 * 分類這一站的量測結果。
 *
 * - crossSiteCount === 0 且 attachedCount === 0：頁面本身沒有跨站 iframe（或全部
 *   同站不同源，被 eTLD+1 篩掉），n/a，不是覆蓋率 100%。
 * - attachedCount > crossSiteCount：結構上不可能發生——attachedCount 的算法
 *   （見 measureSite）是 crossSiteFrames.filter(附著)，天生是 crossSiteCount
 *   的子集，這個分支目前是不可達的防禦性斷言，不是真的會觸發的檢查。真正
 *   會觸發的一致性訊號是 findExcludedButAttached()（見上），那個結果印在
 *   excludedButAttached 欄位，不影響這裡的分類。保留這個分支是防禦性寫法：
 *   萬一日後 attachedCount 的算法改了、不再保證是子集，這裡至少不會悄悄
 *   印出一個不可能的百分比。
 * - 其餘情況（crossSiteCount > 0 且 attachedCount <= crossSiteCount）才是真正
 *   可信的覆蓋率，包含 attachedCount < crossSiteCount（部分覆蓋，正是這個
 *   spike 要抓的風險訊號）。
 */
function classifySiteStatus(crossSiteCount: number, attachedCount: number): SiteStatus {
  if (crossSiteCount === 0 && attachedCount === 0) return 'no-cross-site-iframe'
  if (attachedCount > crossSiteCount) return 'detector-blind'
  return 'measured'
}

function formatRateLabel(status: SiteStatus, crossSiteCount: number, attachedCount: number): string {
  if (status === 'load-failed') return '失敗'
  if (status === 'no-cross-site-iframe') return 'n/a'
  if (status === 'detector-blind') return '偵測失準'
  return `${((attachedCount / crossSiteCount) * 100).toFixed(0)}%`
}

/**
 * 量測單一站點的跨站 iframe 覆蓋率。
 *
 * 分母與分子現在都來自 CDP：分母是 Target.getTargets() 全域清單裡、frame 樹
 * 上屬於這一頁且 eTLD+1 跨站的 iframe target；分子是這些跨站 target 裡有出現在
 * cdp.getAttachedTargets()（這個 session 透過遞迴 re-arm 真正收到附著事件的
 * target，範圍限定在本 session，不是「有任何 client 附著」）的數量。
 *
 * 載入或 CDP 任一環節失敗都在這裡截住，回傳 load-failed，不讓單一站的失敗中止
 * 整個迴圈。
 */
async function measureSite(agent: WebContentsView, site: string): Promise<SiteResult> {
  try {
    await agent.webContents.loadURL(site)
    await new Promise((r) => setTimeout(r, LOAD_SETTLE_MS))

    const cdp = await attachCdp(agent.webContents)
    try {
      await new Promise((r) => setTimeout(r, ATTACH_SETTLE_MS))

      const { targetInfos } = await cdp.send<{ targetInfos: RawTargetInfo[] }>('Target.getTargets')
      const topTarget = targetInfos.find((t) => t.type === 'page')
      if (!topTarget) {
        throw new Error('Target.getTargets() 找不到 type === page 的頂層 target')
      }

      const pageIframes = findPageIframeTargets(targetInfos, topTarget.targetId, topTarget.url)
      const crossSiteFrames = pageIframes.filter((f) => f.crossSite)
      const attachedIds = new Set(
        cdp
          .getAttachedTargets()
          .filter((t) => t.type === 'iframe')
          .map((t) => t.targetId)
      )
      const attachedCrossSite = crossSiteFrames.filter((f) => attachedIds.has(f.targetId))
      const depthBreakdown = summarizeByDepth(crossSiteFrames, attachedIds)
      const excludedButAttached = findExcludedButAttached(pageIframes, attachedIds)

      if (process.env.OOPIF_DEBUG) {
        for (const f of crossSiteFrames) {
          console.log(
            `    DEBUG 跨站 frame depth=${f.depth} attached=${attachedIds.has(f.targetId)} url=${f.url}`
          )
        }
        for (const f of excludedButAttached) {
          console.log(`    DEBUG 同站被排除但已附著 url=${f.url}`)
        }
        for (const err of cdp.getRearmErrors()) {
          console.log(`    DEBUG rearm 失敗：${err.message}`)
        }
      }

      const crossSiteCount = crossSiteFrames.length
      const attachedCount = attachedCrossSite.length
      const status = classifySiteStatus(crossSiteCount, attachedCount)
      return {
        site,
        status,
        crossSiteCount,
        attachedCount,
        depthBreakdown,
        excludedButAttached,
        rateLabel: formatRateLabel(status, crossSiteCount, attachedCount),
      }
    } finally {
      // attachCdp 成功後的 detach 是呼叫端的責任；cdp.ts 只保證 attach 失敗時自動清理。
      cdp.detach()
    }
  } catch (e) {
    return {
      site,
      status: 'load-failed',
      crossSiteCount: 0,
      attachedCount: 0,
      depthBreakdown: [],
      excludedButAttached: [],
      rateLabel: formatRateLabel('load-failed', 0, 0),
      detail: String(e),
    }
  }
}

function formatDepthBreakdown(depthBreakdown: readonly DepthBreakdown[]): string {
  return depthBreakdown.map((d) => `深度${d.depth}: ${d.attached}/${d.total} 附著`).join('，')
}

function printSiteResult(result: SiteResult): void {
  if (result.status === 'load-failed') {
    console.log(`${result.site}\n  失敗：${result.detail ?? '未知錯誤'}`)
    return
  }
  if (result.status === 'detector-blind') {
    console.log(
      `${result.site}\n  !! 偵測失準：跨站 frame ${result.crossSiteCount}，附著 target ${result.attachedCount}` +
        `（附著數超過分母，數字不可信，已排除出加權平均）`
    )
    return
  }
  const depthNote = result.depthBreakdown.length > 0 ? `（${formatDepthBreakdown(result.depthBreakdown)}）` : ''
  console.log(
    `${result.site}\n  跨站 frame ${result.crossSiteCount}，附著 target ${result.attachedCount}，` +
      `覆蓋率 ${result.rateLabel}${depthNote}`
  )
  if (result.excludedButAttached.length > 0) {
    console.log(
      `  同站被排除但已附著的 iframe target ${result.excludedButAttached.length} 個` +
        `（不影響上面的分母／覆蓋率——跟直接父層同 eTLD+1 而被排除，但 Chromium 仍為它們` +
        `建立了獨立 target 並附著，例如 about:srcdoc 或同站不同源的巢狀 frame；` +
        `完整 URL 用 OOPIF_DEBUG=1 看）`
    )
  }
}

interface WeightedAverage {
  readonly totalCrossSite: number
  readonly totalAttached: number
  readonly measuredSiteCount: number
}

/** 加權平均只算 status === 'measured' 的站：n/a、detector-blind、失敗的站都沒有驗到可信的比例，不能拉高或拉低平均。 */
function computeWeightedAverage(results: readonly SiteResult[]): WeightedAverage {
  const measured = results.filter((r) => r.status === 'measured')
  return {
    totalCrossSite: measured.reduce((sum, r) => sum + r.crossSiteCount, 0),
    totalAttached: measured.reduce((sum, r) => sum + r.attachedCount, 0),
    measuredSiteCount: measured.length,
  }
}

async function run(): Promise<void> {
  const win = new BaseWindow({ width: 1400, height: 900 })
  const agent = createAgentView({
    // 探針沒有專案概念:用 cwd 當範圍,http/https 不受這個值影響。
    currentProjectDir: () => process.cwd(),
    logError: (error) => console.error('[spike]', error),
  }, 'persist:agent')
  win.contentView.addChildView(agent)
  agent.setBounds({ x: 0, y: 0, width: 1400, height: 900 })

  const results: SiteResult[] = []
  for (const site of SITES) {
    const result = await measureSite(agent, site)
    printSiteResult(result)
    results.push(result)
  }

  const naCount = results.filter((r) => r.status === 'no-cross-site-iframe').length
  const blindCount = results.filter((r) => r.status === 'detector-blind').length
  const failedCount = results.filter((r) => r.status === 'load-failed').length
  const { totalCrossSite, totalAttached, measuredSiteCount } = computeWeightedAverage(results)

  console.log('========================================')
  console.log(
    `${results.length} 站中 ${measuredSiteCount} 站量到跨站 iframe、${naCount} 站 n/a（無跨站 iframe）、` +
      `${blindCount} 站偵測失準（已排除）、${failedCount} 站載入失敗`
  )

  // 有效性閘門：全部站點都是 n/a、偵測失準或失敗，代表這次量測什麼都沒驗到，數字不能拿去對 95% 判準。
  if (measuredSiteCount === 0) {
    console.log('!!!! 量測無效：沒有任何一站量到可信的跨站 iframe 覆蓋率，這次結果沒有驗到任何附著情況 !!!!')
    console.log('!!!! 以上數字不能用於 95% 判準 !!!!')
    console.log('========================================')
    await new Promise((r) => setTimeout(r, 100))
    app.exit(1)
    return
  }

  const weightedRate = totalAttached / totalCrossSite
  const passed = weightedRate >= COVERAGE_THRESHOLD
  console.log(
    `加權平均：附著 ${totalAttached} / 跨站 frame ${totalCrossSite} = ${(weightedRate * 100).toFixed(1)}%`
  )
  console.log(`判準 95%：${passed ? '通過' : '未通過'}`)
  console.log('========================================')

  app.quit()
}

app
  .whenReady()
  .then(run)
  .catch((e: unknown) => {
    console.error('probe-oopif 執行失敗：', e)
    app.exit(1)
  })

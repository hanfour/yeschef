/**
 * 批准請求與 tool block 的對應（裁決 28）。全部是純函式，不碰 React 也不碰 IPC。
 *
 * 對應的鍵是 tool_use id：`ApprovalAskPayload.toolUseId` 來自 SDK 給 `canUseTool`
 * 的 `options.toolUseID`，`Block.id` 來自同一顆 tool_use 的快照，兩者是同一個值。
 */
import type { ApprovalAskPayload } from '../shared/ipc.js'
import type { ConversationView, Turn } from '../shared/fold.js'
import type { ToolBlock } from './components/Conversation.js'

/**
 * 工具還在跑，還沒有任何了結：這種 block 才是批准請求該找的目標。
 * `streaming-input` 也算，因為批准請求可能比 tool_use 的完整快照先到。
 */
function isOpen(block: ToolBlock): boolean {
  return block.status === 'running' || block.status === 'streaming-input'
}

/**
 * 這個 block 底下還要不要繼續畫卡片。比 `isOpen` 多一個 `awaiting-approval`：
 * 那個狀態是 `applyPendingApprovals` 自己標上去的，而 `renderToolExtra` 拿到的
 * 正是標過的 view，這裡若不認它，卡片會在標記生效的下一幀自己消失。
 *
 * `denied`／`done`／`error` 一律不畫：這三種都是了結狀態，要不是使用者已經
 * 回答（`useApprovals.reply()` 從 pending 移除那一筆），就是主程序逾時或拒絕
 * 後收掉了，兩種情況都不該再讓卡片留著。現行 SDK 對 `canUseTool` 的 deny 只回
 * `is_error` 的 `tool_result`，不發 `permission_denied`，所以逾時或使用者拒絕
 * 之後 block 走到的實際上是 `error` 不是 `denied`（`denied` 這條路目前走不到，
 * 任務 12B 已知未修的一項）；可見記錄留在結果欄。
 */
function stillOpenForCard(block: ToolBlock): boolean {
  return isOpen(block) || block.status === 'awaiting-approval'
}

function toolBlocksOf(turns: readonly Turn[]): readonly ToolBlock[] {
  return turns.flatMap((turn) => turn.blocks.filter((b): b is ToolBlock => b.kind === 'tool'))
}

/**
 * 這筆請求對應到哪個 block。輸入是 `fold()` 直接產出的 raw view，所以狀態只認
 * `running` 與 `streaming-input`（`awaiting-approval` 在那份資料裡不會出現）。
 */
export function matchApproval(
  view: ConversationView,
  ask: ApprovalAskPayload
): ToolBlock | undefined {
  return toolBlocksOf(view.turns).find((block) => block.id === ask.toolUseId && isOpen(block))
}

/**
 * 這個 block 底下要畫哪一筆請求的卡片。輸入是 `applyPendingApprovals` 標過的 view。
 * id 是一對一的，`find` 命中就只有那一筆。
 */
export function findAskForBlock(
  block: ToolBlock,
  pending: readonly ApprovalAskPayload[]
): ApprovalAskPayload | undefined {
  if (!stillOpenForCard(block)) return undefined
  return pending.find((ask) => ask.toolUseId === block.id)
}

/**
 * 把命中的 tool block 的狀態改成 `awaiting-approval`，其餘原樣。
 *
 * `fold()` 永遠不產生這個狀態（Task 4B 的設計判斷：批准走 canUseTool 那條管線，
 * 事件流裡看不到），所以這一層是它唯一的來源。
 *
 * 沒有任何 block 被改到時回傳**原本那個 view 物件**，不是內容相同的新物件：
 * 下游元件會用 `React.memo` 的淺比較擋重繪（裁決 10 同一個理由），每幀無條件
 * 造新物件等於讓那層比較永遠不成立。
 */
export function applyPendingApprovals(
  view: ConversationView,
  pending: readonly ApprovalAskPayload[]
): ConversationView {
  if (pending.length === 0) return view

  let viewChanged = false
  const turns = view.turns.map((turn) => {
    let turnChanged = false
    const blocks = turn.blocks.map((block) => {
      if (block.kind !== 'tool') return block
      if (findAskForBlock(block, pending) === undefined) return block
      if (block.status === 'awaiting-approval') return block
      turnChanged = true
      return { ...block, status: 'awaiting-approval' as const }
    })
    if (!turnChanged) return turn
    viewChanged = true
    return { ...turn, blocks }
  })

  return viewChanged ? { ...view, turns } : view
}

/**
 * view 裡完全找不到那個 id 的請求，要渲染在對話尾端（規格 §8：不得靜默丟棄）。
 * 來源是 `canUseTool` 早於 tool_use 快照到達，對應的 block 還沒進畫面。
 *
 * 判準只看 id 在不在，不看狀態：id 找得到但 block 已經關閉（逾時被 deny、
 * 執行完畢）的那些，卡片本來就該收掉，不能再從對話尾端冒出來一次。
 */
export function unmatchedAsks(
  view: ConversationView,
  pending: readonly ApprovalAskPayload[]
): readonly ApprovalAskPayload[] {
  if (pending.length === 0) return pending
  const ids = new Set(toolBlocksOf(view.turns).map((block) => block.id))
  return pending.filter((ask) => !ids.has(ask.toolUseId))
}

/**
 * 還在等使用者回答的請求：block 還開著（running／streaming-input）的，加上 view 裡
 * 完全找不到 block 的（tool_use 快照還沒到）。block 已了結（done／error）的
 * 請求，要不是使用者已回答（`useApprovals.reply()` 從 pending 移除），就是
 * 主程序逾時或拒絕後收掉了，兩種情況都不該再擋輸入框。輸入是 fold() 的 raw view。
 * pending 為空時回傳同一個陣列，理由同 applyPendingApprovals 的 memo 說明。
 */
export function openAsks(
  view: ConversationView,
  pending: readonly ApprovalAskPayload[]
): readonly ApprovalAskPayload[] {
  if (pending.length === 0) return pending
  const blocks = toolBlocksOf(view.turns)
  const known = new Set(blocks.map((block) => block.id))
  const open = new Set(blocks.filter(isOpen).map((block) => block.id))
  return pending.filter((ask) => open.has(ask.toolUseId) || !known.has(ask.toolUseId))
}

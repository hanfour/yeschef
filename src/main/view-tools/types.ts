/**
 * 右窗格工具的核心資料結構（契約 §5，以規格 §4 為基礎的定稿）。只有型別，
 * 沒有執行期邏輯，所以沒有對應的測試檔；`tsc --noEmit` 是唯一的檢查手段。
 */

export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface Point {
  readonly x: number
  readonly y: number
}

export interface AxNode {
  readonly ref?: string // 可操作角色才有；heading／image 沒有
  readonly role: string
  readonly name: string
  readonly value?: string
  readonly bounds: Rect // 主視窗 viewport 座標（已加 frame offset）
  readonly states: readonly string[] // 見契約 §6 的 states 表
  readonly backendNodeId: number
  readonly sessionId?: string // 主 target 與同行程 frame 為 undefined
}

export interface FrameSnapshot {
  readonly sessionId?: string
  readonly frameId: string
  readonly url: string
  readonly nodes: readonly AxNode[]
}

export interface Snapshot {
  readonly id: number
  readonly takenAt: number
  readonly url: string
  readonly title: string
  readonly scope: 'viewport' | 'full'
  readonly frames: readonly FrameSnapshot[]
  readonly unattachedFrames: number // AX 樹抓不到的 frame 數（裁決 6）
  readonly truncated: number // 超過 400 個節點時被截掉的數量
}

export type InvalidationReason = 'documentUpdated' | 'navigated' | 'userInput'

export interface RefEntry {
  readonly sessionId?: string
  readonly backendNodeId: number
  readonly role: string
  readonly name: string
}

export interface RefTable {
  readonly snapshotId: number
  readonly invalidatedBy?: InvalidationReason
  readonly entries: ReadonlyMap<string, RefEntry>
}

export interface InterventionLog {
  readonly clicks: number
  readonly keys: number
  readonly navigations: number
  readonly fromUrl: string
}

export interface HandoffPending {
  readonly toolUseId: string
  readonly reason: string
  readonly askedAt: number
}

export type HandoffOutcome = 'done' | 'timeout' | 'session-ended'

import { memo, useContext, useMemo, useState, type ReactNode } from 'react'
import { extractImages, redactImages, toDataUrl } from '../../shared/tool-images.js'
import { isRecord } from '../../shared/ipc.js'
import { previewKindOf } from '../../shared/preview.js'
import { PreviewContext } from '../preview-context.js'
import { isPeerToolName } from '../../shared/peer-tools.js'
import { useElapsedSeconds } from '../elapsed.js'
import { blockEquals, type ToolBlock } from './block-equals.js'

export interface ToolCallProps {
  readonly block: ToolBlock
  readonly historical: boolean
  readonly renderExtra?: (block: ToolBlock) => ReactNode
}

const STATUS_LABEL: Record<ToolBlock['status'], string> = {
  'streaming-input': '接收參數中',
  'awaiting-approval': '等待批准',
  denied: '已拒絕',
  running: '執行中',
  done: '完成',
  error: '失敗',
}

export const NO_RESULT_TEXT = '工具沒有回傳結果'
export const HISTORICAL_RAW_TEXT = '這是歷史對話，沒有保存原始輸出'
export const PENDING_RAW_TEXT = '尚未收到原始輸出'

/** JSON.stringify 會對迴圈參照丟例外，也會對 undefined 回傳 undefined，兩種都要接住。 */
export function formatValue(value: unknown): string {
  if (value === undefined) return ''
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

/** 參數裡的檔案路徑:Claude 的 Write、Edit 用 file_path,codex 的截圖用 path。 */
function filePathOf(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined
  const value = input['file_path'] ?? input['path']
  return typeof value === 'string' && value !== '' ? value : undefined
}

function ToolCallImpl({ block, historical, renderExtra }: ToolCallProps) {
  const openPreview = useContext(PreviewContext)
  const previewPath = openPreview === undefined ? undefined : filePathOf(block.input)
  const images = useMemo(() => extractImages(block.result), [block.result])
  const [override, setOverride] = useState<boolean | undefined>(undefined)
  const open = override ?? block.status === 'awaiting-approval'
  const settled = block.status === 'done' || block.status === 'error'
  /** ask_peer 會等到 10 分鐘,只寫「執行中」看不出還要不要等(P 規格 §6.2)。 */
  const waiting = isPeerToolName(block.name, 'ask_peer') && block.status === 'running'
  const waited = useElapsedSeconds(waiting)
  const statusLabel = waiting ? `等同伴回答，已等 ${String(waited)} 秒` : STATUS_LABEL[block.status]

  return (
    <section className="tool-call" data-status={block.status}>
      <button
        type="button"
        className="tool-head"
        aria-expanded={open}
        onClick={() => setOverride(!open)}
      >
        <span className="tool-name">{isPeerToolName(block.name, 'answer_peer') ? '回答同伴' : block.name === '' ? '（未知工具）' : block.name}</span>
        <span className="tool-status">{statusLabel}</span>
        <span className="chevron" aria-hidden="true">{open ? '⌄' : '›'}</span>
      </button>

      {open && (
        <div className="tool-body">
          <h4 className="tool-section-title">參數</h4>
          {block.status === 'streaming-input' ? (
            <pre className="tool-input-partial">{block.inputPartial ?? ''}</pre>
          ) : (
            <pre className="tool-input">
              {block.input === undefined ? '（沒有收到參數）' : formatValue(block.input)}
            </pre>
          )}

          {block.status === 'denied' && (
            <>
              <h4 className="tool-section-title">拒絕原因</h4>
              <p className="tool-denied">{block.deniedReason ?? '（沒有提供拒絕原因）'}</p>
            </>
          )}

          {settled && (
            <>
              <h4 className="tool-section-title">結果</h4>
              {block.result === undefined ? (
                <p className="tool-no-result">{NO_RESULT_TEXT}</p>
              ) : (
                <>
                  {images.map((image, i) => (
                    <div className="tool-image" key={i}>
                      <img src={toDataUrl(image)} alt={`${block.name} 的第 ${String(i + 1)} 張圖`} />
                      {openPreview !== undefined && (
                        <button type="button" className="tool-preview" onClick={() => { openPreview({ kind: 'image', dataUrl: toDataUrl(image), key: `${block.id}:${String(i)}` }) }}>在側邊預覽開啟</button>
                      )}
                    </div>
                  ))}
                  <pre className="tool-result">{formatValue(redactImages(block.result))}</pre>
                </>
              )}
            </>
          )}

          <h4 className="tool-section-title">原始輸出</h4>
          {historical ? (
            <p className="tool-raw-absent">{HISTORICAL_RAW_TEXT}</p>
          ) : block.raw === undefined ? (
            <p className="tool-raw-absent">{PENDING_RAW_TEXT}</p>
          ) : (
            <div className="tool-raw">
              <pre className="tool-stdout">{block.raw.stdout}</pre>
              <pre className="tool-stderr">{block.raw.stderr}</pre>
              {block.raw.interrupted && <p className="tool-interrupted">執行被中斷</p>}
            </div>
          )}
        </div>
      )}

      <div className="tool-extra">
        {/* 只在 done 時畫:Edit 在等批准、還在串流參數時,參數裡已經有 file_path,但檔案還沒改,
            這時預覽看到的是舊內容。error 也不畫,檔案可能沒寫成功。 */}
        {openPreview !== undefined && block.status === 'done' && previewPath !== undefined && previewKindOf(previewPath) !== undefined && (
          <button type="button" className="tool-preview" onClick={() => { openPreview({ kind: 'file', path: previewPath }) }}>預覽</button>
        )}
        {renderExtra?.(block)}
      </div>
    </section>
  )
}

export const ToolCall = memo(
  ToolCallImpl,
  (prev, next) =>
    blockEquals(prev.block, next.block) &&
    prev.historical === next.historical &&
    prev.renderExtra === next.renderExtra
)

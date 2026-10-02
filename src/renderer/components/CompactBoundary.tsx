import './CompactBoundary.css'

interface CompactBoundaryProps {
  readonly trigger: 'manual' | 'auto'
  readonly preTokens?: number
  readonly postTokens?: number
}

const LABEL: Record<CompactBoundaryProps['trigger'], string> = {
  auto: '對話已壓縮',
  manual: '手動壓縮',
}

const formatTokens = (n: number): string => n.toLocaleString('en-US')

/**
 * 壓縮發生的位置。畫成一條分隔線而不是一則訊息:它不是誰說的話,
 * 是 context 在這裡被換成摘要,之後模型記得的東西從 postTokens 那份開始。
 * 數字給使用者看這次壓掉多少,也就是成本曲線被重設到哪裡。
 */
export function CompactBoundary({ trigger, preTokens, postTokens }: CompactBoundaryProps) {
  const range =
    preTokens === undefined
      ? ''
      : postTokens === undefined
        ? formatTokens(preTokens)
        : `${formatTokens(preTokens)} → ${formatTokens(postTokens)}`
  return (
    <div className="compact-boundary" role="separator" aria-label={range === '' ? LABEL[trigger] : `${LABEL[trigger]} ${range}`}>
      <span className="compact-boundary-label">{LABEL[trigger]}</span>
      {range === '' ? null : <span className="compact-boundary-tokens">{range}</span>}
    </div>
  )
}

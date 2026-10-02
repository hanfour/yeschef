import type { ChefTask } from '../../shared/chef.js'

const resolutionLabels = { fixed: '已修正', kept: '保留' } as const

export function ChefUiCheck({ task }: { task: ChefTask }) {
  const check = task.uiCheck
  if (!check?.files.length) return null
  const resolutions = new Map((task.report?.uiFindings ?? []).map((item) => [item.id, item]))
  const skipped = check.skipped ?? []
  const invalidIgnores = check.invalidIgnores ?? []

  return <section className="chef-ui-check" aria-labelledby="chef-ui-check-title">
    <h3 id="chef-ui-check-title">介面檢查</h3>
    {!check.findings.length && !skipped.length && !invalidIgnores.length ? <p>本次掃描沒有發現問題。</p> : null}
    {check.findings.length ? <>
      <h4>需要處理</h4>
      <ol className="chef-ui-check-findings">
      {check.findings.map((finding) => {
        const resolution = resolutions.get(finding.id)
        return <li key={finding.id}>
          <div className="chef-ui-check-heading"><strong>{finding.id} · {finding.ruleId}</strong><span>{finding.severity === 'error' ? '錯誤' : '警告'} · {resolution ? resolutionLabels[resolution.resolution] : '尚未回報'}</span></div>
          <p>{finding.description}</p>
          <code className="chef-ui-check-path">{finding.path}:{finding.line}</code>
          <pre><code>{finding.snippet}</code></pre>
          {resolution?.reason.trim() ? <p className="chef-ui-check-reason">原因：{resolution.reason}</p> : null}
        </li>
      })}
      </ol>
    </> : null}
    {skipped.length ? <>
      <h4>已略過</h4>
      <ul className="chef-ui-check-findings">
        {skipped.map((finding) => <li key={finding.path + ':' + finding.line + ':' + finding.ruleId + ':' + finding.snippet}>
          <div className="chef-ui-check-heading"><strong>{finding.ruleId}</strong><span>{finding.severity === 'error' ? '錯誤' : '警告'} · 已略過</span></div>
          <p>{finding.description}</p>
          <code className="chef-ui-check-path">{finding.path}:{finding.line}</code>
          <pre><code>{finding.snippet}</code></pre>
          <p className="chef-ui-check-reason">原因：{finding.reason}</p>
        </li>)}
      </ul>
    </> : null}
    {invalidIgnores.length ? <>
      <h4>略過註解缺少原因</h4>
      <ul className="chef-ui-check-findings">
        {invalidIgnores.map((directive) => <li key={directive.path + ':' + directive.line + ':' + directive.ruleId}>
          <div className="chef-ui-check-heading"><strong>{directive.ruleId}</strong><span>未生效</span></div>
          <code className="chef-ui-check-path">{directive.path}:{directive.line}</code>
          <pre><code>{directive.snippet}</code></pre>
          <p className="chef-ui-check-reason">這個略過註解缺少原因，因此規則仍會檢查。</p>
        </li>)}
      </ul>
    </> : null}
  </section>
}

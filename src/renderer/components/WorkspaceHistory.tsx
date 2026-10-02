import { useEffect, useMemo, useState } from 'react'
import type { YesChefApi } from '../../shared/ipc.js'
import { PROVIDER_LABELS } from '../../shared/projects.js'
import type { Projects } from '../hooks/useProjects.js'
import { useSessions } from '../hooks/useSessions.js'
import { Sidebar } from './Sidebar.js'
import { Recents, type SessionScope } from './Recents.js'
import './WorkspaceHistory.css'

/** One history region for the workbench, outside conversation and terminal slots. */
export function WorkspaceHistory({ api, projects }: { api: YesChefApi; projects: Projects }) {
  const [scope, setScope] = useState<SessionScope>('project')
  const [refresh, setRefresh] = useState(0)
  const project = projects.active
  const tab = project?.tabs.find(t => t.id === project.activeTabId)
  // Terminals retain the most recently focused native conversation as their history target.
  const target = tab?.contentType === 'conversation' ? tab : project?.tabs.filter(t => t.contentType === 'conversation').sort((a,b) => b.lastFocusedAt - a.lastFocusedAt)[0]
  const provider = target?.provider ?? 'claude'
  const listScope = useMemo(() => ({ projectId: scope === 'all' ? null : project?.id ?? null, provider }), [scope, project?.id, provider])
  const { sessions, current, error } = useSessions(api, refresh, listScope, target?.id ?? null)
  useEffect(() => api.onEvents(payload => { if (payload.events.some(e => e.kind === 'session-end')) setRefresh(n => n + 1) }), [api])
  const threads = scope === 'all' ? projects.view.projects.flatMap(p => p.threads) : project?.threads ?? []
  return <div className="workspace-history">
    <Sidebar>
      <div className="workspace-history-provider">{PROVIDER_LABELS[provider].name} 歷史</div>
      <Recents sessions={sessions} current={current} error={error} threads={threads} scope={scope}
        onScopeChange={setScope}
        onOpen={id => {
          if (!project || !target) return
          if (tab?.id !== target.id) api.activateTab({ projectId: project.id, tabId: target.id })
          api.openHistory(id)
        }}
        onStartNew={() => projects.openConversation(provider)} />
    </Sidebar>
  </div>
}

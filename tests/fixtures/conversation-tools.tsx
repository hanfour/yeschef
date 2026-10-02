import '../../src/renderer/theme.css'
import '../../src/renderer/App.css'
import '../../src/renderer/components/LeftPane.css'
/** Visual QA: real renderer components, synthetic inputs, no model/tool execution. */
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { Conversation } from '../../src/renderer/components/Conversation.js'
import { ConversationPane } from '../../src/renderer/components/ConversationPane.js'
import { DevelopmentDiff } from '../../src/renderer/components/DevelopmentDiff.js'
import { createFakeYesChef, fakeProjects, ONE_PROJECT } from '../helpers/fake-yeschef.js'
import type { ConversationToolsResponse } from '../../src/shared/conversation-tools.js'
const fake = createFakeYesChef({ projects: ONE_PROJECT })
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1kAAAAASUVORK5CYII='
const projects = fakeProjects(ONE_PROJECT).projects
const scope = new URLSearchParams(location.search).get('scene')
function Fixture() {
  const [notice, setNotice] = useState('視覺驗收示例，不會送出模型或工具工作。')
  const api = { ...fake.api, conversationTools: async (request: Parameters<typeof fake.api.conversationTools>[0]): Promise<ConversationToolsResponse> => {
    if (request.action === 'repositories') return { kind: 'repositories', repositories: [{ id: 'demo', label: 'demo' }], warnings: [] }
    if (request.action === 'pick') return { kind: 'attachments', attachments: [{ id: '10000000-0000-4000-8000-000000000001', name: '設計畫面.png', size: 124000, kind: 'image', thumbnail: image }, { id: '10000000-0000-4000-8000-000000000002', name: '需求文件.pdf', size: 98000, kind: 'file' }] }
    if (request.action === 'remove') return { kind: 'attachments', attachments: [] }
    if (request.action === 'send') { setNotice(`已記錄 ${request.attachments.length} 個附件的合成送出事件，沒有呼叫模型。`); return { kind: 'sent' } }
    return { kind: 'diff', scope: request.scope, baseline: request.scope === 'conversation' ? '對話基準 2026-09-21 17:00（a1b2c3d4）' : '目前 HEAD e5f6g7h8', warnings: ['此為合成 diff，未修改 repository。'], files: [{ path: 'src/renderer/components/Conversation.tsx', status: 'modified', patch: '@@ -40,3 +40,5 @@\n const stick = useRef(true)\n-// 使用者只能手動捲回底部\n+const [away, setAway] = useState(false)\n+// 回到最新訊息後繼續追蹤串流\n+setAway(!stick.current)', binary: false, omitted: false }, { path: 'docs/USAGE.md', status: 'added', patch: '@@ -0,0 +1,2 @@\n+# 附件與開發變更\n+在送出前檢查照片與文件。', binary: false, omitted: false }] }
  } }
  return <div className="app"><p style={{ padding: '8px 16px', margin: 0, color: 'var(--label-2)', fontSize: 12 }} role="status">{notice}</p>{scope === 'diff' ? <DevelopmentDiff api={api} conversationId="p-1-conv" /> : scope === 'scroll' ? <Conversation historical={false} view={{ ended: false, turns: Array.from({ length: 25 }, (_, i) => ({ role: i % 2 ? 'assistant' as const : 'user' as const, messageId: `m${i}`, blocks: [{ kind: 'text' as const, complete: true, markdown: `## 驗收訊息 ${i + 1}\n\n這是捲動與回到最新訊息的合成內容。\n\n保留閱讀位置，按下按鈕後回到最後一則。` }] })) }} /> : <div className="pane-area" style={{ flex: 1, minHeight: 0, display: 'flex' }}><ConversationPane api={api} projects={projects} projectId="p-1" conversationId="p-1-conv" provider="codex" isActive /></div>}</div>
}
createRoot(document.getElementById('root')!).render(<Fixture />)

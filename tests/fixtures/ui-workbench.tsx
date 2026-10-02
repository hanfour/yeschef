/** Visual QA only. No IPC, agent, filesystem or command execution. */
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Conversation } from '../../src/renderer/components/Conversation.js'
import { ApprovalCard } from '../../src/renderer/components/ApprovalCard.js'
import { HandoffCard } from '../../src/renderer/components/HandoffCard.js'
import { PeerQuestion } from '../../src/renderer/components/PeerQuestion.js'
import { StatusBar } from '../../src/renderer/components/StatusBar.js'
import type { ConversationView } from '../../src/shared/fold.js'
import '../../src/renderer/theme.css'
import '../../src/renderer/App.css'
import '../../src/renderer/components/LeftPane.css'
import '../../src/renderer/components/Conversation.css'

const view: ConversationView = { ended: false, turns: [
  { role: 'user', blocks: [{ kind: 'text', complete: true, markdown: '請確認 UI 調整後，鍵盤操作與批准流程都能正常使用。' }] },
  { role: 'assistant', blocks: [
    { kind: 'text', complete: true, markdown: '已完成介面整理，正在驗證主要流程。\n\n| 項目 | 結果 |\n| --- | --- |\n| 歷史搜尋 | 已通過 |\n| 草稿保留 | 已通過 |\n| 窄版預覽 | 已通過 |\n\n程式碼與一般文字有不同層級：\n```ts\nconst activeProject = projects.find(project => project.id === activeId)\n```' },
    { kind: 'tool', id: 'read', name: 'Read', input: { file_path: '/example/yeschef/src/renderer/components/ConversationPane.tsx' }, result: '已讀取檔案內容', raw: { stdout: '120 lines inspected', stderr: '', interrupted: false }, status: 'done' },
    { kind: 'tool', id: 'approval', name: 'Bash', input: { command: 'npm test -- tests/conversation-pane.test.tsx tests/app.test.tsx', cwd: '/example/yeschef' }, status: 'awaiting-approval' },
  ] },
] }

function Gallery() {
  const [notice, setNotice] = useState('驗收示例資料 · 按鈕只記錄操作，不會執行工具')
  const scene = new URLSearchParams(location.search).get('scene') ?? 'approval'
  return <div className="app">
    <header className="title-bar" style={{ paddingLeft: 20 }}><span className="app-brand">YesChef · UI 驗收示例</span></header>
    <p style={{ margin: 0, padding: '10px 20px', color: 'var(--label-2)', fontSize: 12 }} role="status">{notice}</p>
    <div className="workbench"><div className="main-column"><div className="pane-area"><main className="conversation">
      {scene === 'approval' ? <Conversation view={view} historical={false} assistantLabel="Codex" renderToolExtra={block => block.id === 'approval' ?
        <ApprovalCard ask={{ requestId: 'qa', projectId: 'qa', conversationId: 'qa', toolUseId: 'approval', toolName: 'Bash', input: block.input }}
          onDecide={(_id, decision) => setNotice(`已記錄 ${decision}，未執行任何工具`)} /> : null} /> :
        <div style={{ padding: 24, overflow: 'auto' }}>
          <HandoffCard block={{ kind: 'tool', id: 'qa-handoff', name: 'request_handoff', input: { reason: '請在右側確認版面，再繼續下一步。' }, status: 'running' }} historical={false} onDone={() => setNotice('已記錄交接完成，未觸發外部操作')} />
          <PeerQuestion question={{ questionId: 'qa-peer', fromLinkId: 'reviewer', provider: 'Claude', text: '請複核窄版與鍵盤流程，指出仍需修正的項目。' }} status={{ kind: 'waiting', waitedSeconds: 42 }} onAnswer={() => setNotice('已記錄示例回答')} onCancel={() => setNotice('已記錄示例取消')} />
          <div className="error-card" role="alert" style={{ marginTop: 16 }}><p className="error-title">暫時無法讀取檔案</p><p className="error-message">請確認路徑仍存在，再重新整理。這是視覺驗收示例。</p></div>
        </div>}
    </main></div></div></div>
    <StatusBar busy={1} pending={1} peerPending={1} cost={{ tokens: 24380, turns: 3 }} />
  </div>
}
createRoot(document.getElementById('root')!).render(<Gallery />)

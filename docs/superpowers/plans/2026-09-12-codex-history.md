# codex 對話的歷史清單 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** codex 對話的側邊欄列出這個專案的 codex thread,點一條就開來看,再輸入就接著那條 thread。

**Architecture:** 資料來源是 codex app-server 協定的 `thread/list`(依 cwd 過濾)與 `thread/items/list`,不解析 `~/.codex/sessions` 的 jsonl。主行程起一支短命的 `codex app-server` 做列表(`createCodexCatalog`),既有的 `SessionListScope` 加選填 `provider`,`SessionSummary` 型別不變。開歷史:`thread/items/list` 取回 items,經既有 mapper 的「完成的 item」路徑畫出來,並把 threadId 記下來讓下一次輸入 `thread/resume`。

**Spec:** `docs/specs/2026-09-11-shell-regions-design.md` 增量 2(「codex 的歷史清單還沒做」);協定 schema 由 `codex app-server generate-json-schema` 產生

## Global Constraints

- TypeScript strict,`noUncheckedIndexedAccess`;不可用 `any` 或 `!`;不可就地修改;繁體中文註解說明為什麼。
- commit 訊息 `<type>: <描述>`,繁體中文,不加 trailer。測試不用 jest-dom。Stmts ≥ 93、Branch ≥ 86。
- 不新增 IPC 頻道:沿用 `session:list` 與 `session:intent:open-history`。
- `thread/list` 的參數固定:`{ cwd: [rootPath], sortKey: 'updated_at', sortDirection: 'desc', limit: 50, archived: false }`;全部專案時不帶 `cwd`。
- 對 app-server 的每次 request 逾時 15 秒;列表用的子程序用完就 kill,不常駐。
- `SessionSummary` 的對應固定:`sessionId ← Thread.id`、`summary ← Thread.preview` 取第一行、去頭尾空白、超過 80 字截斷加 `…`,空的話用 `Thread.id` 前 8 碼、`lastModified ← Thread.updatedAt`(小於 `1e12` 視為秒,乘 1000)、`cwd ← Thread.cwd`、`gitBranch ← Thread.gitInfo?.branch`、`customTitle ← Thread.name`(null 或空字串都當沒有)。

---

### Task 1: codex 的 Recents 清單

**Files:**
- Modify: `src/shared/projects.ts:142-144`(`SessionListScope` 加 `provider?: Provider`)與 `:169-174`(parse)
- Create: `src/main/codex/catalog.ts`
- Modify: `src/main/ipc-bridge.ts:502-520`(`onSessionList` 依 provider 分流)、`IpcBridgeDeps` 加 `codexCatalog`
- Modify: `src/main/index.ts`(建 catalog 並注入)
- Modify: `src/preload/bridge.ts`(`listSessions` 的 payload 逐欄重組時帶上 `provider`)
- Modify: `src/renderer/components/ConversationPane.tsx:156`(codex 也啟用 `useSessions`,scope 帶 provider)與 `:216`(codex 也畫 `Recents`,拿掉 hint 那一支)
- Test: `tests/codex-catalog.test.ts`(新增)、`tests/projects.test.ts` 或 parse 所在的測試檔(加)、`tests/ipc-bridge.test.ts`(加)、`tests/conversation-pane.test.tsx`(改「codex 分頁不查 Claude 的 session 清單」與「codex 分頁的側邊欄不是消失而是有一句說明」兩條)

**Interfaces:**
- `SessionListScope = { projectId: string | null; provider?: Provider }`;沒帶 `provider` 視為 `'claude'`(舊 renderer 相容)。
- `createCodexCatalog(deps: { spawn: SpawnCodex; rootPathOf?: never; logError(e: Error): void; timeoutMs?: number }): { list(cwd?: string): Promise<readonly SessionSummary[]> }`。`spawn` 用既有的 `SpawnCodex`(`src/main/codex/client.ts:27`),測試接假的。
- `toSummary(thread: unknown): SessionSummary | undefined`(export,給測試直接驗對應規則;形狀不對回 undefined 並由 `list` 跳過)。

`catalog.list(cwd)` 的流程:`spawn(cwd ?? process.cwd())` → 用既有 `createRpc`(`src/main/codex/rpc.ts`)握手(照 `client.ts:217-221` 的 `initialize` / `initialized`,`capabilities.experimentalApi: true` 照抄)→ `thread/list` → 逐筆 `toSummary` → `kill`。任何一步失敗都 kill 子程序、log、回空陣列(Recents 顯示錯誤的路徑已經有,`useSessions` 會把 throw 顯示成 `error`;所以失敗要 throw 不是回空,讓側邊欄看得到「列不出來」的原因)。

- [ ] Step 1:寫失敗測試。`codex-catalog.test.ts` 用假 `SpawnCodex`(參考 `tests/codex-client.test.ts` 或現有的假子程序 helper):回一份 `thread/list` 回應含 3 筆(一筆完整、一筆 `name: null` 且 `preview` 多行、一筆 `updatedAt` 是秒),斷言三筆的 `SessionSummary`;`thread/list` 回錯誤時 `list` reject 且子程序被 kill;請求送出的參數與 Global Constraints 那一行完全相同。parse 測試:`{projectId:'p', provider:'codex'}` 收、`provider:'grok'` 不收。ipc-bridge 測試:scope 帶 `provider:'codex'` 時呼叫 `deps.codexCatalog.list(rootPath)` 而不是 `deps.sessions.list`。conversation-pane 兩條既有測試改成:codex 分頁會呼叫 `listSessions` 且 scope 帶 `provider:'codex'`;codex 分頁的側邊欄畫 `.recents`。
- [ ] Step 2:確認失敗。
- [ ] Step 3:實作。`Sidebar` 的 `hint` 仍是必填,codex 這支傳 `Recents` 進去,`CODEX_SIDEBAR_HINT` 常數留著(之後列不出來時可用)或刪掉,二選一並讓測試一致。
- [ ] Step 4:`npm run typecheck`、`npx vitest run`、`npm run test:coverage`、`npm run build` 全過。
- [ ] Step 5:`git commit -m "feat: codex 對話的側邊欄列出這個專案的 thread"`

---

### Task 2: 點一條 codex 歷史就開來看,再輸入就接著它

**Files:**
- Modify: `src/main/codex/mapper.ts`(export 一個 `historyEvents(items: readonly unknown[]): readonly Event[]`,對每個 item 走「完成」那條路,也就是既有 `itemCompleted` 的邏輯)
- Modify: `src/main/codex/catalog.ts`(加 `items(cwd: string, threadId: string): Promise<readonly unknown[]>`,`thread/items/list { threadId, limit: 200 }`,有 `nextCursor` 就翻頁到底)
- Modify: `src/main/codex/conversation.ts:338`(`openHistory` 實作)
- Modify: `src/main/ipc-bridge.ts:461-473`(拿掉「codex 對話不支援」那條路)
- Test: `tests/codex-mapper.test.ts`(加)、`tests/codex-conversation.test.ts`(加)、`tests/codex-catalog.test.ts`(加)、`tests/ipc-bridge.test.ts`(改)

`openHistory(threadId)` 的行為,對照 Claude 那邊 `conversation.ts` 的 `open-history`:
- 正在跑就先 `interruptAndTeardown`(照 `startNew` 的做法)。
- `pushBatch([RESET, ...historyEvents(items), { kind: 'session-end', isError: false }])`,`session-end` 不帶花費(codex 的 items 沒有 token 總數;有的話從最後一個 `turn` 的 usage 取,沒有就不帶)。
- `threadId = 那條`,state 設成 `viewing`(Claude 的 `SessionState` 有 `viewing`,codex 現在只有 `idle` 與 `live`;看 `src/shared/session-state.ts` 決定要不要加,renderer 的 `historical` 旗標靠它)。
- 下一次 `userInput` 走既有的 `ensureClient()` → `thread/resume`,已經會帶 `threadId`。

- [ ] Step 1:寫失敗測試。mapper:三種 item(`agentMessage`、`commandExecution`、`mcpToolCall`)的陣列 → 事件序列跟逐一走 `itemCompleted` 一樣。catalog:`items` 會翻頁(假子程序第一頁回 `nextCursor`,第二頁回 null),參數帶 `threadId`。conversation:`openHistory('t1')` 後 sink 收到 RESET、事件、session-end;之後 `userInput` 觸發 `thread/resume` 帶 `t1`;正在跑時先中斷。ipc-bridge:codex slot 收到 `intentOpenHistory` 會呼叫 `core.openHistory`。
- [ ] Step 2:確認失敗。
- [ ] Step 3:實作。
- [ ] Step 4:全過。
- [ ] Step 5:`git commit -m "feat: codex 對話可以開歷史 thread,再輸入就接著它"`

## 驗收

| # | 做什麼 | 應該看到 |
|---|---|---|
| 1 | 開一個 codex 對話 | 側邊欄有清單,每筆是這個專案裡 codex thread 的第一句話,最新的在上 |
| 2 | 切「全部」 | 其他專案的 thread 也出現,附 cwd |
| 3 | 點一筆 | 對話區換成那條 thread 的內容,角色標示是 codex;狀態列沒有「進行中」 |
| 4 | 在那條上輸入一句 | 回覆接著上文(問它「我們剛才在做什麼」),`~/.codex/sessions` 裡同一個 thread 的 jsonl 變長 |
| 5 | codex 沒登入或 app-server 起不來 | 側邊欄顯示錯誤原因,不是空白 |

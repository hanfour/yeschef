import { createChefService } from './chef/service.js'
import { createChefModelCatalog } from './chef/models.js'
import { createDeadlineReviewer } from './chef/deadline-reviewer.js'
import { CHEF_CHANNEL, ERROR_INTAKE_SETUP_PURPOSE } from '../shared/chef.js'
import { recoverExternalCodexWrites } from './external-codex-activity.js'
import { createActivityLedger } from './activity-ledger.js'
import { createClaudeActivityReader } from './conversation-activity.js'
import { createAttachments } from './attachments.js'
import { createDevelopmentDiff } from './development-diff.js'
import { createPermissionService } from './permissions/service.js'
import { createPermissionReviewer } from './permissions/reviewer.js'
import { PERMISSIONS_CHANNEL } from '../shared/permissions.js'
import { createCodexCatalog } from './codex/catalog.js'
import { createGrokCatalog } from './grok/catalog.js'
import { createChefTools } from './chef/tools.js'
import { createGrokViewTools } from './grok/view-tools.js'
import type { Provider } from '../shared/projects.js'
import { createSharedSkillsService } from './skills/service.js'
import { createSkillsHandler } from './skills/ipc.js'
import { SKILLS_CHANNEL } from '../shared/skills.js'
import { createTestMachinesService } from './test-machines/service.js'
import { createTestMachinesIpcHandler } from './test-machines/ipc.js'
import { TEST_MACHINES_CHANNEL } from '../shared/test-machines.js'
import { ERROR_INTAKE_CHANNEL, ErrorIntakeRequestSchema } from '../shared/error-intake.js'
import { createErrorIntakeService } from './error-intake/service.js'
import { createErrorIntakeIpcHandler } from './error-intake/ipc.js'
import { createErrorIntakeActivation } from './error-intake/activation.js'
import { startChefTask } from './group/start-chef-task.js'
import { GROUP_CHANNEL } from '../shared/group.js'
import { createMerge } from './merge.js'
import { createMergeLocks } from './merge-locks.js'
import { createWorktreeMergeHandler } from './worktree-merge-ipc.js'
import { WORKTREE_MERGE_CHANNEL } from '../shared/worktree-merge.js'
import { nodeSpawnCodex } from './codex/client.js'
import { killAllGrokProcesses } from './grok/client.js'
import { createMailbox, nodeMailboxFs } from './peer/mailbox.js'
import { createPeerRegistry } from './peer/registry.js'
import { createPeerService } from './peer/service.js'
import { createGroupStore } from './group/store.js'
import { createGroupService, type GroupChef } from './group/service.js'
import { createGroupIpcHandler } from './group/ipc.js'
import { MSG as GROUP_MSG, labelFor } from './group/messages.js'
import { GENERAL_THREAD_ID } from '../shared/group.js'
import { createProjectRunConfigStore } from './project-run/config-store.js'
import { discoverProjectRunCandidates } from './project-run/discovery.js'
import { createProjectRunIpcHandler } from './project-run/ipc.js'
import { createProjectRunNodeAdapters } from './project-run/node-adapters.js'
import { createProjectRunRunner } from './project-run/runner.js'
import { app, BaseWindow, WebContentsView, clipboard, dialog, ipcMain, powerSaveBlocker, safeStorage, shell } from 'electron'
import { execFile } from 'node:child_process'
import { createGitRun } from './git-run.js'
import { promisify } from 'node:util'
import { createRemoteClientsWatcher } from './remote-clients.js'
import { randomUUID } from 'node:crypto'
import { constants, existsSync, realpathSync, renameSync, statSync } from 'node:fs'
import { realpath, stat, readFile, writeFile, mkdir, copyFile, rm } from 'node:fs/promises'
import { createTranslateHandler, createTranslateQuery } from './translate-query.js'
import { createTranslator } from './translate.js'
import { createPreviewReader } from './preview-read.js'
import { guardRendererNavigation } from './renderer-guard.js'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getSessionMessages, getSubagentMessages, listSubagents, listSessions, query } from '@anthropic-ai/claude-agent-sdk'
import { createBrowserPlacement } from './browser-placement.js'
import { IPC, parseBrowserBounds, parsePreviewRead, type PreviewReadResult } from '../shared/ipc.js'
import { createAgentView, agentPartitionFor } from './agent-view.js'
import { createBrowserSessions } from './browser-sessions.js'
import { createBrowserCommands } from './browser-commands.js'
import { createBrowserIpcHandlers } from './browser-ipc-handlers.js'
import { createRememberUrl } from './browser-session-hooks.js'
import { createViewSwitch } from './view-switch.js'
import { buildSessionOptions } from './session-args.js'
import { createSessionOptionsFactory } from './session-options.js'
import { createSessionStore, type SessionStore } from './session-store.js'
import { createIpcBridge, type ProjectRuntime, type IpcBridge } from './ipc-bridge.js'
import { createSleepGuard } from './sleep-guard.js'
import { attachCdp } from './cdp.js'
import { SYSTEM_CLOCK } from './agent-host.js'
import { createViewToolServer, type ViewTools } from './view-tools/server.js'
import { createConversationViewServer } from './view-tools/conversation-server.js'
import { startViewTools } from './view-tools/startup.js'
import { viewToolPolicy } from './view-tools/policy.js'
import { killTmuxSession, startTerminalServer } from './terminal-server.js'
import { createProjectsStore, nodeStoreFs } from './projects-store.js'
import { migrateYesChefData, PROJECTS_FILE } from './data-migration.js'
import { createProjectsService, type ProjectsService } from './projects-service.js'
import type { WorktreeDeps } from './worktree.js'
import { initializeGitRepoState, registerProjectsIpc } from './projects-ipc.js'
import { activeConversationId, closeInactiveChefTabs, conversationDir, conversationTabs, findProject, findProjectByTab, focusTab, foregroundConversationId, openConversationTab, removedProjectIds, setActive, setShutdown } from './projects-state.js'
import { VIEW_TOOL_SERVER_NAME } from '../shared/view-tools.js'

/** 狀態檔還是空的時候,用這個環境變數補第一個專案(D 之前唯一的專案目錄,沿用當種子)。 */
const SEED_PROJECT_ENV = 'YESCHEF_PROJECT_DIR'
/** 右窗格會記住的 URL 種類:about:blank 與 data: 錯誤頁不算「上次看的頁面」。 */
const REMEMBERED_URL_SCHEMES: readonly string[] = ['http:', 'https:', 'file:']

/** 建一個帶失敗 URL 與訊息的本地錯誤頁,給窗格 loadURL/loadFile 失敗時用。 */
function buildErrorPageUrl(failedUrl: string, message: string): string {
  const escape = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const html = `<!doctype html><meta charset="utf-8"><style>
    body { font: 14px ui-monospace, Menlo, monospace; background: #12140f; color: #d8dcd4; padding: 2rem; }
    h1 { font-size: 16px; }
    code { color: #f0a0a0; word-break: break-all; }
  </style><h1>[yeschef] 頁面載入失敗</h1><p>URL：<code>${escape(failedUrl)}</code></p><p>${escape(message)}</p>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

function createConversationView(): WebContentsView {
  return new WebContentsView({
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/bridge.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
}

/** dev 模式 renderer 的來源,給導航守衛放行 HMR 的整頁重載;打包後回空物件。 */
function rendererOrigin(): { ownOrigin?: string } {
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (!rendererUrl) return {}
  try {
    return { ownOrigin: new URL(rendererUrl).origin }
  } catch {
    return {}
  }
}

function loadRenderer(view: WebContentsView): void {
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    // dev 模式下設了 YESCHEF_DEVTOOLS=1 才開 DevTools;平常 npm run dev 不彈視窗,打包後的 app 也不會開。
    if (process.env['YESCHEF_DEVTOOLS'] === '1') view.webContents.openDevTools({ mode: 'detach' })
    view.webContents.loadURL(rendererUrl).catch((err: unknown) => {
      console.error('[yeschef] 左窗格載入失敗:', rendererUrl, err)
    })
    return
  }
  const rendererFile = join(import.meta.dirname, '../renderer/index.html')
  view.webContents.loadFile(rendererFile).catch((err: unknown) => {
    console.error('[yeschef] 左窗格載入失敗:', rendererFile, err)
  })
}

function loadAgentPage(view: WebContentsView, url: string): void {
  view.webContents.loadURL(url).catch((err: unknown) => {
    console.error('[yeschef] 右窗格載入失敗:', url, err)
    const message = err instanceof Error ? err.message : String(err)
    if (view.webContents.isDestroyed()) return
    view.webContents.loadURL(buildErrorPageUrl(url, message)).catch((e: unknown) => {
      console.error('[yeschef] 右窗格錯誤頁也載入失敗:', e)
    })
  })
}

function toError(raw: unknown): Error {
  return raw instanceof Error ? raw : new Error(String(raw))
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * 登錄表只存 realpath。SDK 子行程的 cwd、逐字稿目錄名、終端的 pwd 都是 realpath 形式,
 * rootPath 不正規化的話,/tmp 這類 symlink 路徑底下「本專案」的 Recents 永遠比不到。
 * realpath 失敗就回原字串,讓後面的 validateRoot 用它自己的訊息報錯。
 */
function canonicalRoot(dir: string): string {
  try {
    return realpathSync.native(dir)
  } catch {
    return dir
  }
}

/**
 * auto-compact 的視窗(token)。SDK 把值夾在下限 100,000,換算後的門檻是 70,616,
 * 也就是能設到的最低水位(RESULTS-10 實測)。context 到這個水位就壓縮並掉回兩萬多,
 * 之後每一輪的快取讀取量跟著降。使用者已經自己設了環境變數時以他的為準。
 */
const DEFAULT_AUTO_COMPACT_WINDOW = 100_000

const appDataPath = app.getPath('appData')
const migrationFs = { exists: existsSync, rename: renameSync }
const startupMigration = migrateYesChefData(appDataPath, homedir(), migrationFs)
const migrationFailures = startupMigration.failures
for (const conflict of startupMigration.conflicts) {
  console.warn(`[YesChef] 新資料目錄已存在，舊資料保留：${conflict.from}`)
}
for (const failure of migrationFailures) console.error('[YesChef] 資料搬移失敗:', failure)

function autoCompactWindow(): number {
  const raw = Number(process.env['CLAUDE_CODE_AUTO_COMPACT_WINDOW'])
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_AUTO_COMPACT_WINDOW
}

/** 這個資料夾能不能當專案:沿用 A 規格 §2.1 的守衛(絕對路徑、存在、不在 app 自身目錄底下)。 */
function validateRoot(rootPath: string): string | undefined {
  try {
    buildSessionOptions({ projectDir: rootPath, appDir: app.getAppPath() })
    return undefined
  } catch (err) {
    return toError(err).message
  }
}

/** 狀態檔是空的而環境變數有設,就把它加成第一個專案;不可用就記錯誤略過,app 照開。 */
function seedFromEnv(service: ProjectsService, logError: (error: Error) => void): void {
  const dir = process.env[SEED_PROJECT_ENV]
  if (dir === undefined || dir === '' || service.state().projects.length > 0) return
  const reason = validateRoot(dir)
  if (reason !== undefined) {
    logError(new Error(`${SEED_PROJECT_ENV} 不可用,略過:${reason}`))
    return
  }
  service.addProject(canonicalRoot(dir))
}

function shouldRemember(url: string): boolean {
  try {
    return REMEMBERED_URL_SCHEMES.includes(new URL(url).protocol)
  } catch {
    return false
  }
}

export async function createWindow(): Promise<BaseWindow> {
  const logError = (error: Error): void => {
    console.error('[yeschef]', error)
  }
  let skillsError = ''
  const sharedSkills = await createSharedSkillsService(join(app.getPath('userData'), 'shared-skills')).catch(error => {
    logError(toError(error))
    skillsError = `共用 Skills 無法載入：${toError(error).message}`
    return undefined
  })
  // 裁決 7:SDK 型別在 session-store 轉成 SessionSummary,不穿過 IPC。
  const sessions = createSessionStore({ listSessions, getSessionMessages })

  // 規格 §4.1、§6:讀不到主檔退到備份,備份也壞就是空狀態;這些都在 store 裡處理。
  const store = createProjectsStore({
    filePath: join(app.getPath('userData'), PROJECTS_FILE),
    fs: nodeStoreFs,
    logError,
  })
  const service = createProjectsService({
    store,
    initial: await store.load(),
    now: Date.now,
    newId: randomUUID,
    isDir: isDirectory,
    logError,
  })
  seedFromEnv(service, logError)
  const worktree: WorktreeDeps = {
    run: createGitRun(execFile),
    readFile: async (path) => {
      try {
        return await readFile(path, 'utf8')
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
        throw error
      }
    },
    writeFile: (path, text) => writeFile(path, text, 'utf8'),
    mkdir: async (path) => { await mkdir(path, { recursive: true }) },
    copyFile: (source, destination) => copyFile(source, destination, constants.COPYFILE_EXCL),
    rm: (path) => rm(path, { force: true }),
    logError,
  }
  await initializeGitRepoState(service, worktree)

  const win = new BaseWindow({ width: 1600, height: 900, title: 'YesChef', titleBarStyle: 'hiddenInset', vibrancy: 'sidebar' })
  const conversationView = createConversationView()
  guardRendererNavigation(conversationView.webContents, { openExternal: (url) => shell.openExternal(url), logError, ...rendererOrigin() })
  const switcher = createViewSwitch()

  win.contentView.addChildView(conversationView)

  const placement = createBrowserPlacement({
    view: switcher,
    zoomFactor: () => conversationView.webContents.getZoomFactor(),
    contentSize: () => {
      const { width, height } = win.getContentBounds()
      return { width, height }
    },
  })
  // renderer 佔滿整個視窗,瀏覽器疊在它上面、擺在 renderer 回報的位置(規格 §3)。
  const applyLayout = (): void => {
    const { width, height } = win.getContentBounds()
    conversationView.setBounds({ x: 0, y: 0, width, height })
    placement.relayout()
  }
  applyLayout()
  win.on('resize', applyLayout)

  const onBrowserBounds = (event: Electron.IpcMainEvent, raw: unknown): void => {
    // 只收左邊 renderer 送的:右窗格沒有 preload,理論上送不過來,但這是視窗層級的擺放,
    // 多一道檢查的成本是零。
    if (event.sender !== conversationView.webContents) return
    const payload = parseBrowserBounds(raw)
    if (payload === null) {
      logError(new Error(`${IPC.browserBounds} 收到格式不對的 payload`))
      return
    }
    placement.report(payload.rect)
  }
  ipcMain.on(IPC.browserBounds, onBrowserBounds)
  // 就近註冊收尾,不放進後面那個 closed handler:那個 handler 要等 view tools 與終端機
  // 啟動完才掛上,這個全域監聽器不必等那麼久。
  win.once('closed', () => {
    ipcMain.removeListener(IPC.browserBounds, onBrowserBounds)
  })

  // D2:每個對話分頁一組 sessionOptions 與一份右窗格 MCP server;每對話瀏覽器規格 §3、§4.3:
  // 瀏覽器本身等第一次工具呼叫才建,每個對話各自一份,不再共用單一 view tools。
  const appDir = app.getAppPath()
  // 裁決 T7-2:resume 時 cwd 用那場對話原本的目錄,但目錄已被搬走或刪掉就退回專案 rootPath。
  const liveCwd: Pick<SessionStore, 'cwdOf'> = {
    cwdOf: (id) => {
      const cwd = sessions.cwdOf(id)
      return cwd !== undefined && isDirectory(cwd) ? cwd : undefined
    },
  }
  // P 規格 §3.1:信箱在專案裡,副本在 userData。
  const mailDir = join(app.getPath('userData'), 'yeschef-mail')
  const peer = createPeerService({
    registry: createPeerRegistry(),
    mailboxFor: (projectId, rootPath) => createMailbox({
      dir: join(rootPath, '.yeschef', 'mail'),
      ignoreDir: join(rootPath, '.yeschef'),
      mirrorDir: join(mailDir, projectId),
      fs: nodeMailboxFs,
      logError,
    }),
    clock: SYSTEM_CLOCK,
    newId: randomUUID,
    logError,
  })
  // 規格 §7:上一次沒收完的問題,啟動時一律取消。
  peer.cancelPendingOnStartup(service.state().projects.map((p) => ({ projectId: p.id, rootPath: p.rootPath })))
    .catch((cause: unknown) => { logError(toError(cause)) })

  const projectDirOfConversation = (conversationId: string): string | undefined =>
    conversationDir(service.state(), conversationId)

  const sendToRenderer = (channel: string, payload: unknown): void => {
    if (!conversationView.webContents.isDestroyed()) conversationView.webContents.send(channel, payload)
  }

  // 每對話瀏覽器規格 §3:第一次用到才建,對話關閉時收掉。
  const browserSessions = createBrowserSessions({
    createView: (conversationId) => createAgentView(
      { currentProjectDir: () => projectDirOfConversation(conversationId), logError },
      agentPartitionFor(conversationId)
    ),
    addChildView: (view) => { win.contentView.addChildView(view) },
    removeChildView: (view) => { if (!win.isDestroyed()) win.contentView.removeChildView(view) },
    loadPage: loadAgentPage,
    startTools: ({ view, projectDir, credentials, onBusyChange }) => startViewTools({
      view, projectDir, credentials, onBusyChange,
      clock: SYSTEM_CLOCK,
      logError,
      warn: (line) => { console.error(line) },
      attach: attachCdp,
      create: createViewToolServer,
    }),
    projectDirOf: projectDirOfConversation,
    // 測試機規格 §5.4:每次呼叫才查這個對話目前所屬的專案。
    credentialsOf: async (conversationId, machine) => {
      const project = findProjectByTab(service.state(), conversationId)
      return project === undefined ? undefined : testMachines.credentialsFor(project.id, machine)
    },
    switcher,
    relayout: () => { placement.relayout() },
    onState: (state) => { sendToRenderer(IPC.browserState, state) },
    onSessions: (list) => { sendToRenderer(IPC.browserSessions, list) },
    // 規格 §4.6:導航完成才記,所以錯誤頁與 about:blank 不會蓋掉上次的頁面。
    onNavigated: createRememberUrl({ shouldRemember, update: service.update }),
    logError,
  })
  const browserCommands = createBrowserCommands({
    sessions: browserSessions,
    foregroundId: () => foregroundConversationId(service.state()),
    projectDirOf: projectDirOfConversation,
    loadPage: loadAgentPage,
    logError,
  })

  let group: ReturnType<typeof createGroupService> | undefined
  let currentWorkerLabel: (projectId: string) => string = () => '目前沒有工作者'
  const projectRunFiles = createProjectRunNodeAdapters(app.getPath('userData'))
  const projectRunConfigStore = createProjectRunConfigStore(join(app.getPath('userData'), 'project-run'))
  const projectRunRunner = createProjectRunRunner({
    ...projectRunFiles,
    shell: process.env['SHELL'] ?? '/bin/sh',
    openInBrowser: async (projectId, url) => { await openProjectRunBrowser(projectId, url) },
    postUnexpectedExit: async (projectId, exit) => {
      group?.write({
        projectId,
        threadId: GENERAL_THREAD_ID,
        from: { kind: 'system' },
        kind: 'text',
        text: `受管服務非預期結束（工作者：${currentWorkerLabel(projectId)}；結束：${exit.signal ?? exit.code ?? '未知'}），YesChef 正在自動重啟。`,
      })
    },
    logError,
  })

  function conversationForProjectRun(projectId: string): string | undefined {
    let project = findProject(service.state(), projectId)
    if (project === undefined) return undefined
    if (conversationTabs(project).length === 0) {
      service.update(state => openConversationTab(state, projectId, { tabId: service.newId(), threadId: service.newId() }, service.now()))
      project = findProject(service.state(), projectId)
    }
    if (project === undefined) return undefined
    const conversationId = activeConversationId(project)
    service.update(state => {
      const now = service.now()
      return setActive(focusTab(state, projectId, conversationId, now), projectId, now)
    })
    return conversationId
  }

  async function openProjectRunBrowser(projectId: string, url: string): Promise<void> {
    const conversationId = conversationForProjectRun(projectId)
    if (conversationId === undefined) throw new Error('找不到專案的對話分頁')
    await browserSessions.ensure(conversationId)
    browserSessions.show(conversationId)
    const result = await browserCommands.run({ kind: 'navigate', url })
    if (!result.ok) throw new Error(result.message)
  }

  async function refreshProjectRunBrowser(projectId: string): Promise<void> {
    const conversationId = conversationForProjectRun(projectId)
    if (conversationId === undefined) throw new Error('找不到專案的對話分頁')
    await browserSessions.ensure(conversationId)
    browserSessions.show(conversationId)
    const result = await browserCommands.run({ kind: 'reload' })
    if (!result.ok) throw new Error(result.message)
  }

  const projectRunHandler = createProjectRunIpcHandler({
    isTrustedSender: sender => sender === conversationView.webContents,
    projectRoot: projectId => service.rootPathOf(projectId),
    projectName: projectId => findProject(service.state(), projectId)?.name,
    configStore: projectRunConfigStore,
    runner: projectRunRunner,
    discover: discoverProjectRunCandidates,
    readLog: projectRunFiles.readLog,
    logPath: projectRunFiles.logPath,
    openInBrowser: async projectId => {
      const url = projectRunRunner.snapshot(projectId).url
      if (url === undefined) throw new Error('服務尚未就緒')
      await openProjectRunBrowser(projectId, url)
    },
    refreshBrowser: refreshProjectRunBrowser,
    openLog: path => shell.openPath(path),
    logError,
  })
  const unsubscribeProjectRun = projectRunRunner.subscribe((projectId, snapshot, logs) => {
    sendToRenderer(IPC.projectRunUpdate, { projectId, snapshot, logs: logs.slice(-2000) })
  })

  // 每個對話一份 MCP server;瀏覽器本身等第一次工具呼叫才建(規格 §4.3)。
  // grok 那條路再多一層 localhost HTTP,第一次要 mcpServers 時才 listen(grok 規格 §6)。
  const runtimeFor = (projectId: string, cwd: string, conversationId: string, provider: Provider): ProjectRuntime => {
    const managed = chef?.worker(conversationId)
    const projectRoot = service.rootPathOf(projectId)
    const errorIntakeContext = managed?.purpose === ERROR_INTAKE_SETUP_PURPOSE && projectRoot !== undefined
      ? { service: errorIntake, projectId, projectRoot }
      : undefined
    let approveGrokChefTool: ((toolName: string, input: unknown) => Promise<boolean>) | undefined
    // grok 的 worker 只有 HTTP MCP server 這一條路拿得到主廚的控制工具;
    // Claude 走 sessionOptions.mcpServers.chef,codex 走 dynamicTools,兩者都不從這裡拿。
    const workerTools = provider === 'grok' && managed !== undefined && chef !== undefined
      ? createChefTools(chef, conversationId, {
        ...(errorIntakeContext === undefined ? {} : { errorIntake: errorIntakeContext }),
        approve: async (toolName, input) => approveGrokChefTool?.(toolName, input) ?? false,
      })
      : undefined
    const viewServerDeps = {
      resolve: async () => (await browserSessions.ensure(conversationId)).tools,
      logError,
      ...(managed ? {} : { peer: peer.forConversation(conversationId) }),
      ...(workerTools === undefined ? {} : { chefTools: workerTools }),
    }
    const own = createConversationViewServer(viewServerDeps)
    const sessionOptions = createSessionOptionsFactory(
      cwd,
      appDir,
      liveCwd,
      { [VIEW_TOOL_SERVER_NAME]: own.server },
      { window: autoCompactWindow(), baseEnv: process.env },
      () => sharedSkills?.runtime().plugins ?? []
    )
    const tools = (): ViewTools | undefined => browserSessions.get(conversationId)?.tools
    const grokViewTools = createGrokViewTools({
      // grok 的每個 MCP session 各自一份 view server(規格 §6.1),不共用 `own`。
      view: viewServerDeps,
      logError,
      handoffDone: (toolUseId) => { tools()?.handoffDone(toolUseId) },
    })
    approveGrokChefTool = async (toolName, input) => (await grokViewTools.requestApproval(toolName, input)) === 'allow'
    return {
      sessionOptions,
      codexSkillRoots: () => sharedSkills?.runtime().roots ?? [],
      grokPluginDir: () => sharedSkills?.runtime().grokPluginDir,
      viewTools: {
        autoAllow: (toolName) => viewToolPolicy(toolName) === 'allow',
        handoffDone: (toolUseId) => { tools()?.handoffDone(toolUseId) },
        abortPending: (reason) => { tools()?.abortPending(reason) },
      },
      codexViewTools: {
        invoke: (name, args, ctx) => own.invoke(name, args, ctx),
        handoffDone: (toolUseId) => { tools()?.handoffDone(toolUseId) },
      },
      grokViewTools,
      dispose: () => {
        own.dispose()
        // 對話核心收尾時已經關過一次,這裡是「從沒開過對話就關分頁」的那條路。
        void grokViewTools.close()
      },
    }
  }

  let term: Awaited<ReturnType<typeof startTerminalServer>> | undefined
  try {
    // 規格 §3.1:終端機 cwd 由 projectId 查登錄表,renderer 不送路徑。
    term = await startTerminalServer((id) => service.rootPathOf(id), logError)
  } catch (cause) {
    logError(toError(cause))
  }

  const sleepGuard = createSleepGuard({
    start: () => powerSaveBlocker.start('prevent-app-suspension'),
    stop: (id) => { powerSaveBlocker.stop(id) },
    isStarted: (id) => powerSaveBlocker.isStarted(id),
    log: (line) => { console.error(line) },
  })
  const remoteClients = createRemoteClientsWatcher({
    run: async (args) => (await promisify(execFile)('tmux', [...args], { timeout: 10000 })).stdout,
    ownPids: () => term?.ownClientPids() ?? new Set<number>(),
    onChange: (on) => sleepGuard.setSignal('remote', on),
    logError,
  })
  if (!win.isDestroyed()) remoteClients.start()
  const reviewDir = join(app.getPath('userData'), 'permission-reviewer')
  const permissions = await mkdir(reviewDir, { recursive: true, mode: 0o700 }).then(() => createPermissionService(
    join(app.getPath('userData'), 'permissions'), createPermissionReviewer(query, reviewDir),
    id => service.rootPathOf(id) !== undefined, logError,
    async options => dialog.showSaveDialog(win, options), projectId => projectRunRunner.managedServices(projectId),
  )).catch(error => { logError(toError(error)); return undefined })
  // 測試機規格 §3:密碼經 safeStorage 加密後存在 userData,每個專案一檔。
  const testMachines = createTestMachinesService({
    dir: join(app.getPath('userData'), 'test-machines'),
    safeStorage,
    logError,
  })
  const errorIntake = createErrorIntakeService({
    dir: app.getPath('userData'),
    safeStorage,
    logError,
  })
  errorIntake.startCleanupScheduler()
  // 專案被移除就刪它的帳密檔,不留孤兒。
  const unsubscribeTestMachines = service.subscribe((next, prev) => {
    for (const id of removedProjectIds(prev, next)) {
      testMachines.removeProject(id).catch((err: unknown) => { logError(toError(err)) })
      projectRunConfigStore.removeProject(id).catch((err: unknown) => { logError(toError(err)) })
      projectRunRunner.stop(id).catch((err: unknown) => { logError(toError(err)) })
    }
  })
  const attachments = createAttachments(join(app.getPath('userData'), 'attachments'), async () => {
    const result = await dialog.showOpenDialog({ title: '附加文件或照片', properties: ['openFile', 'multiSelections'], filters: [{ name: '文件與照片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'txt', 'md', 'csv', 'json', 'yaml', 'yml', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'rtf', 'xml', 'html', 'css', 'ts', 'tsx', 'js', 'py', 'log'] }] })
    return result.canceled ? [] : result.filePaths
  })
  const activityLedger = createActivityLedger(join(app.getPath('userData'), 'conversation-activity'), logError)
  const developmentDiff = createDevelopmentDiff(join(app.getPath('userData'), 'development-baselines'))
  const readClaudeActivity = createClaudeActivityReader({ getSessionMessages, listSubagents, getSubagentMessages })
  let bridge: IpcBridge
  const chefDir = join(app.getPath('userData'), 'chef')
  // 群組頻道(群組規格 §3.2):訊息放 userData,跟同伴信箱同樣的理由,專案目錄可能被 git clean 清掉。
  const groupStore = createGroupStore(join(app.getPath('userData'), 'yeschef-group'), logError)
  // Chef 的 grok 模型與歷史清單共用同一份 catalog(grok 規格 §8.2),所以先建好再傳進去。
  const grokCatalog = createGrokCatalog({ logError })
  const chef = await createChefService({
    dir: chefDir,
    catalog: createChefModelCatalog(query, chefDir, nodeSpawnCodex, grokCatalog, logError),
    rootOf: id => service.rootPathOf(id),
    busyIn: cwd => bridge?.hasBusyWork(cwd) ?? false,
    startWorker: request => bridge.startChefWorker(request),
    readUiCheckFiles: (key, cwd) => developmentDiff.changedFiles(key, cwd),
    deadlineReviewer: createDeadlineReviewer(query, reviewDir),
    group: {
      write: input => { group?.write(input) },
      recent: (projectId, threadId, limit) => group?.recent(projectId, threadId, limit) ?? Promise.resolve([]),
    },
    onTaskEnded: task => errorIntake.completeErrorFix(task),
    logError,
  }).catch(error => { logError(toError(error)); return undefined })
  currentWorkerLabel = projectId => {
    const task = [...(chef?.tasksOf(projectId) ?? [])].reverse().find(candidate => ['running', 'stopping'].includes(candidate.status))
    const attempt = task?.attempts.filter(candidate => ['running', 'stopping'].includes(candidate.status)).at(-1)
    return task === undefined || attempt === undefined ? '目前沒有工作者' : labelFor(task, attempt)
  }
  const runningChefWorkersByTask = new Map(service.state().projects.flatMap(project =>
    (chef?.tasksOf(project.id) ?? []).map(task => [
      task.id,
      new Set(task.attempts.filter(attempt => ['running', 'stopping'].includes(attempt.status)).map(attempt => attempt.workerId)),
    ] as const)
  ))
  service.update(state => closeInactiveChefTabs(state, runningChefWorkersByTask, Date.now()))
  bridge = createIpcBridge({
    chef,
    errorIntake,
    attachments, developmentDiff, activityLedger,
    loadClaudeActivity: async sessionId => {
      const activity = await readClaudeActivity(sessionId)
      const link = service.state().projects.flatMap(p => p.threads.flatMap(t => t.sessions)).find(s => s.provider === 'claude' && s.sessionId === sessionId)
      if (!link?.transcriptPath) return activity
      try {
        const recovered = await recoverExternalCodexWrites({ parentSessionId: sessionId, transcriptPath: link.transcriptPath, codexHome: process.env['CODEX_HOME'] ?? join(homedir(), '.codex') })
        return { ...activity, externalWrites: recovered.writes, warnings: [...activity.warnings, ...recovered.warnings] }
      } catch { return { ...activity, warnings: [...activity.warnings, '外部委派的原始紀錄無法讀取，清單可能不完整。'] } }
    },
    permissions,
    onAnyBusyChange: (busy) => { sleepGuard.setSignal('conversations', busy) },
    webContents: conversationView.webContents,
    projects: service,
    sessions,
    codexCatalog: createCodexCatalog({ spawn: nodeSpawnCodex, logError }),
    grokCatalog,
    runtimeFor,
    browser: { show: (id) => { browserSessions.show(id) }, dispose: (id) => browserSessions.dispose(id) },
    peer,
    logError,
    homeDir: homedir(),
    terminalPort: term?.port,
    terminalToken: term?.token,
  })
  const groupChef: GroupChef = {
    tasksOf: projectId => chef?.tasksOf(projectId) ?? [],
    start: (projectId, goal) => startChefTask(chef, projectId, goal),
    resume: async (taskId, message) => {
      if (chef === undefined) return { kind: 'error', message: GROUP_MSG.noChef }
      const response = await chef.handle({ action: 'resume', taskId, reconciled: false, message })
      return response.kind === 'state'
        ? { kind: 'ok' }
        : { kind: 'error', message: response.message }
    },
  }
  group = createGroupService({
    store: groupStore,
    chef: groupChef,
    deliver: (projectId, conversationId, text) => bridge.deliverToManaged(projectId, conversationId, text),
    openParticipant: input => bridge.openHistoryConversation(input),
    hasProject: projectId => service.rootPathOf(projectId) !== undefined,
    onChange: payload => { sendToRenderer(IPC.groupMessages, payload) },
    newId: randomUUID,
    now: Date.now,
    logError,
  })
  const errorIntakeActivation = createErrorIntakeActivation({
    service: errorIntake,
    ...(chef === undefined ? {} : { chef }),
    rootPathOf: (projectId) => service.rootPathOf(projectId),
    writeClipboard: (text) => clipboard.writeText(text),
    logError,
  })

  // 合併與關分頁共用同一份進行中旗標:合併跑到一半不能把 worktree 抽走。
  const mergeLocks = createMergeLocks()
  const unregisterProjectsIpc = registerProjectsIpc({
    service,
    disposeConversation: bridge.disposeConversation,
    locks: mergeLocks,
    worktree,
    pickFolder: async () => {
      const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      const picked = result.filePaths[0]
      return result.canceled || picked === undefined ? undefined : canonicalRoot(picked)
    },
    validateRoot,
    logError,
    onTerminalTabClosed: killTmuxSession,
  })

  const translateCwd = join(app.getPath('userData'), 'translate-cwd')
  await mkdir(translateCwd, { recursive: true })
  // 共用同一個限流器；翻譯不建立對話、不讀寫專案狀態。
  const translateLimited = createTranslator({
    logError,
    nonce: () => randomUUID(),
    // 給一個空的專屬目錄,不用 userData 本身:那裡放著 Cookies 與專案狀態檔。
    // 今天工具是關的所以碰不到,但「agent 的工作目錄」不該預設就是 app 自己的狀態區。
    query: createTranslateQuery(query, translateCwd),
  })
  ipcMain.handle(IPC.translateRun, createTranslateHandler({
    isAllowedSender: (sender: Electron.WebContents) => sender === conversationView.webContents,
    translate: translateLimited,
  }))
  win.once('closed', () => { ipcMain.removeHandler(IPC.translateRun) })

  ipcMain.handle(CHEF_CHANNEL, async (event, raw: unknown) => {
    if (event.sender !== conversationView.webContents) return { kind: 'error', message: '不接受此來源的主廚請求' }
    return chef?.handle(raw) ?? { kind: 'error', message: '主廚服務無法啟動，請檢查主程序紀錄' }
  })
  ipcMain.handle(PERMISSIONS_CHANNEL, async (event, raw: unknown) => {
    if (event.sender !== conversationView.webContents) return { kind: 'error', message: '不接受此來源的授權請求' }
    return permissions?.handle(raw) ?? { kind: 'error', message: '授權服務無法啟動，目前維持人工批准' }
  })
  ipcMain.handle(TEST_MACHINES_CHANNEL, createTestMachinesIpcHandler({
    isTrustedSender: (sender) => sender === conversationView.webContents,
    handle: (raw) => testMachines.handle(raw),
  }))
  ipcMain.handle(IPC.projectRun, projectRunHandler)
  ipcMain.handle(ERROR_INTAKE_CHANNEL, createErrorIntakeIpcHandler({
    isTrustedSender: (sender) => sender === conversationView.webContents,
    handle: (raw) => {
      const parsed = ErrorIntakeRequestSchema.safeParse(raw)
      if (!parsed.success) return Promise.resolve({ kind: 'error', message: '錯誤收集請求格式不正確' })
      if (parsed.data.action === 'project' || parsed.data.action === 'enable' || parsed.data.action === 'copy-connection'
        || parsed.data.action === 'pull-list' || parsed.data.action === 'set-group-status' || parsed.data.action === 'start-fix') {
        return errorIntakeActivation.handle(parsed.data)
      }
      return errorIntake.handle(parsed.data)
    },
  }))
  ipcMain.handle(GROUP_CHANNEL, createGroupIpcHandler({
    isTrustedSender: (sender) => sender === conversationView.webContents,
    handle: (raw) => group?.handle(raw) ?? Promise.resolve({ kind: 'error' as const, message: GROUP_MSG.noChef }),
  }))
  ipcMain.handle(SKILLS_CHANNEL, createSkillsHandler(sharedSkills ?? {
    handle: async () => ({ kind: 'error', message: skillsError }),
  }, sender => sender === conversationView.webContents))
  // 合併走同一支 git run,與 worktree 建立、移除共用輸出上限與錯誤分類。
  const mergeService = createMerge({ run: worktree.run, logError })
  ipcMain.handle(WORKTREE_MERGE_CHANNEL, createWorktreeMergeHandler({
    merge: mergeService,
    locate: (projectId, tabId) => {
      const project = findProject(service.state(), projectId)
      const tab = project?.tabs.find((entry) => entry.id === tabId && entry.contentType === 'conversation')
      if (project === undefined || tab?.worktreePath === undefined) return undefined
      return { rootPath: project.rootPath, worktreePath: tab.worktreePath, label: tab.customLabel ?? tab.label }
    },
    conversation: (projectId, tabId) => bridge.conversationFor(projectId, tabId),
    locks: mergeLocks,
    isTrustedSender: (sender) => sender === conversationView.webContents,
    logError,
  }))
  win.once('closed', () => {
    errorIntake.stopCleanupScheduler()
    ipcMain.removeHandler(ERROR_INTAKE_CHANNEL)
    ipcMain.removeHandler(CHEF_CHANNEL)
    ipcMain.removeHandler(PERMISSIONS_CHANNEL)
    ipcMain.removeHandler(TEST_MACHINES_CHANNEL)
    ipcMain.removeHandler(IPC.projectRun)
    ipcMain.removeHandler(GROUP_CHANNEL)
    ipcMain.removeHandler(SKILLS_CHANNEL)
    ipcMain.removeHandler(WORKTREE_MERGE_CHANNEL)
    unsubscribeTestMachines()
    unsubscribeProjectRun()
    void sharedSkills?.dispose().catch(error => logError(toError(error)))
  })

  const readPreviewLimited = createPreviewReader({
    rootPathOf: (id) => service.rootPathOf(id),
    realpath: (p) => realpath(p),
    stat: async (p) => {
      const info = await stat(p)
      return { size: info.size, isFile: info.isFile() }
    },
    readFile: (p) => readFile(p),
  })
  const onPreviewRead = async (event: Electron.IpcMainInvokeEvent, raw: unknown): Promise<PreviewReadResult> => {
    // 這是讀本機檔案的頻道,只收左邊 renderer 的。右窗格沒有 preload 碰不到 IPC,
    // 但讀檔比擺位置敏感,跟 layout:browser-bounds 一樣多一道檢查。
    if (event.sender !== conversationView.webContents) return { kind: 'rejected', message: '不接受這個來源的請求' }
    const payload = parsePreviewRead(raw)
    if (payload === null) {
      logError(new Error(`${IPC.previewRead} 收到格式不對的 payload`))
      return { kind: 'rejected', message: 'payload 形狀不符' }
    }
    try {
      return await readPreviewLimited(payload)
    } catch (err) {
      const error = toError(err)
      logError(error)
      return { kind: 'rejected', message: error.message }
    }
  }
  ipcMain.handle(IPC.previewRead, onPreviewRead)
  // 就近收尾,理由同 layout:browser-bounds。
  win.once('closed', () => { ipcMain.removeHandler(IPC.previewRead) })

  const browserIpc = createBrowserIpcHandlers({
    isTrustedSender: (sender) => sender === conversationView.webContents,
    commands: browserCommands,
    snapshot: () => browserSessions.snapshot(),
    logError,
  })
  ipcMain.handle(IPC.browserCommand, browserIpc.onCommand)
  ipcMain.handle(IPC.browserGet, browserIpc.onGet)
  win.once('closed', () => {
    ipcMain.removeHandler(IPC.browserCommand)
    ipcMain.removeHandler(IPC.browserGet)
  })

  // 視窗關閉是狀態機的 `window-closed`:bridge.dispose() 會跑完每個專案的收尾再解掉 handler。
  win.on('closed', () => {
    remoteClients.stop()
    unregisterProjectsIpc()
    // peer.dispose() 要等 bridge 收完:bridge 收每個對話時會呼叫 conversationEnded 去
    // 寫未決問答的 cancel,先 dispose 掉 peer 的話那些呼叫會變成沒有作用。
    // bridge.dispose() 與 browserSessions.disposeAll() 各自 catch 自己的失敗:規格 §8
    // 瀏覽器 session 的收尾不該因為 bridge 那段失敗就整個被跳過(CDP session 與
    // webContents 會一直留著),兩段都失敗也不擋後面 peer/permissions/activityLedger。
    Promise.resolve(chef?.dispose()).catch(error => logError(toError(error)))
      .then(() => bridge.dispose().catch(error => logError(toError(error))))
      .then(() => browserSessions.disposeAll().catch(error => logError(toError(error))))
      .then(async () => { peer.dispose(); await group?.dispose(); await permissions?.dispose(); await activityLedger.dispose() })
      .catch((err: unknown) => {
        console.error('[yeschef] 收尾失敗:', err)
        peer.dispose()
      })
      // 對話收尾完成才放行睡眠,失敗時也要釋放 blocker。
      .finally(() => { sleepGuard.dispose() })
    term?.close().catch((err: unknown) => {
      console.error('[yeschef] 終端機伺服器收尾失敗:', err)
    })
  })

  // 規格 §4.1:退出時記下開著哪些專案,並等這一筆真的寫進磁碟。service 的存檔是背景排隊的,
  // store.save 排在同一條隊伍後面,等到它就等到了前面所有的。
  // 旗標在 handler 的第一行就同步立起來,不等存檔回來:只有第一次退出請求會被攔下來等存檔,
  // 之後的請求(使用者再按一次 Cmd-Q,或存完之後我們自己叫的 app.quit())一律放行,
  // 存檔卡住也還是退得掉。store 是原子寫,被退出打斷時狀態檔還是完整的舊版或新版。
  let quitting = false
  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    const state = service.state()
    Promise.resolve(chef?.dispose()).catch(error => logError(toError(error)))
      .then(() => projectRunRunner.stopAll())
      .then(() => store.save(setShutdown(state, state.projects.map((p) => p.id))))
      .catch((err: unknown) => {
        logError(toError(err))
      })
      .finally(() => {
        app.quit()
      })
  })

  loadRenderer(conversationView)
  return win
}

app
  .whenReady()
  .then(() => {
    if (migrationFailures.length > 0) throw new Error('舊資料搬移失敗，YesChef 未啟動')
    return createWindow()
  })
  .catch((err: unknown) => {
    console.error('[yeschef] 應用初始化失敗:', err)
    process.exit(1)
  })

app.on('window-all-closed', () => {
  app.quit()
})

// grok 的子行程不是 Electron 的子視窗,app 收尾時不會自己走(grok 規格 §5.2)。
app.on('quit', () => { killAllGrokProcesses() })

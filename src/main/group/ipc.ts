import type { GroupResponse } from '../../shared/group.js'

export interface GroupIpcHandlerDeps {
  isTrustedSender(sender: unknown): boolean
  handle(raw: unknown): Promise<GroupResponse>
}

/**
 * group:manage 頻道的 ipcMain.handle 處理器,抽法同 `test-machines/ipc.ts`。
 * 來源不對直接回 error,不呼叫 handle;handle 丟例外也收成 error 回應。
 */
export function createGroupIpcHandler(
  deps: GroupIpcHandlerDeps
): (event: { sender: unknown }, raw: unknown) => Promise<GroupResponse> {
  return async (event, raw) => {
    if (!deps.isTrustedSender(event.sender)) return { kind: 'error', message: '不接受此來源的群組請求' }
    try {
      return await deps.handle(raw)
    } catch (error) {
      return { kind: 'error', message: error instanceof Error ? error.message : '群組操作失敗' }
    }
  }
}

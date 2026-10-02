import type { TestMachinesResponse } from '../../shared/test-machines.js'

export interface TestMachinesIpcHandlerDeps {
  isTrustedSender(sender: unknown): boolean
  handle(raw: unknown): Promise<TestMachinesResponse>
}

/**
 * testMachines:manage 頻道的 ipcMain.handle 處理器(I5,同 browser-ipc-handlers.ts 的抽法)。
 * 來源不對直接回 error,不呼叫 handle——跟抽出前 index.ts 裡的行為一致。
 */
export function createTestMachinesIpcHandler(
  deps: TestMachinesIpcHandlerDeps
): (event: { sender: unknown }, raw: unknown) => Promise<TestMachinesResponse> {
  return async (event, raw) => {
    if (!deps.isTrustedSender(event.sender)) return { kind: 'error', message: '不接受此來源的測試機請求' }
    return deps.handle(raw)
  }
}

import type { ErrorIntakeResponse } from '../../shared/error-intake.js'

export interface ErrorIntakeIpcDeps {
  readonly isTrustedSender: (sender: unknown) => boolean
  readonly handle: (raw: unknown) => Promise<ErrorIntakeResponse>
}

export function createErrorIntakeIpcHandler(deps: ErrorIntakeIpcDeps) {
  return async (event: { readonly sender: unknown }, raw: unknown): Promise<ErrorIntakeResponse> => {
    if (!deps.isTrustedSender(event.sender)) return { kind: 'error', message: '不接受此來源的錯誤收集資料庫請求' }
    return deps.handle(raw)
  }
}

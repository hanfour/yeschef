import { describe, expect, it, vi } from 'vitest'
import { createErrorIntakeIpcHandler } from '../src/main/error-intake/ipc.js'
import type { ErrorIntakeResponse } from '../src/shared/error-intake.js'

describe('錯誤收集資料庫 IPC', () => {
  it('僅信任主 renderer，且回應不會帶出密碼或密文', async () => {
    const secret = 'admin-password'
    const response: ErrorIntakeResponse = {
      kind: 'settings',
      settings: { host: 'db', port: 3306, database: 'errors', tls: true, adminUsername: 'root', hasAdminPassword: true, hasAppPassword: true, schemaVersion: 1, packageSource: '@yeschef/error-intake' },
    }
    const handle = vi.fn(async () => response)
    const ipc = createErrorIntakeIpcHandler({ isTrustedSender: (sender) => sender === 'renderer', handle })
    await expect(ipc({ sender: 'untrusted' }, {})).resolves.toMatchObject({ kind: 'error' })
    expect(handle).not.toHaveBeenCalled()
    const reply = await ipc({ sender: 'renderer' }, { action: 'get' })
    expect(JSON.stringify(reply)).not.toContain(secret)
    expect(JSON.stringify(reply)).not.toContain('Ciphertext')
    expect(reply).toEqual(response)
  })
})

import { describe, expect, it } from 'vitest'
import {
  ERROR_INTAKE_CHANNEL,
  ErrorIntakeRequestSchema,
  ErrorIntakeResponseSchema,
} from '../src/shared/error-intake.js'

describe('錯誤收集資料庫 IPC schema', () => {
  it('頻道名與動作固定，資料庫請求拒絕額外欄位', () => {
    expect(ERROR_INTAKE_CHANNEL).toBe('errorIntake:manage')
    expect(ErrorIntakeRequestSchema.safeParse({ action: 'get' }).success).toBe(true)
    expect(ErrorIntakeRequestSchema.safeParse({ action: 'status' }).success).toBe(true)
    expect(ErrorIntakeRequestSchema.safeParse({ action: 'get', password: 'secret' }).success).toBe(false)
    expect(ErrorIntakeRequestSchema.safeParse({ action: 'save', settings: { host: 'db', port: 3306, database: 'errors', tls: true, adminUsername: 'root', adminPassword: 'pw' } }).success).toBe(true)
    expect(ErrorIntakeRequestSchema.safeParse({ action: 'save', settings: { host: 'root@db', port: 3306, database: 'errors', tls: true, adminUsername: 'root' } }).success).toBe(false)
    expect(ErrorIntakeRequestSchema.safeParse({ action: 'initialize', extra: true }).success).toBe(false)
    expect(ErrorIntakeRequestSchema.safeParse({ action: 'project', projectId: 'p1' }).success).toBe(true)
    expect(ErrorIntakeRequestSchema.safeParse({ action: 'enable', projectId: 'p1', projectCode: 'demo-app', acknowledged: true, packageSource: '@yeschef/error-intake' }).success).toBe(true)
    expect(ErrorIntakeRequestSchema.safeParse({ action: 'copy-connection', projectId: 'p1' }).success).toBe(true)
  })

  it('renderer response schema 不接受密碼或密文欄位', () => {
    const response = { kind: 'settings', settings: { host: 'db', port: 3306, database: 'errors', tls: true, adminUsername: 'root', hasAdminPassword: true, hasAppPassword: false, schemaVersion: null } }
    expect(ErrorIntakeResponseSchema.safeParse(response).success).toBe(true)
    expect(ErrorIntakeResponseSchema.safeParse({ ...response, password: 'pw' }).success).toBe(false)
    expect(ErrorIntakeResponseSchema.safeParse({ ...response, settings: { ...response.settings, adminPasswordCiphertext: 'cipher' } }).success).toBe(false)
    expect(ErrorIntakeResponseSchema.safeParse({ kind: 'copied', projectId: 'p1', connectionUrl: 'mysql://secret' }).success).toBe(false)
    expect(ErrorIntakeResponseSchema.safeParse({
      kind: 'project', projectId: 'p1', folderName: 'api', defaultProjectCode: 'api', enabled: false,
      projectCode: null, projectCodeLocked: false, databaseReady: false,
    }).success).toBe(true)
  })
})

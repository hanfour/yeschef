import { describe, expect, it } from 'vitest'
import {
  MachineInputSchema, MachineViewSchema, TEST_MACHINES_CHANNEL, TestMachinesRequestSchema, TestMachinesResponseSchema,
} from '../src/shared/test-machines.js'

const VIEW = { id: 'm1', name: 'staging', url: 'https://staging.test/login', username: 'qa', hasPassword: true, passwordNeedsReentry: false }

describe('測試機的 schema', () => {
  it('頻道名固定', () => {
    expect(TEST_MACHINES_CHANNEL).toBe('testMachines:manage')
  })

  it('回應的 machine 不能帶 password 欄位', () => {
    expect(MachineViewSchema.safeParse(VIEW).success).toBe(true)
    expect(MachineViewSchema.safeParse({ ...VIEW, password: 'x' }).success).toBe(false)
  })

  it('輸入的 url 只收 http 與 https', () => {
    expect(MachineInputSchema.safeParse({ name: 'a', url: 'https://a.test/', username: 'u' }).success).toBe(true)
    expect(MachineInputSchema.safeParse({ name: 'a', url: 'http://localhost:3000', username: 'u' }).success).toBe(true)
    expect(MachineInputSchema.safeParse({ name: 'a', url: 'file:///etc/passwd', username: 'u' }).success).toBe(false)
    expect(MachineInputSchema.safeParse({ name: 'a', url: 'not a url', username: 'u' }).success).toBe(false)
  })

  it('name 去頭尾空白後不可為空,最長 100 字', () => {
    expect(MachineInputSchema.safeParse({ name: '   ', url: 'https://a.test/', username: 'u' }).success).toBe(false)
    expect(MachineInputSchema.safeParse({ name: 'a'.repeat(101), url: 'https://a.test/', username: 'u' }).success).toBe(false)
    expect(MachineInputSchema.parse({ name: '  staging ', url: 'https://a.test/', username: 'u' }).name).toBe('staging')
  })

  it('回應的 machine 允許空 username:存檔裡已有的舊資料不能讓整個清單驗不過', () => {
    expect(MachineViewSchema.safeParse({ ...VIEW, username: '' }).success).toBe(true)
  })

  it('輸入的 username 不可以是空字串(M2)', () => {
    expect(MachineInputSchema.safeParse({ name: 'a', url: 'https://a.test/', username: '' }).success).toBe(false)
    expect(MachineInputSchema.safeParse({ name: 'a', url: 'https://a.test/', username: 'u' }).success).toBe(true)
  })

  it('password 不可以是空字串:要嘛不帶要嘛有內容', () => {
    expect(MachineInputSchema.safeParse({ name: 'a', url: 'https://a.test/', username: 'u', password: '' }).success).toBe(false)
    expect(MachineInputSchema.safeParse({ name: 'a', url: 'https://a.test/', username: 'u' }).success).toBe(true)
    expect(MachineInputSchema.safeParse({ name: 'a', url: 'https://a.test/', username: 'u', password: 'x' }).success).toBe(true)
  })

  it('三種請求與兩種回應', () => {
    expect(TestMachinesRequestSchema.safeParse({ action: 'list', projectId: 'p' }).success).toBe(true)
    expect(TestMachinesRequestSchema.safeParse({ action: 'upsert', projectId: 'p', revision: 0, machine: { name: 'a', url: 'https://a.test/', username: 'u', password: 'pw' } }).success).toBe(true)
    expect(TestMachinesRequestSchema.safeParse({ action: 'remove', projectId: 'p', revision: 1, id: 'm1' }).success).toBe(true)
    expect(TestMachinesRequestSchema.safeParse({ action: 'list', projectId: 'p', extra: 1 }).success).toBe(false)
    expect(TestMachinesResponseSchema.safeParse({ kind: 'state', revision: 2, machines: [VIEW] }).success).toBe(true)
    expect(TestMachinesResponseSchema.safeParse({ kind: 'error', message: '壞了' }).success).toBe(true)
  })
})

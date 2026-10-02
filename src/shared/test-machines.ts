import { z } from 'zod'

export const TEST_MACHINES_CHANNEL = 'testMachines:manage'

/** 只收 http 與 https:file:// 的測試機不成立,其他協定也沒有登入頁可填。 */
function isHttpUrl(raw: string): boolean {
  try {
    const protocol = new URL(raw).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

export const nameSchema = z.string().trim().min(1).max(100)
export const urlSchema = z.string().max(2000).refine(isHttpUrl, { message: '網址必須是 http 或 https' })
/** 帳號跟密碼一樣不可為空:要嘛不設這台機器的登入,要嘛帳密都要有內容(M2)。 */
export const usernameSchema = z.string().min(1).max(200)

/**
 * renderer 看到的一筆。沒有 password 欄位,strict 讓多出來的也進不來。
 * username 這裡不設最小長度:回應 schema 描述的是「存檔裡有什麼」,存檔裡若有舊的或手改的空帳號,
 * 讓整個清單驗不過只會害使用者連刪都刪不掉;不可為空是輸入端(MachineInputSchema)的規則。
 */
export const MachineViewSchema = z.object({
  id: z.string().min(1),
  name: nameSchema,
  url: urlSchema,
  username: z.string().max(200),
  hasPassword: z.boolean(),
  passwordNeedsReentry: z.boolean(),
}).strict()

/** 表單送來的一筆。password 是 undefined 表示保留原本的。 */
export const MachineInputSchema = z.object({
  id: z.string().min(1).optional(),
  name: nameSchema,
  url: urlSchema,
  username: usernameSchema,
  password: z.string().min(1).max(1000).optional(),
}).strict()

export const TestMachinesRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), projectId: z.string().min(1) }).strict(),
  z.object({ action: z.literal('upsert'), projectId: z.string().min(1), revision: z.number().int().nonnegative(), machine: MachineInputSchema }).strict(),
  z.object({ action: z.literal('remove'), projectId: z.string().min(1), revision: z.number().int().nonnegative(), id: z.string().min(1) }).strict(),
])

export const TestMachinesResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('state'), revision: z.number().int().nonnegative(), machines: z.array(MachineViewSchema) }).strict(),
  z.object({ kind: z.literal('error'), message: z.string() }).strict(),
])

export type MachineView = z.infer<typeof MachineViewSchema>
export type MachineInput = z.infer<typeof MachineInputSchema>
export type TestMachinesRequest = z.infer<typeof TestMachinesRequestSchema>
export type TestMachinesResponse = z.infer<typeof TestMachinesResponseSchema>

import { describe, expect, it, vi } from 'vitest'
import type { ChefService } from '../src/main/chef/service.js'
import { createChefTools, ERROR_INTAKE_TOOL_NAMES } from '../src/main/chef/tools.js'
import { chefToolPolicy } from '../src/main/chef/tool-policy.js'
import type { ErrorIntakeToolContext } from '../src/main/error-intake/tools.js'

function toolsFor(purpose: string | undefined) {
  const chef = {
    runnable: () => true,
    worker: () => ({ role: 'chef', ...(purpose === undefined ? {} : { purpose }) }),
  } as unknown as ChefService
  const checkProjectErrors = vi.fn(async () => [{ source: 'browser' as const, error_type: 'TypeError' as const, route: '/checkout' as const, environment: 'staging' as const }])
  const context: ErrorIntakeToolContext = {
    service: {
      isReady: async () => true,
      enabledProjectCode: async () => 'demo-app',
      writerConnectionUrl: async () => 'mysql://ei_demo-app:private@db.test/errors',
      checkProjectErrors,
    },
    projectId: 'p1', projectRoot: '/tmp/project',
  }
  const approve = vi.fn(async () => false)
  const tools = createChefTools(chef, 'worker-1', { errorIntake: context, approve })
  return { tools, approve, checkProjectErrors }
}

describe('只在錯誤收集設定任務提供的主廚工具', () => {
  it('一般主廚任務沒有兩個錯誤收集工具', () => {
    const { tools } = toolsFor(undefined)
    expect(tools.names).not.toContain(ERROR_INTAKE_TOOL_NAMES[0])
    expect(tools.names).not.toContain(ERROR_INTAKE_TOOL_NAMES[1])
  })

  it('error-intake-setup 任務取得工具，configure 每次先等待批准', async () => {
    const { tools, approve } = toolsFor('error-intake-setup')
    expect(tools.names).toEqual(expect.arrayContaining([...ERROR_INTAKE_TOOL_NAMES]))
    await expect(tools.call('configure_error_intake_env', { envFile: '.env.local' }, 'call-1')).resolves.toEqual({
      ok: false, text: '使用者未批准這次環境變數寫入',
    })
    expect(approve).toHaveBeenCalledExactlyOnceWith('configure_error_intake_env', { envFile: '.env.local' }, 'call-1')
  })

  it('check_error_intake 不詢問批准並回傳每群環境資訊', async () => {
    const { tools, approve, checkProjectErrors } = toolsFor('error-intake-setup')
    await expect(tools.call('check_error_intake', { sinceMinutes: 30 })).resolves.toMatchObject({
      ok: true, text: expect.stringContaining('"source":"browser","error_type":"TypeError","route":"/checkout","environment":"staging"'),
    })
    expect(approve).not.toHaveBeenCalled()
    expect(checkProjectErrors).toHaveBeenCalledExactlyOnceWith('p1', 'demo-app', 30)
  })

  it('批准政策只放行 check，configure 對 Claude、Codex 與 Grok 都必須 ask', () => {
    expect(chefToolPolicy('check_error_intake')).toBe('allow')
    expect(chefToolPolicy('mcp__chef__check_error_intake')).toBe('allow')
    expect(chefToolPolicy('configure_error_intake_env')).toBe('ask')
    expect(chefToolPolicy('mcp__chef__configure_error_intake_env')).toBe('ask')
  })
})

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { VIEW_TOOL_DEFS, viewToolDef } from '../../src/main/view-tools/tool-defs.js'
import { VIEW_TOOL_NAMES } from '../../src/shared/view-tools.js'

/** 九個工具各自的 JSON Schema 應有的欄位與必填,與契約 §2 的 zod shape 並排。 */
const EXPECTED: Readonly<Record<string, { properties: readonly string[]; required: readonly string[] }>> = {
  view_navigate: { properties: ['url'], required: ['url'] },
  view_snapshot: { properties: ['scope'], required: [] },
  view_screenshot: { properties: [], required: [] },
  view_click: { properties: ['ref'], required: ['ref'] },
  view_type: { properties: ['ref', 'text', 'clear', 'submit'], required: ['ref', 'text'] },
  view_press: { properties: ['key'], required: ['key'] },
  view_eval: { properties: ['expression'], required: ['expression'] },
  request_handoff: { properties: ['reason'], required: ['reason'] },
  view_login: { required: ['machine', 'usernameRef', 'passwordRef'], properties: ['machine', 'usernameRef', 'passwordRef', 'submitRef'] },
}

function schemaOf(def: { inputSchema: Record<string, unknown> }): { properties: string[]; required: string[] } {
  const props = def.inputSchema['properties']
  const required = def.inputSchema['required']
  return {
    properties: typeof props === 'object' && props !== null ? Object.keys(props) : [],
    required: Array.isArray(required) ? required.map((r) => String(r)) : [],
  }
}

describe('VIEW_TOOL_DEFS', () => {
  it('九個定義,名稱與順序照契約 §2', () => {
    expect(VIEW_TOOL_DEFS.map((d) => d.name)).toEqual([...VIEW_TOOL_NAMES])
  })

  it('每個定義都有非空的中文描述', () => {
    for (const def of VIEW_TOOL_DEFS) expect(def.description.length, def.name).toBeGreaterThan(0)
  })

  it('JSON Schema 是 object,不帶 $schema(codex 的 dynamicTools 只吃 schema 本體)', () => {
    for (const def of VIEW_TOOL_DEFS) {
      expect(def.inputSchema['type'], def.name).toBe('object')
      expect('$schema' in def.inputSchema, def.name).toBe(false)
    }
  })

  it('JSON Schema 的欄位名與必填逐個照契約', () => {
    for (const def of VIEW_TOOL_DEFS) {
      expect(schemaOf(def), def.name).toEqual({
        properties: [...(EXPECTED[def.name]?.properties ?? [])],
        required: [...(EXPECTED[def.name]?.required ?? [])],
      })
    }
  })

  it('zod shape 的欄位名與 JSON Schema 的欄位名一字不差(兩份不會分岔)', () => {
    for (const def of VIEW_TOOL_DEFS) {
      expect(schemaOf(def).properties, def.name).toEqual(Object.keys(def.shape))
    }
  })

  it('zod shape 的必填與 JSON Schema 的 required 一致', () => {
    for (const def of VIEW_TOOL_DEFS) {
      const optional = Object.entries(def.shape)
        .filter(([, field]) => z.object({ f: field }).safeParse({}).success)
        .map(([key]) => key)
      const required = Object.keys(def.shape).filter((key) => !optional.includes(key))
      expect(schemaOf(def).required, def.name).toEqual(required)
    }
  })

  it('viewToolDef 用平鋪名字查得到,前綴名與未知名查不到', () => {
    expect(viewToolDef('view_click')?.name).toBe('view_click')
    expect(viewToolDef('mcp__yeschef__view_click')).toBeUndefined()
    expect(viewToolDef('Read')).toBeUndefined()
  })
})

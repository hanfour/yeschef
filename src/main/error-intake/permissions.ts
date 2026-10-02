interface Grant {
  readonly privileges: ReadonlySet<string>
  readonly database: string | null
  readonly table: string | null
  readonly global: boolean
  readonly grantOption: boolean
}

const REQUIRED: readonly { readonly table: string; readonly privilege: string; readonly grant: boolean }[] = [
  ...['SELECT', 'INSERT', 'UPDATE', 'DELETE'].flatMap((privilege) => [
    { table: 'error_group', privilege, grant: true },
    { table: 'error_event', privilege, grant: true },
  ]),
  { table: 'error_intake_meta', privilege: 'SELECT', grant: true },
  { table: 'error_intake_meta', privilege: 'INSERT', grant: false },
]

export function missingAdminPermissions(rows: readonly unknown[], database: string): readonly string[] {
  const grants = rows.flatMap(grantRows)
  const missing = new Set<string>()
  if (!allows(grants, 'CREATE', database, '*', false)) missing.add('CREATE')
  if (!allowsGlobal(grants, 'CREATE USER')) missing.add('CREATE USER')
  for (const item of REQUIRED) {
    if (!allows(grants, item.privilege, database, item.table, false)) {
      missing.add(`${item.privilege}（${item.table}）`)
    }
    if (item.grant && !allows(grants, item.privilege, database, item.table, true)) {
      missing.add(`GRANT OPTION（${item.table}）`)
    }
  }
  return [...missing]
}

function grantRows(raw: unknown): Grant[] {
  if (typeof raw !== 'object' || raw === null) return []
  return Object.values(raw).filter((line): line is string => typeof line === 'string').flatMap(parseGrant)
}

function parseGrant(line: string): Grant[] {
  const match = /^GRANT\s+(.+?)\s+ON\s+(.+?)\s+TO\s+/i.exec(line.trim())
  if (match === null) return []
  const scope = splitScope(match[2] ?? '')
  if (scope === undefined) return []
  const parts = (match[1] ?? '').split(',').map((part) => part.trim().toUpperCase())
  return [{
    privileges: new Set(parts),
    ...scope,
    grantOption: /\sWITH\sGRANT\sOPTION\s*$/i.test(line),
  }]
}

function splitScope(raw: string): Pick<Grant, 'database' | 'table' | 'global'> | undefined {
  const dot = separatorIndex(raw)
  if (dot < 0 || raw.indexOf('.', dot + 1) !== -1) return undefined
  const database = unquote(raw.slice(0, dot))
  const table = unquote(raw.slice(dot + 1))
  if (database === undefined || table === undefined) return undefined
  if (database === '*' && table === '*') return { database: null, table: null, global: true }
  if (table === '*') return { database, table: null, global: false }
  return { database, table, global: false }
}

function separatorIndex(raw: string): number {
  let quoted = false
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]
    if (char === '`' && quoted && raw[index + 1] === '`') { index += 1; continue }
    if (char === '`') { quoted = !quoted; continue }
    if (char === '.' && !quoted) return index
  }
  return -1
}

function unquote(raw: string): string | undefined {
  if (raw === '*') return '*'
  if (raw.startsWith('`') && raw.endsWith('`')) return raw.slice(1, -1).replaceAll('``', '`')
  if (/^[a-zA-Z0-9_$-]+$/.test(raw)) return raw
  return undefined
}

function allows(grants: readonly Grant[], privilege: string, database: string, table: string, requireGrant: boolean): boolean {
  return grants.some((grant) => {
    if (!grant.privileges.has(privilege) && !grant.privileges.has('ALL PRIVILEGES') && !grant.privileges.has('ALL')) return false
    if (requireGrant && !grant.grantOption) return false
    return grant.global || (grant.database === database && (grant.table === null || grant.table === table))
  })
}

function allowsGlobal(grants: readonly Grant[], privilege: string): boolean {
  return grants.some((grant) => grant.global && (
    grant.privileges.has(privilege) || grant.privileges.has('ALL PRIVILEGES') || grant.privileges.has('ALL')
  ))
}

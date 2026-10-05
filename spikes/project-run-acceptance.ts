/** Node 22 type stripping does not resolve this repo's .js-to-.ts spike imports; bundle them first. */
import { spawnSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(ROOT, 'spikes', 'project-run-acceptance-flow.ts')
const BUNDLE = join(ROOT, '.spike-out', 'project-run-acceptance.cjs')

async function main(): Promise<void> {
  await mkdir(dirname(BUNDLE), { recursive: true })
  await build({ entryPoints: [ENTRY], bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: BUNDLE })
  const result = spawnSync(process.execPath, [BUNDLE], { cwd: ROOT, env: process.env, stdio: 'inherit' })
  process.exitCode = result.status ?? 1
}

void main().catch(error => {
  process.stderr.write(JSON.stringify({ check: '實機流程初始化', ok: false, detail: error instanceof Error ? error.message : String(error) }) + '\n')
  process.exitCode = 1
})

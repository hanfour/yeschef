import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyProjectEnvironment, readConfig, validateInputs } from '../spikes/error-intake-acceptance-runtime.js'

const REQUIRED_ENV = {
  EI_TEST_DB_ROOT_URL: 'mysql://root:secret@127.0.0.1:3306/error_intake_test',
  EI_PACKAGE_SOURCE: '/tmp/error-intake.tgz',
  TARGET_REPO: '/tmp/demo-app',
  TARGET_GITHUB_REPO: 'example/demo-app',
  TARGET_ENV_FILE: 'backend/.env',
}

describe('error intake acceptance target configuration', () => {
  it.each([
    ['TARGET_REPO', '缺少 TARGET_REPO'],
    ['TARGET_GITHUB_REPO', '缺少 TARGET_GITHUB_REPO'],
    ['TARGET_ENV_FILE', '缺少 TARGET_ENV_FILE'],
  ] as const)('requires %s with a clear error', (key, message) => {
    const env: NodeJS.ProcessEnv = { ...REQUIRED_ENV }
    delete env[key]

    expect(() => readConfig(env)).toThrow(message)
  })

  it('reads the repository, GitHub slug, and environment file from their neutral variables', () => {
    const config = readConfig(REQUIRED_ENV)

    expect(config).toMatchObject({
      targetRepo: '/tmp/demo-app',
      targetGithubRepo: 'example/demo-app',
      targetEnvFile: 'backend/.env',
    })
  })

  it('validates and copies the configured environment file inside the target repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yeschef-target-project-'))
    const repo = join(root, 'repo')
    const worktree = join(root, 'worktree')
    const envFile = join(repo, 'backend/.env')
    const packageSource = join(root, 'error-intake.tgz')
    try {
      await mkdir(join(repo, 'backend'), { recursive: true })
      await mkdir(join(worktree, 'backend'), { recursive: true })
      await writeFile(envFile, 'DATABASE_URL=mysql://example\n')
      await writeFile(packageSource, 'package')
      const config = readConfig({ ...REQUIRED_ENV, TARGET_REPO: repo, EI_PACKAGE_SOURCE: packageSource })

      await expect(validateInputs(config)).resolves.toBeUndefined()
      await copyProjectEnvironment(repo, worktree, config.targetEnvFile)

      const copiedPath = join(worktree, config.targetEnvFile)
      expect(await readFile(copiedPath, 'utf8')).toBe('DATABASE_URL=mysql://example\n')
      expect((await stat(copiedPath)).mode & 0o777).toBe(0o600)
      await expect(validateInputs({ ...config, targetEnvFile: 'missing/.env' })).rejects.toThrow('TARGET_ENV_FILE')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['../outside.env', '/tmp/private.env'])('rejects unsafe target values: %s', (value) => {
    expect(() => readConfig({ ...REQUIRED_ENV, TARGET_ENV_FILE: value })).toThrow('TARGET_ENV_FILE')
  })

  it('requires TARGET_GITHUB_REPO to be an owner/repository slug', () => {
    expect(() => readConfig({ ...REQUIRED_ENV, TARGET_GITHUB_REPO: 'example' })).toThrow('owner/repository')
  })
})

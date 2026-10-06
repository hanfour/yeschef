import { describe, expect, it } from 'vitest'
import { detectProjectRunCandidates } from '../src/main/project-run/detect.js'

describe('detectProjectRunCandidates', () => {
  it('使用 lockfile 選套件管理器並讀 scripts.dev/start/preview/serve', () => {
    const candidates = detectProjectRunCandidates({
      packageJson: JSON.stringify({ scripts: { dev: 'vite', start: 'next start', preview: 'astro preview', serve: 'webpack serve' } }),
      lockfiles: ['pnpm-lock.yaml'],
    })
    expect(candidates.map(({ command, port }) => [command, port])).toEqual([
      ['pnpm run dev', 5173],
      ['pnpm run start', 3000],
      ['pnpm run preview', 4321],
      ['pnpm run serve', 8080],
    ])
    expect(candidates.map(({ source }) => source)).toEqual([
      'package.json scripts.dev', 'package.json scripts.start',
      'package.json scripts.preview', 'package.json scripts.serve',
    ])
    expect(candidates.map(({ watchEnabled }) => watchEnabled)).toEqual([false, true, true, false])
  })

  it.each([
    ['yarn.lock', 'yarn run dev'],
    ['bun.lockb', 'bun run dev'],
    ['package-lock.json', 'npm run dev'],
  ])('依 %s 選擇套件管理器', (lockfile, command) => {
    expect(detectProjectRunCandidates({
      packageJson: JSON.stringify({ scripts: { dev: 'node server.js' } }),
      lockfiles: [lockfile],
    })[0]?.command).toBe(command)
  })

  it.each([
    ['vite --port 4201', 4201],
    ['next dev -p 4202', 4202],
    ['PORT=4203 node app.js', 4203],
  ])('從 script 指令解析 port：%s', (script, port) => {
    const candidate = detectProjectRunCandidates({ packageJson: JSON.stringify({ scripts: { dev: script } }) })[0]
    expect(candidate?.port).toBe(port)
  })

  it('辨認 Django 與 Flask 常見命令埠', () => {
    const candidates = detectProjectRunCandidates({
      packageJson: JSON.stringify({ scripts: { dev: 'python manage.py runserver', start: 'flask run' } }),
    })
    expect(candidates.map(({ port }) => port)).toEqual([8000, 5000])
  })

  it('由 Python 檔案建立候選，優先使用 .venv，其次 venv', () => {
    expect(detectProjectRunCandidates({ pythonFiles: ['server.py'], hasDotVenv: true })[0]).toMatchObject({
      command: '.venv/bin/python server.py', source: 'Python server.py', port: null,
    })
    expect(detectProjectRunCandidates({ pythonFiles: ['app.py'], hasVenv: true })[0]?.command).toBe('venv/bin/python app.py')
    expect(detectProjectRunCandidates({ pythonFiles: ['main.py'] })[0]?.command).toBe('python3 main.py')
  })

  it('Python 入口有 argparse --port 時帶出可替換連接埠與預設埠', () => {
    const source = "parser.add_argument('--host', default='127.0.0.1')\nparser.add_argument('--port', type=int, default=6062)\n"
    expect(detectProjectRunCandidates({ pythonFiles: ['server.py'], hasDotVenv: true, pythonSources: { 'server.py': source } })[0]).toMatchObject({
      command: '.venv/bin/python server.py --port {port}', port: 6062, portStrategy: 'placeholder', source: 'Python server.py',
    })
    const noDefault = 'parser.add_argument("-p", "--port", type=int)\n'
    expect(detectProjectRunCandidates({ pythonFiles: ['app.py'], pythonSources: { 'app.py': noDefault } })[0]).toMatchObject({
      command: 'python3 app.py --port {port}', port: 8000, portStrategy: 'placeholder',
    })
  })

  it('Python 入口寫死 port= 時帶出固定連接埠', () => {
    expect(detectProjectRunCandidates({ pythonFiles: ['app.py'], pythonSources: { 'app.py': 'app.run(host="0.0.0.0", port=5050)\n' } })[0]).toMatchObject({
      command: 'python3 app.py', port: 5050,
    })
  })

  it('README 區塊略過 cd 這類切換目錄的行', () => {
    expect(detectProjectRunCandidates({ readme: '```sh\ncd ~/work/demo\nnpm run dev\n```' })).toEqual([
      expect.objectContaining({ command: 'npm run dev' }),
    ])
  })

  it('使用 Procfile 的 web 指令', () => {
    expect(detectProjectRunCandidates({ procfile: 'worker: celery -A app worker\nweb: PORT=4100 python app.py' })).toEqual([
      expect.objectContaining({ command: 'PORT=4100 python app.py', port: 4100, source: 'Procfile web' }),
    ])
  })

  it('只從 README 程式碼區塊取命令與 localhost port', () => {
    const candidates = detectProjectRunCandidates({
      readme: '# Demo\n外部網址 localhost:1234 不算\n```sh\nnpm run dev\nhttp://127.0.0.1:4310\n```',
    })
    expect(candidates).toEqual([
      expect.objectContaining({ command: 'npm run dev', port: 4310, source: 'README 程式碼區塊' }),
    ])
  })

  it('無法辨認 port 時保留 null，沒有可用指令時回空清單', () => {
    expect(detectProjectRunCandidates({ packageJson: JSON.stringify({ scripts: { dev: 'node custom.js' } }) })[0]?.port).toBeNull()
    expect(detectProjectRunCandidates({})).toEqual([])
  })
})

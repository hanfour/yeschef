// node-pty 1.x 用 N-API prebuild,在 Electron 直接載入,不需要 electron-rebuild。
// 唯一的問題:prebuild 裡的 spawn-helper 執行位元會被 npm 的 allow-scripts 剝掉,
// posix_spawn 那個 helper 就會 failed。這支腳本把它補回來,install 後跑一次。
import { chmodSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dirs = ['darwin-arm64', 'darwin-x64']
let fixed = 0
for (const d of dirs) {
  const helper = join(root, 'node_modules', 'node-pty', 'prebuilds', d, 'spawn-helper')
  if (existsSync(helper)) {
    chmodSync(helper, 0o755)
    fixed += 1
    console.log('[fix-node-pty] chmod +x', helper)
  }
}
if (fixed === 0) console.log('[fix-node-pty] 沒找到 spawn-helper(非 macOS 或 node-pty 未裝),略過')

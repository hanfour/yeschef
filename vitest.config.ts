import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: { alias: { '@yeschef/error-intake': fileURLToPath(new URL('./packages/error-intake/src/index.ts', import.meta.url)) } },
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    coverage: {
      // 排除制而不是列舉制：列舉制之下新增的檔案預設不被量到，覆蓋率數字看起來
      // 沒變，實際上多了一塊沒人看的區域。改成全收之後，每一個排除項都要寫理由。
      include: ['src/**/*.{ts,tsx}', 'spikes/measure-memory.ts'],
      exclude: [
        // 型別宣告，沒有可執行的程式碼
        'src/**/*.d.ts',
        // 掛載點，只有 DOM 副作用
        'src/renderer/main.tsx',
        // Electron 啟動接線，無測試縫；可測的工廠已抽到 session-options.ts
        'src/main/index.ts',
        // 純 Electron API 組裝，無可測邏輯
        'src/main/agent-view.ts',
      ],
    },
  },
})

import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { fileURLToPath } from 'node:url'

const errorIntakeEntry = fileURLToPath(new URL('./packages/error-intake/src/index.ts', import.meta.url))

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@yeschef/error-intake': errorIntakeEntry } },
    build: { rollupOptions: { input: 'src/main/index.ts' } },
  },
  preload: {
    build: {
      // Sandboxed preload cannot require arbitrary Node packages at runtime.
      externalizeDeps: { exclude: ['zod'] },
      rollupOptions: {
        input: 'src/preload/bridge.ts',
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: { root: 'src/renderer', build: { rollupOptions: { input: 'src/renderer/index.html' } } },
})

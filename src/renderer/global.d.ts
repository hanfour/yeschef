import type { YesChefApi } from '../shared/ipc.js'

declare global {
  interface Window {
    readonly yeschef: YesChefApi
  }
}

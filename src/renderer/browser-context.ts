import { createContext } from 'react'
import type { BrowserSessionEntry } from '../shared/browser-ipc.js'

/** 哪些對話有瀏覽器、哪些正在被工具操作(每對話瀏覽器規格 §6)。沒包 Provider 就是空的。 */
export const BrowserSessionsContext = createContext<readonly BrowserSessionEntry[]>([])

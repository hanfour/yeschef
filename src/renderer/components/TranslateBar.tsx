import { useId, useState } from 'react'
import { readAppStorage, writeAppStorage } from '../storage.js'
import { useElapsedSeconds } from '../elapsed.js'
import type { YesChefApi } from '../../shared/ipc.js'
import { isTranslateLanguage, TRANSLATE_LANGUAGES, type TranslateLanguage } from '../../shared/translate.js'
import { Markdown } from './Markdown.js'
import './TranslateBar.css'

interface TranslateBarProps {
  readonly text: string
  readonly translate: YesChefApi['translate']
}
const STORAGE_KEY = 'yeschef.translate.lastLanguage'
function readLanguage(): TranslateLanguage | null {
  try {
    const value = readAppStorage(STORAGE_KEY)
    return isTranslateLanguage(value) ? value : null
  } catch {
    // 禁止站台儲存時仍可使用翻譯。
    return null
  }
}
function languageLabel(lang: TranslateLanguage): string {
  return TRANSLATE_LANGUAGES.find(({ code }) => code === lang)?.label ?? lang
}

export function TranslateBar({ text, translate }: TranslateBarProps) {
  const [open, setOpen] = useState(false)
  const [lastLanguage, setLastLanguage] = useState(readLanguage)
  const [results, setResults] = useState<ReadonlyMap<TranslateLanguage, string>>(() => new Map())
  const [visible, setVisible] = useState<ReadonlySet<TranslateLanguage>>(() => new Set())
  const [pending, setPending] = useState<TranslateLanguage | null>(null)
  const [error, setError] = useState<{ lang: TranslateLanguage; message: string } | null>(null)
  const listId = useId()
  // 長訊息可能要等幾十秒,不顯示秒數會被當成壞掉。
  const waited = useElapsedSeconds(pending !== null)
  const context = `「${text.slice(0, 60)}」的翻譯`

  async function run(lang: TranslateLanguage): Promise<void> {
    setOpen(false)
    setLastLanguage(lang)
    try {
      writeAppStorage(STORAGE_KEY, lang)
    } catch {
      // 寫入失敗只影響下次啟動的語言記憶，不中斷這次翻譯。
    }
    setError(null)
    if (results.has(lang)) {
      setVisible(previous => new Set([...previous, lang]))
      return
    }
    setPending(lang)
    try {
      const result = await translate({ text, target: lang })
      if (result.kind === 'ok') {
        setResults(previous => new Map([...previous, [lang, result.text]]))
        setVisible(previous => new Set([...previous, lang]))
      } else {
        setError({ lang, message: result.message })
      }
    } catch {
      setError({ lang, message: '翻譯失敗，請重試' })
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="translate-bar">
      <div className="translate-controls">
        <button type="button" aria-label={`${context}：${lastLanguage === null ? '選擇語言' : languageLabel(lastLanguage)}`}
          disabled={pending !== null}
          {...(lastLanguage === null ? { 'aria-expanded': open, 'aria-controls': listId } : {})}
          onClick={() => { if (lastLanguage === null) setOpen(value => !value); else void run(lastLanguage) }}>
          {lastLanguage === null ? '譯' : `譯→${languageLabel(lastLanguage)}`}
        </button>
        {lastLanguage !== null && <button type="button" aria-label={`${context}：選擇其他語言`}
          aria-expanded={open} aria-controls={listId} disabled={pending !== null} onClick={() => setOpen(value => !value)}>⌄</button>}
        {pending !== null && <span role="status">翻譯中<span aria-hidden="true">{` ${String(waited)} 秒`}</span></span>}
      </div>
      {open && <div className="translate-languages" id={listId}>
        {/* 目前 run() 一開始就收起清單,所以翻譯中到不了這裡;顯式擋著,不依賴狀態變化的順序。 */}
        {TRANSLATE_LANGUAGES.map(({ code, label }) => <button key={code} type="button" disabled={pending !== null} onClick={() => { void run(code) }}>{label}</button>)}
      </div>}
      {error !== null && <div className="translate-error" role="alert">
        {error.message} <button type="button" onClick={() => { void run(error.lang) }}>重試</button>
      </div>}
      {[...results].filter(([lang]) => visible.has(lang)).map(([lang, translated]) => (
        <div className="translate-result" key={lang}>
          <div className="translate-label">
            <span>{languageLabel(lang)}</span>
            <button type="button" aria-label={`收起${context}：${languageLabel(lang)}`}
              onClick={() => setVisible(previous => new Set([...previous].filter(value => value !== lang)))}>收起</button>
          </div>
          <Markdown markdown={translated} complete />
        </div>
      ))}
    </div>
  )
}

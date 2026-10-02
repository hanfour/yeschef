const languageLabels = {
  'zh-Hant': '繁體中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  'zh-Hans': '简体中文',
} as const

export type TranslateLanguage = keyof typeof languageLabels

export const TRANSLATE_LANGUAGE_LABELS: Readonly<Record<TranslateLanguage, string>> = languageLabels

// 語言代碼、名稱與選單順序共用同一份來源；此處只列舉上方物件的自有鍵。
export const TRANSLATE_LANGUAGES: readonly { readonly code: TranslateLanguage; readonly label: string }[] = (Object.keys(languageLabels) as TranslateLanguage[])
  .map((code) => ({ code, label: TRANSLATE_LANGUAGE_LABELS[code] }))

export function isTranslateLanguage(raw: unknown): raw is TranslateLanguage {
  return TRANSLATE_LANGUAGES.some(({ code }) => code === raw)
}

export const TRANSLATE_MAX_CHARS = 20000

export type TranslatePayload = { readonly text: string; readonly target: string }
export type TranslateResult =
  | { readonly kind: 'ok'; readonly text: string }
  | { readonly kind: 'rejected'; readonly message: string }

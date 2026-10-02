import { useCallback, useMemo, useState } from 'react'
import { activateTab, closePreview, INITIAL_TABS, openPreview, type PreviewSource } from '../previews.js'

export function usePreviewTabs() {
  const [tabs, setTabs] = useState(INITIAL_TABS)
  const open = useCallback((source: PreviewSource): void => {
    const id = crypto.randomUUID()
    setTabs((state) => openPreview(state, source, id))
  }, [])
  const close = useCallback((id: string): void => {
    setTabs((state) => closePreview(state, id))
  }, [])
  const activate = useCallback((id: string): void => {
    setTabs((state) => activateTab(state, id))
  }, [])
  return useMemo(() => ({ tabs, open, close, activate }), [tabs, open, close, activate])
}

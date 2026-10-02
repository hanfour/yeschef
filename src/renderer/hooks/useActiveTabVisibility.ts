import { useLayoutEffect, type RefObject } from 'react'

export const TAB_FADE_WIDTH = 16

/** Reveal the selected tab horizontally without moving the workbench vertically. */
export function useActiveTabVisibility(ref: RefObject<HTMLElement | null>, activeId: string | null | undefined, edgePadding = 4): void {
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const reveal = () => {
      const tab = element.querySelector<HTMLElement>('[role=tab][aria-selected=true]')
      if (!tab) return
      const bounds = element.getBoundingClientRect()
      const selected = tab.getBoundingClientRect()
      if (!bounds.width) return
      const visibleLeft = bounds.left + edgePadding
      const visibleRight = bounds.right - edgePadding
      if (selected.left < visibleLeft && element.scrollLeft > 0) element.scrollLeft -= visibleLeft - selected.left + 4
      else if (selected.right > visibleRight && element.scrollLeft < element.scrollWidth - element.clientWidth) element.scrollLeft += selected.right - visibleRight + 4
    }
    reveal()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(reveal)
    observer?.observe(element)
    window.addEventListener('resize', reveal)
    return () => { observer?.disconnect(); window.removeEventListener('resize', reveal) }
  }, [ref, activeId, edgePadding])
}

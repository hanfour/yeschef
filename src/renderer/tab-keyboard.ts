import type { KeyboardEvent } from 'react'
/** Nested close buttons keep their own keyboard behavior. */
export function tabKeyboard(event: KeyboardEvent<HTMLElement>, activate: () => void): void {
  if (event.target !== event.currentTarget || event.altKey || event.metaKey || event.ctrlKey) return
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); return }
  const tabs = Array.from(event.currentTarget.closest('[role=tablist]')?.querySelectorAll<HTMLElement>('[role=tab]') ?? [])
  const index = tabs.indexOf(event.currentTarget)
  const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1
  if (next < 0 || !tabs[next]) return
  event.preventDefault()
  tabs[next].focus()
  tabs[next].click()
}

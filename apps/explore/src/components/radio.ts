import type { KeyboardEvent } from 'react'

export function radioIndex(key: string, index: number, count: number): number | null {
  if (count === 0) return null
  if (key === 'ArrowRight' || key === 'ArrowDown') return (index + 1) % count
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (index - 1 + count) % count
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return null
}

export function selectRadio(event: KeyboardEvent<HTMLButtonElement>, index: number, count: number, select: (index: number) => void): void {
  const next = radioIndex(event.key, index, count)
  if (next === null) return
  event.preventDefault()
  select(next)
  const radios = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button[role="radio"]')
  radios?.[next]?.focus()
}

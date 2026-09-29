/**
 * Times as people read them: in their own time zone, with a live "in 2 h" that every mounted clock shares (one
 * interval for the whole app), and the exact UTC instant in the tooltip.
 */
import { useSyncExternalStore } from 'react'
import { localTime, relative, span } from '../format.ts'

const listeners = new Set<() => void>()
let now = Math.floor(Date.now() / 1000)
let timer: ReturnType<typeof setInterval> | undefined

function subscribe(fn: () => void) {
  listeners.add(fn)
  timer ??= setInterval(() => {
    now = Math.floor(Date.now() / 1000)
    for (const l of listeners) l()
  }, 1000)
  return () => {
    listeners.delete(fn)
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }
}

/** The current unix second, shared by every clock on the page. */
export const useNow = (): number => useSyncExternalStore(subscribe, () => now, () => now)

const utc = (unix: number) => `${new Date(unix * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`

/** "Thu 1 Oct, 14:29 · in 2 h" (or only one half), with the UTC instant on hover. */
export function When({ at, show = 'both' }: { at: number | null | undefined; show?: 'both' | 'time' | 'relative' }) {
  const t = useNow()
  if (at === null || at === undefined || at === 0) return <span className="text-label-3">—</span>
  return (
    <time dateTime={new Date(at * 1000).toISOString()} title={utc(at)} className="tabular">
      {show !== 'relative' && localTime(at)}
      {show === 'both' && <span className="text-label-3"> · </span>}
      {show !== 'time' && relative(at, t)}
    </time>
  )
}

/** "2 h 5 min" until `to`, or "passed" once it has. */
export function Countdown({ to }: { to: number }) {
  const t = useNow()
  return (
    <time dateTime={new Date(to * 1000).toISOString()} title={utc(to)} className="tabular">
      {to >= t ? span(to - t) : 'passed'}
    </time>
  )
}

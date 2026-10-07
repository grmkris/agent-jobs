/**
 * Times as people read them: in their own time zone, with a live "in 2 h" that every mounted clock shares (one
 * interval for the whole app), and the exact UTC instant in the tooltip.
 */
import { useSyncExternalStore } from 'react'
import { countdownTick } from '../countdown.ts'
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
export const useNow = (): number =>
  useSyncExternalStore(
    subscribe,
    () => now,
    () => now,
  )

/** The current unix minute: for lists that sort and phase by time without re-rendering every second. */
export const useMinute = (): number =>
  useSyncExternalStore(
    subscribe,
    () => Math.floor(now / 60) * 60,
    () => Math.floor(now / 60) * 60,
  )

/**
 * The seconds left until `deadline`, as a countdown shows them: the snapshot only changes once a minute while an
 * hour or more is left, so a far deadline re-renders per minute and the last hour per second.
 */
export const useRemaining = (deadline: number): number =>
  useSyncExternalStore(
    subscribe,
    () => countdownTick(deadline - now),
    () => countdownTick(deadline - now),
  )

/** "2026-10-07 14:29 UTC": the exact instant, for a time's tooltip. */
export const utc = (unix: number) => `${new Date(unix * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`

/** "Thu 1 Oct, 14:29 · in 2 h" (or only one half), with the UTC instant on hover. */
export function When({ at, show = 'both' }: { at: number | null | undefined; show?: 'both' | 'time' | 'relative' }) {
  const t = useNow()
  if (at === null || at === undefined || at === 0) return <span className="text-muted-foreground">—</span>
  return (
    <time dateTime={new Date(at * 1000).toISOString()} title={utc(at)} className="tabular-nums">
      {show !== 'relative' && localTime(at)}
      {show === 'both' && <span className="text-muted-foreground"> · </span>}
      {show !== 'time' && relative(at, t)}
    </time>
  )
}

/** "2 h 5 min" until `to`, or "passed" once it has. */
export function Countdown({ to }: { to: number }) {
  const t = useNow()
  return (
    <time dateTime={new Date(to * 1000).toISOString()} title={utc(to)} className="tabular-nums">
      {to >= t ? span(to - t) : 'passed'}
    </time>
  )
}

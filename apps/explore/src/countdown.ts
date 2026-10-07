/**
 * A deadline's remaining time as countdown parts: "2d 04h 17m" while an hour or more is left, then "17m 32s". The
 * parts carry their padding and the highest tens digit each can show, so rolling digits never spin past 5 or 2.
 */
export interface CountdownPart {
  readonly value: number
  readonly unit: 'd' | 'h' | 'm' | 's'
  readonly pad: 1 | 2
  /** The largest tens digit this part shows (minutes 5, hours 2); none for days. */
  readonly tensMax?: number
}

const HOUR = 3600

export function countdownParts(left: number): CountdownPart[] {
  const s = Math.max(0, Math.floor(left))
  if (s >= HOUR) {
    return [
      { value: Math.floor(s / 86_400), unit: 'd', pad: 1 },
      { value: Math.floor((s % 86_400) / HOUR), unit: 'h', pad: 2, tensMax: 2 },
      { value: Math.floor((s % HOUR) / 60), unit: 'm', pad: 2, tensMax: 5 },
    ]
  }
  return [
    { value: Math.floor(s / 60), unit: 'm', pad: 2, tensMax: 5 },
    { value: s % 60, unit: 's', pad: 2, tensMax: 5 },
  ]
}

/** "2d 04h 17m": what the rolling digits show, as plain text for screen readers and tests. */
export const countdownText = (parts: readonly CountdownPart[]): string =>
  parts.map((p) => `${String(p.value).padStart(p.pad, '0')}${p.unit}`).join(' ')

/** What a countdown re-renders on: the seconds left, floored to the minute while an hour or more is left. */
export const countdownTick = (left: number): number => (left <= 0 ? 0 : left >= HOUR ? Math.floor(left / 60) * 60 : Math.floor(left))

/** Under an hour left: the countdown ticks seconds and turns amber. */
export const countdownUrgent = (left: number): boolean => left > 0 && left < HOUR

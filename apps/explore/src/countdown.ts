/**
 * A deadline's remaining time as countdown parts: "2d 04h 17m", with seconds at display precision. The
 * parts carry their padding and the highest tens digit each can show, so rolling digits never spin past 5 or 2.
 */
export interface CountdownPart {
  readonly value: number
  readonly unit: 'd' | 'h' | 'm' | 's'
  readonly pad: 1 | 2
  /** The largest tens digit this part shows (minutes and seconds 5, hours 2); none for days. */
  readonly tensMax?: number
}

const HOUR = 3600

export type CountdownPrecision = 'second' | 'minute'

export function countdownParts(left: number, precision: CountdownPrecision = 'minute'): CountdownPart[] {
  const s = Math.max(0, Math.floor(left))
  const parts: CountdownPart[] = [
    { value: Math.floor(s / 86_400), unit: 'd', pad: 1 },
    { value: Math.floor((s % 86_400) / HOUR), unit: 'h', pad: 2, tensMax: 2 },
    { value: Math.floor((s % HOUR) / 60), unit: 'm', pad: 2, tensMax: 5 },
  ]
  if (precision === 'second') parts.push({ value: s % 60, unit: 's', pad: 2, tensMax: 5 })
  while (parts.length > 1 && parts[0]?.value === 0) parts.shift()
  return parts
}

/** "2d 04h 17m": what the rolling digits show, as plain text for screen readers and tests. */
export const countdownText = (parts: readonly CountdownPart[]): string =>
  parts.map((p) => `${String(p.value).padStart(p.pad, '0')}${p.unit}`).join(' ')

/** What a countdown re-renders on: the seconds left, floored to its requested precision. */
export const countdownTick = (left: number, precision: CountdownPrecision = 'minute'): number => {
  const s = Math.max(0, Math.floor(left))
  if (precision === 'second' || s === 0) return s
  return Math.max(1, Math.floor(s / 60) * 60)
}

/** Under an hour left: the countdown turns amber. */
export const countdownUrgent = (left: number): boolean => left > 0 && left < HOUR

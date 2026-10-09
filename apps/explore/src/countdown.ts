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

/** A display countdown always shows seconds; a row only in its last hour, when it also turns amber. */
const withSeconds = (s: number, precision: CountdownPrecision) => precision === 'second' || s < HOUR

export function countdownParts(left: number, precision: CountdownPrecision = 'minute'): CountdownPart[] {
  const s = Math.max(0, Math.floor(left))
  const parts: CountdownPart[] = [
    { value: Math.floor(s / 86_400), unit: 'd', pad: 1 },
    { value: Math.floor((s % 86_400) / HOUR), unit: 'h', pad: 2, tensMax: 2 },
    { value: Math.floor((s % HOUR) / 60), unit: 'm', pad: 2, tensMax: 5 },
  ]
  if (withSeconds(s, precision)) parts.push({ value: s % 60, unit: 's', pad: 2, tensMax: 5 })
  while (parts.length > 1 && parts[0]?.value === 0) parts.shift()
  return parts
}

/** "2d 04h 17m": what the rolling digits show, as plain text for screen readers and tests. */
export const countdownText = (parts: readonly CountdownPart[]): string =>
  parts.map((p) => `${String(p.value).padStart(p.pad, '0')}${p.unit}`).join(' ')

/** What a countdown re-renders on: the seconds left, floored to the minute while a row shows no seconds. */
export const countdownTick = (left: number, precision: CountdownPrecision = 'minute'): number => {
  const s = Math.max(0, Math.floor(left))
  return s === 0 || withSeconds(s, precision) ? s : Math.floor(s / 60) * 60
}

/** What screen readers hear: minute-level text, with seconds only in the final minute, so it never chatters. */
export function countdownSpoken(left: number): string {
  const s = Math.max(0, Math.floor(left))
  return countdownText(countdownParts(s, 'minute').filter((p) => p.unit !== 's' || s < 60))
}

/** Under an hour left: the countdown turns amber (and a row starts showing seconds). */
export const countdownUrgent = (left: number): boolean => left > 0 && left < HOUR

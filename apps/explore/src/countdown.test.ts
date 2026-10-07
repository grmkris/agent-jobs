import { describe, expect, it } from 'vitest'
import { countdownParts, countdownText, countdownTick, countdownUrgent } from './countdown.ts'

describe('countdown', () => {
  it('shows days, hours and minutes while an hour or more is left, then minutes and seconds', () => {
    expect(countdownText(countdownParts(2 * 86_400 + 4 * 3600 + 17 * 60 + 59))).toBe('2d 04h 17m')
    expect(countdownText(countdownParts(21 * 3600 + 5 * 60))).toBe('0d 21h 05m')
    expect(countdownText(countdownParts(3600))).toBe('0d 01h 00m')
    expect(countdownText(countdownParts(3599))).toBe('59m 59s')
    expect(countdownText(countdownParts(17 * 60 + 32))).toBe('17m 32s')
    expect(countdownText(countdownParts(-5))).toBe('00m 00s')
  })

  it('caps the tens digit each part can roll to', () => {
    expect(countdownParts(90_000).map((p) => p.tensMax)).toEqual([undefined, 2, 5])
    expect(countdownParts(120).map((p) => p.tensMax)).toEqual([5, 5])
  })

  it('re-renders once a minute while far, every second in the last hour', () => {
    expect(countdownTick(7259)).toBe(7200)
    expect(countdownTick(7201)).toBe(7200)
    expect(countdownTick(3599)).toBe(3599)
    expect(countdownTick(0)).toBe(0)
    expect(countdownTick(-30)).toBe(0)
    expect([countdownUrgent(3600), countdownUrgent(3599), countdownUrgent(0)]).toEqual([false, true, false])
  })
})

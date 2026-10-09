import { describe, expect, it } from 'vitest'
import { countdownParts, countdownText, countdownTick, countdownUrgent } from './countdown.ts'

describe('countdown', () => {
  it('shows days, hours and minutes for rows without leading zero units', () => {
    expect(countdownText(countdownParts(2 * 86_400 + 4 * 3600 + 17 * 60 + 59))).toBe('2d 04h 17m')
    expect(countdownText(countdownParts(21 * 3600 + 5 * 60, 'minute'))).toBe('21h 05m')
    expect(countdownText(countdownParts(3600, 'minute'))).toBe('01h 00m')
    expect(countdownText(countdownParts(3599, 'minute'))).toBe('59m')
    expect(countdownText(countdownParts(17 * 60 + 32, 'minute'))).toBe('17m')
    expect(countdownText(countdownParts(-5, 'minute'))).toBe('00m')
  })

  it('shows seconds at display precision even when days or hours remain', () => {
    expect(countdownText(countdownParts(2 * 86_400 + 4 * 3600 + 17 * 60 + 5, 'second'))).toBe('2d 04h 17m 05s')
    expect(countdownText(countdownParts(2 * 3600 + 54 * 60 + 12, 'second'))).toBe('02h 54m 12s')
    expect(countdownText(countdownParts(3600, 'second'))).toBe('01h 00m 00s')
    expect(countdownText(countdownParts(3599, 'second'))).toBe('59m 59s')
    expect(countdownText(countdownParts(17 * 60 + 32, 'second'))).toBe('17m 32s')
  })

  it('drops zero minutes at display precision and keeps interior zero units', () => {
    expect(countdownText(countdownParts(32, 'second'))).toBe('32s')
    expect(countdownText(countdownParts(86_400 + 5, 'second'))).toBe('1d 00h 00m 05s')
    expect(countdownText(countdownParts(-5, 'second'))).toBe('00s')
  })

  it('caps the tens digit each part can roll to', () => {
    expect(countdownParts(90_000).map((p) => p.tensMax)).toEqual([undefined, 2, 5])
    expect(countdownParts(90_000, 'second').map((p) => p.tensMax)).toEqual([undefined, 2, 5, 5])
    expect(countdownParts(120, 'second').map((p) => p.tensMax)).toEqual([5, 5])
  })

  it('re-renders rows once a minute even in the last hour', () => {
    expect(countdownTick(7259)).toBe(7200)
    expect(countdownTick(7201)).toBe(7200)
    expect(countdownTick(3599, 'minute')).toBe(3540)
    expect(countdownTick(0)).toBe(0)
    expect(countdownTick(-30)).toBe(0)
    expect([countdownUrgent(3600), countdownUrgent(3599), countdownUrgent(0)]).toEqual([false, true, false])
  })

  it('re-renders displays every second while days or hours remain', () => {
    expect(countdownTick(86_401, 'second')).toBe(86_401)
    expect(countdownTick(7259, 'second')).toBe(7259)
    expect(countdownTick(7201, 'second')).toBe(7201)
    expect(countdownTick(3599.9, 'second')).toBe(3599)
    expect(countdownTick(0, 'second')).toBe(0)
    expect(countdownTick(-30, 'second')).toBe(0)
  })

  it('keeps rows pending until the deadline passes, including the final minute', () => {
    expect(countdownTick(59, 'minute')).toBe(1)
    expect(countdownTick(1, 'minute')).toBe(1)
    expect(countdownText(countdownParts(countdownTick(59, 'minute'), 'minute'))).toBe('00m')
    expect(countdownTick(0, 'minute')).toBe(0)
  })

  it('keeps minute-level screen-reader text stable as display seconds change', () => {
    expect(countdownText(countdownParts(7259, 'minute'))).toBe(countdownText(countdownParts(7201, 'minute')))
    expect(countdownText(countdownParts(1079, 'minute'))).toBe(countdownText(countdownParts(1021, 'minute')))
  })
})

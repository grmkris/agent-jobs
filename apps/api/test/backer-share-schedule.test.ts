import { expect, it } from 'vitest'
import { backerShareSchedule } from '../src/backer-share.ts'
import * as sdk from '@sidequest/sdk'

const d = sdk.deployment('monad-testnet')
const h = d.sidequest!
const start = h.t0
it('uses the highest share in the unstake window for a raise', () => {
  const result = backerShareSchedule(
    d,
    '7',
    [
      { position: start - 10, value: sdk.encodeBackerShare(1000) },
      { position: start + 10, value: sdk.encodeBackerShare(5000) },
    ],
    start + 100,
  )
  expect(result.current).toEqual({ bps: 1000, epoch: 0, since: start })
  expect(result.next.bps).toBe(5000)
})
it('reports a cut while the unstake delay still protects the current epoch', () => {
  const at = start + 100
  const result = backerShareSchedule(
    d,
    '7',
    [
      { position: start - 100, value: sdk.encodeBackerShare(5000) },
      { position: at, value: sdk.encodeBackerShare(1000) },
    ],
    at + 10,
  )
  expect(result.current.bps).toBe(5000)
  expect(result.pendingCut).toMatchObject({ bps: 1000, at })
})
it('applies a cut after the delay window expires', () => {
  const at = start + 100
  const result = backerShareSchedule(
    d,
    '7',
    [
      { position: start - 100, value: sdk.encodeBackerShare(5000) },
      { position: at, value: sdk.encodeBackerShare(1000) },
    ],
    start + h.clocks!.unstakeDelay + h.clocks!.epochZeroDuration + 100,
  )
  expect(result.current.bps).toBe(1000)
  expect(result.pendingCut).toBeNull()
})

it('keeps a raise at an epoch boundary out of that epoch and preserves epoch zero length', () => {
  const clocks = sdk.configuredClocks(d)
  const at = start + clocks.epochZeroDuration
  expect(backerShareSchedule(d, '7', [{ position: at, value: sdk.encodeBackerShare(6000) }], at).current).toEqual({
    bps: 0,
    epoch: 1,
    since: at,
  })
  expect(backerShareSchedule(d, '7', [{ position: at, value: sdk.encodeBackerShare(6000) }], at).next).toEqual({
    bps: 6000,
    epoch: 2,
  })
})

it('keeps the prior high share when a cut is exactly at the unstake window edge', () => {
  const clocks = sdk.configuredClocks(d)
  const epochStart = start + clocks.epochZeroDuration + 73 * clocks.epochDuration
  const cutAt = epochStart - clocks.unstakeDelay
  const sets = [
    { position: cutAt - 1, value: sdk.encodeBackerShare(5000) },
    { position: cutAt, value: sdk.encodeBackerShare(0) },
  ]
  const schedule = backerShareSchedule(d, '7', sets, epochStart)
  expect(schedule.current.bps).toBe(5000)
  expect(schedule.next.bps).toBe(0)
  expect(schedule.pendingCut?.appliesFromEpoch).toBe(schedule.next.epoch)
})

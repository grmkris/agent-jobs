import { describe, expect, it } from 'vitest'
import { type SummaryEntry, backingSummary } from './backing-summary.ts'

const OWNER = '0x00000000000000000000000000000000000000aa' as const
const AGENT = '0x00000000000000000000000000000000000000bb' as const
const SIDE = 10n ** 18n

function entry(
  account: `0x${string}`,
  p: { active: bigint; queued?: bigint; unlockAt?: number },
  b: { assets: bigint; reserved?: bigint; available?: bigint },
): SummaryEntry {
  return {
    position: {
      account,
      activeValue: p.active,
      queued: p.queued ?? 0n,
      queuedShares: p.queued ?? 0n,
      unlockAt: p.unlockAt ?? 0,
    },
    backing: { assets: b.assets, reserved: b.reserved ?? 0n, available: b.available ?? 0n },
  }
}

describe('backing summary', () => {
  it('adds active backing across positions and reads the own account as what posting can reserve', () => {
    const s = backingSummary(
      [
        entry(OWNER, { active: 50n * SIDE }, { assets: 50n * SIDE, reserved: 10n * SIDE, available: 40n * SIDE }),
        entry(AGENT, { active: 30n * SIDE }, { assets: 100n * SIDE }),
      ],
      20n * SIDE,
      OWNER.toUpperCase(),
      1_000,
    )
    expect(s.wallet).toBe(20n * SIDE)
    expect(s.active).toBe(80n * SIDE)
    expect(s.reservedOwn).toBe(10n * SIDE)
    expect(s.freeOwn).toBe(40n * SIDE)
    expect(s.leaving + s.held + s.ready).toBe(0n)
  })

  it('splits leaving SIDE into still unstaking, held by open deposits, and ready to withdraw', () => {
    const s = backingSummary(
      [
        entry(AGENT, { active: 0n, queued: 5n * SIDE, unlockAt: 2_000 }, { assets: 5n * SIDE }),
        entry(AGENT, { active: 0n, queued: 7n * SIDE, unlockAt: 1_500 }, { assets: 7n * SIDE }),
        entry(OWNER, { active: 0n, queued: 4n * SIDE, unlockAt: 500 }, { assets: 6n * SIDE, reserved: 3n * SIDE }),
        entry(AGENT, { active: 0n, queued: 9n * SIDE, unlockAt: 900 }, { assets: 20n * SIDE, reserved: 1n * SIDE }),
      ],
      0n,
      OWNER,
      1_000,
    )
    expect(s.leaving).toBe(12n * SIDE)
    expect(s.nextUnlock).toBe(1_500)
    expect(s.held).toBe(4n * SIDE)
    expect(s.ready).toBe(9n * SIDE)
  })
})

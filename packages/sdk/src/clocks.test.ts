import { describe, expect, it, vi } from 'vitest'
import { type Address } from 'viem'
import type { Ctx } from './actions.ts'
import { configuredClocks, minimumOfferWindows, readSidequestClocks, readWindowBounds, standardOfferWindows, validateOfferWindows, windowBounds } from './clocks.ts'
import { clocksFromConfig, deployment, MAX_SIDEQUEST_WINDOW, PRODUCTION_CLOCKS } from './deployment.ts'

const FAST = { minReviewWindow: 120, minDisputeWindow: 120, minArbitrationWindow: 300,
  unstakeDelay: 600, holdingDelay: 900, feeDelay: 300, proposalGrace: 1800, epochZeroDuration: 1800, epochDuration: 3600 }

function fixture() {
  const d = deployment('monad-testnet'), h = d.sidequest!
  const values: Record<string, number> = { MIN_REVIEW_WINDOW: FAST.minReviewWindow, MIN_DISPUTE_WINDOW: FAST.minDisputeWindow, MIN_ARBITRATION_WINDOW: FAST.minArbitrationWindow,
    MAX_REVIEW_WINDOW: MAX_SIDEQUEST_WINDOW, MAX_DISPUTE_WINDOW: MAX_SIDEQUEST_WINDOW, MAX_ARBITRATION_WINDOW: MAX_SIDEQUEST_WINDOW,
    UNSTAKE_DELAY: FAST.unstakeDelay, HOLDING_DELAY: FAST.holdingDelay, PROPOSAL_GRACE: FAST.proposalGrace,
    DELAY: FAST.feeDelay, EPOCH_ZERO_DURATION: FAST.epochZeroDuration, EPOCH_DURATION: FAST.epochDuration }
  const readContract = vi.fn(async ({ functionName }: { functionName: string; address: Address }) => {
    if (!(functionName in values)) throw new Error(`unexpected ${functionName}`)
    return values[functionName]!
  })
  const ctx: Ctx = { publicClient: { readContract } as unknown as Ctx['publicClient'], stack: d.stacks.main!,
    // A stale config must not override the deployed immutable reads.
    deployment: { ...d, sidequest: { ...h, clocks: PRODUCTION_CLOCKS } } }
  return { ctx, readContract, values }
}

describe('deploy-time clocks', () => {
  it('retains production defaults for absent clocks and refuses omissions in a present block', () => {
    expect(configuredClocks({ chainId: 10143, sidequest: null })).toEqual(PRODUCTION_CLOCKS)
    expect(() => clocksFromConfig({ minReviewWindow: 120 } as never, 10143)).toThrow('Invalid Sidequest clock')
    expect(clocksFromConfig(FAST, 10143)).toEqual(FAST)
  })

  it.each(Object.keys(PRODUCTION_CLOCKS) as Array<keyof typeof PRODUCTION_CLOCKS>)('mainnet refuses a changed %s', key => {
    expect(() => clocksFromConfig({ ...PRODUCTION_CLOCKS, [key]: FAST[key] }, 143)).toThrow(`Mainnet requires production clock ${key}`)
    expect(clocksFromConfig({ ...PRODUCTION_CLOCKS, [key]: PRODUCTION_CLOCKS[key] }, 143)).toEqual(PRODUCTION_CLOCKS)
  })

  it.each([
    { minReviewWindow: 0 }, { minDisputeWindow: MAX_SIDEQUEST_WINDOW + 1 }, { minArbitrationWindow: 1.5 },
    { unstakeDelay: 59 }, { holdingDelay: NaN }, { feeDelay: 0 }, { proposalGrace: 2 ** 48 },
    { epochZeroDuration: 599 }, { epochDuration: Number.MAX_SAFE_INTEGER },
  ])('refuses invalid config clocks %j', clocks => {
    expect(() => clocksFromConfig({ ...PRODUCTION_CLOCKS, ...clocks }, 10143)).toThrow('Invalid Sidequest clock')
  })

  it('preserves the vault cross-clock invariant', () => {
    expect(() => clocksFromConfig({ ...FAST, holdingDelay: FAST.unstakeDelay }, 10143)).toThrow('holdingDelay must exceed unstakeDelay')
  })

  it('reads the actual window minimums and caches concurrent successful reads per context', async () => {
    const f = fixture()
    const [a, b] = await Promise.all([readWindowBounds(f.ctx), readWindowBounds(f.ctx)])
    expect(a).toBe(b)
    expect(a).toEqual(windowBounds(FAST))
    expect(f.readContract).toHaveBeenCalledTimes(6)
    await readWindowBounds(f.ctx)
    expect(f.readContract).toHaveBeenCalledTimes(6)
    const another = { ...f.ctx }
    await readWindowBounds(another)
    expect(f.readContract).toHaveBeenCalledTimes(12)
  })

  it('reads delay/grace/epoch clocks from the right contracts, without reusing stale config values', async () => {
    const f = fixture(), h = f.ctx.deployment.sidequest!
    const clocks = await readSidequestClocks(f.ctx)
    expect(clocks).toEqual(FAST)
    expect(await readSidequestClocks(f.ctx)).toBe(clocks)
    expect(f.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: h.vault, functionName: 'UNSTAKE_DELAY' }))
    expect(f.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: h.feeSchedule, functionName: 'DELAY' }))
    expect(f.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: h.miningReserve, functionName: 'EPOCH_DURATION' }))
    expect(f.readContract).toHaveBeenCalledTimes(13)
  })

  it('does not cache failed reads or turn RPC failure into production clock evidence', async () => {
    const f = fixture()
    f.readContract.mockRejectedValueOnce(new Error('RPC unavailable'))
    await expect(readWindowBounds(f.ctx)).rejects.toThrow('RPC unavailable')
    expect(await readWindowBounds(f.ctx)).toEqual(windowBounds(FAST))
    f.values.MIN_REVIEW_WINDOW = 0
    await expect(readWindowBounds({ ...f.ctx })).rejects.toThrow('Invalid deployed window bounds')
  })

  it('catches mismatched grace values and retries full clock reads after a failure', async () => {
    const f = fixture(), original = f.readContract.getMockImplementation()!
    f.readContract.mockImplementation(async request => request.functionName === 'PROPOSAL_GRACE' && request.address === f.ctx.deployment.sidequest!.feeSchedule ? 600 : original(request))
    await expect(readSidequestClocks(f.ctx)).rejects.toThrow('grace clocks disagree')
    f.readContract.mockImplementation(original)
    expect(await readSidequestClocks(f.ctx)).toEqual(FAST)
  })

  it('validates the minute-clock boundaries and clamps a Standard preference without changing custom windows', () => {
    const bounds = windowBounds(FAST), minimum = minimumOfferWindows(bounds)
    expect(minimum).toEqual({ reviewSeconds: 120, disputeSeconds: 120, arbitrationSeconds: 300 })
    expect(() => validateOfferWindows(minimum, bounds)).not.toThrow()
    expect(() => validateOfferWindows(minimum)).toThrow('1 hour')
    expect(() => validateOfferWindows({ ...minimum, arbitrationSeconds: 299 }, bounds)).toThrow('5 minutes')
    expect(() => validateOfferWindows({ ...minimum, reviewSeconds: MAX_SIDEQUEST_WINDOW + 1 }, bounds)).toThrow('14 days')
    expect(standardOfferWindows(bounds)).toEqual({ reviewSeconds: 86400, disputeSeconds: 86400, arbitrationSeconds: 172800 })
    expect(standardOfferWindows({ ...bounds, review: { min: 100000, max: MAX_SIDEQUEST_WINDOW } }).reviewSeconds).toBe(100000)
  })
})

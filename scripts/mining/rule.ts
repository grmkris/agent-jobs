export const V2_RULE = {
  version: 2,
  payoutBps: 5000n,
  workerPercent: 60n,
  creatorPercent: 40n,
  boostBps: [4000n, 6000n, 8000n, 10000n],
  minBackerWeight: 100n * 10n ** 18n,
  minLeaf: 10n ** 18n,
  pegToleranceWei: 10n ** 16n,
} as const

export interface CreditRuleConfig {
  mining?: { creditRule?: { fromEpoch: string | number | bigint } }
}

const isNumber = (value: string | number | bigint): value is number => typeof value === 'number'

/** The cutover is explicit: an absent rule keeps all epochs on their published v1 computation. */
export function creditRuleOf(config: CreditRuleConfig, epoch: bigint) {
  const configured = config.mining?.creditRule?.fromEpoch
  if (configured === undefined) return { version: 1 } as const
  const text = String(configured)
  if (!/^[0-9]+$/.test(text) || (isNumber(configured) && !Number.isSafeInteger(configured)))
    throw new Error('credit rule fromEpoch must be a nonnegative integer')
  const fromEpoch = BigInt(text)
  return epoch < fromEpoch ? ({ version: 1 } as const) : { ...V2_RULE, fromEpoch }
}

import { expect, it } from 'vitest'
import { delegationCandidates, type StakeLedgerEvent } from './staking-ledger.ts'
import { positionIn } from './staking.ts'

const account = '0x1111111111111111111111111111111111111111'
const other = '0x2222222222222222222222222222222222222222'
const wallet = '0x3333333333333333333333333333333333333333'

it('VV2-003 retains the generation of a deposit preceding a reset in the same block, regardless of provider ordering', () => {
  const ledger: StakeLedgerEvent[] = [
    { name: 'PoolReset', account, generation: 1n, blockNumber: 100n, logIndex: 8 },
    { name: 'Delegated', account, delegator: wallet, blockNumber: 100n, logIndex: 2 },
    { name: 'Delegated', account: other, delegator: wallet, blockNumber: 99n, logIndex: 1 },
  ]
  const candidate = delegationCandidates(ledger, { account, delegator: wallet })[0]!
  expect(candidate.generation).toBe(0n)
  const pool = { assets: 0n, shares: 0n, queuedShares: 0n, reserved: 0n, generation: 1n }
  expect(positionIn(pool, { shares: 0n, queuedShares: 0n, generation: 1n, unlockAt: 0 }, candidate.generation).staleGeneration).toBe(true)
  expect(delegationCandidates([...ledger, { name: 'Delegated', account, delegator: wallet, blockNumber: 100n, logIndex: 9 }], { account })[0]?.generation).toBe(1n)
})

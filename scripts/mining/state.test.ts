import { expect, test } from 'bun:test'
import { MiningLedger, replayLedger, type LedgerRecord } from './ledger.ts'
import { ledgerFromState, parseState, stateHashOf, stateOf, type StateContext } from './state.ts'
import { dataHashOf } from './compute.ts'

const account = '0x0000000000000000000000000000000000000001'
const holding = '0x0000000000000000000000000000000000000002'
const other = '0x0000000000000000000000000000000000000003'
const tx = `0x${'ab'.repeat(32)}` as const
const context: StateContext = {
  chainId: 10143,
  epoch: 0n,
  block: 10n,
  blockHash: tx,
  genesisBlock: 1n,
  pruneBlock: 5n,
  contracts: {
    holdings: [holding],
    vault: other,
    identity: account,
    feeSchedule: other,
    reserve: other,
    distributor: other,
  },
}
const history = (): LedgerRecord[] => [
  {
    eventName: 'ScheduleExecuted',
    block: 1n,
    logIndex: 0,
    tx,
    thresholds: [0n, 10n, 100n, 1000n],
    bps: [3000n, 1000n, 300n, 100n],
    treasury: other,
  },
  { eventName: 'Delegated', block: 2n, logIndex: 0, account, delegator: other, assets: 20n, shares: 20n },
  {
    eventName: 'Activated',
    block: 3n,
    logIndex: 0,
    tx,
    holding,
    jobId: 1n,
    worker: account,
    agentId: 1n,
    feeBps: 1000n,
    fee: 10n,
    net: 90n,
    workerBond: 7n,
  },
  {
    eventName: 'ToppedUp',
    block: 4n,
    logIndex: 0,
    tx,
    holding,
    jobId: 1n,
    contributor: other,
    amount: 10n,
    bonus: 10n,
  },
  ...[2n, 4n, 5n, 8n].map((block): LedgerRecord => ({
    eventName: 'MetadataSet',
    block,
    logIndex: 1,
    tx,
    agentId: 1n,
    key: 'sidequest.backerShareBps',
    value: `0x${block.toString(16).padStart(64, '0')}`,
  })),
  { eventName: 'EpochFunded', block: 6n, logIndex: 0, epoch: 0n, amount: 2n },
  { eventName: 'EpochFunded', block: 7n, logIndex: 0, epoch: 0n, amount: 3n },
  {
    eventName: 'UndelegateRequested',
    block: 9n,
    logIndex: 0,
    account,
    delegator: other,
    assets: 2n,
    shares: 2n,
    queuedShares: 2n,
  },
]

test('canonical state stores decimal integers, lowercase hex, sorted arrays and aggregated funding', () => {
  const state = stateOf(replayLedger(history().toReversed()), context)
  expect(parseState(JSON.parse(JSON.stringify(state)))).toEqual(state)
  expect(state.activations[0]).toMatchObject({ workerBond: '7', rank: '1', logIndex: '0' })
  expect(state.vault.pools[0]?.queuedShares).toBe('2')
  expect(state.budget).toEqual({ funding: [{ epoch: '0', amount: '5' }], total: '5' })
  expect(stateHashOf(state)).toBe(dataHashOf(state))
})

test('restore continues a pool queue and keeps the original job and top-up history', () => {
  const state = stateOf(replayLedger(history()), context),
    ledger = ledgerFromState(parseState(state))
  expect(stateOf(ledger, context)).toEqual(state)
  ledger.apply({ eventName: 'Withdrawn', block: 11n, logIndex: 0, account, delegator: other, assets: 2n, shares: 2n })
  expect(ledger.stakeOf(account)).toBe(18n)
  expect(ledger.activationOf(holding, 1n)).toMatchObject({ fee: 10n, workerBond: 7n })
  expect(ledger.topUps).toHaveLength(1)
  expect(() => ledger.apply({ eventName: 'EpochFunded', block: 10n, logIndex: 3, epoch: 1n, amount: 1n })).toThrow(
    'chain order',
  )
})

test('settlement prunes only serialization and preserves activation for the later fee in the same transaction', () => {
  const ledger = replayLedger(history())
  ledger.apply({
    eventName: 'RewardSettled',
    block: 10n,
    logIndex: 0,
    tx,
    holding,
    jobId: 1n,
    to: account,
    outcome: 1,
    amount: 100n,
  })
  expect(ledger.activationOf(holding, 1n).fee).toBe(10n)
  expect(ledger.topUps).toHaveLength(1)
  const state = stateOf(ledger, context)
  expect(state.activations).toEqual([])
  expect(state.topUps).toEqual([])
  expect(state.wallets).toEqual([{ wallet: account, agentIds: ['1'] }])
})

test('share pruning retains the last set strictly before the next notice window and every later set', () => {
  const state = stateOf(replayLedger(history()), context)
  expect(state.shares.sets.map((set) => set.block)).toEqual(['4', '5', '8'])
  expect(stateOf(ledgerFromState(state), { ...context, pruneBlock: 9n }).shares.sets.map((set) => set.block)).toEqual([
    '8',
  ])
})

test('state removes retired generations and zero positions but keeps reset generations', () => {
  const ledger = replayLedger(history())
  ledger.apply({ eventName: 'Slashed', block: 10n, logIndex: 0, account, amount: 20n })
  ledger.apply({ eventName: 'PoolReset', block: 10n, logIndex: 1, account, generation: 1n })
  const state = stateOf(ledger, context)
  expect(state.vault.positions).toEqual([])
  expect(state.vault.pools[0]).toMatchObject({ shares: '0', generation: '1' })
  expect(ledgerFromState(state).positionOf(account, other).shares).toBe(0n)
})

test('noncanonical, unknown, unsafe and inconsistent state boundaries refuse', () => {
  const state = stateOf(replayLedger(history()), context)
  const invalid = [
    { ...state, extra: true },
    { ...state, epoch: 0 },
    { ...state, block: '01' },
    { ...state, blockHash: tx.toUpperCase() },
    { ...state, budget: { ...state.budget, total: '6' } },
    { ...state, vault: { ...state.vault, positions: [] } },
    { ...state, shares: { ...state.shares, sets: state.shares.sets.toReversed() } },
    { ...state, activations: state.activations.map((a) => ({ ...a, rank: '3' })) },
    { ...state, genesisBlock: '11' },
  ]
  for (const value of invalid) expect(() => parseState(value)).toThrow()
})

test('snapshot cloning isolates mutable pool and position state', () => {
  const ledger = replayLedger(history()),
    restored = MiningLedger.fromSnapshot(ledger.snapshot())
  restored.poolOf(account).assets = 1n
  restored.positionOf(account, other).queued = 0n
  expect(ledger.poolOf(account).assets).toBe(20n)
  expect(ledger.positionOf(account, other).queued).toBe(2n)
})

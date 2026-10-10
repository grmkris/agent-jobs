import { expect, test } from 'bun:test'
import { creditRuleOf, V2_RULE } from './rule.ts'
import epoch29 from './fixtures/testnet-epoch-29.json'
import { computeEpoch, dataHashOf, leafValues, type FeeCharged } from './compute.ts'
import { buildTree, type LeafValue } from './tree.ts'
import { parsePriceList } from './prices.ts'
import { getAddress, type Address, type Hex } from './viem.ts'

test('an absent cutover uses v1 forever', () => {
  for (const config of [{}, { mining: {} }]) expect(creditRuleOf(config, 1000000n)).toEqual({ version: 1 })
})

test('the configured epoch is the first v2 epoch, including epoch zero', () => {
  const config = { mining: { creditRule: { fromEpoch: '30' } } }
  expect(creditRuleOf(config, 29n)).toEqual({ version: 1 })
  expect(creditRuleOf(config, 30n)).toEqual({ ...V2_RULE, fromEpoch: 30n })
  expect(creditRuleOf({ mining: { creditRule: { fromEpoch: 0 } } }, 0n).version).toBe(2)
  expect(creditRuleOf({ mining: { creditRule: { fromEpoch: 30n } } }, 31n).version).toBe(2)
})

test('invalid cutover values refuse', () => {
  for (const fromEpoch of ['-1', '', '1.5', 1.5, Number.MAX_SAFE_INTEGER + 1])
    expect(() => creditRuleOf({ mining: { creditRule: { fromEpoch } } }, 100n)).toThrow('nonnegative integer')
})

// SAFETY: Fixture addresses are checked by getAddress before case normalization; hashes are validated bytes32.
const address = (value: string): Address => getAddress(value).toLowerCase() as Address
function hash(value: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error('fixture hash is not bytes32')
  // SAFETY: The bytes32 hex shape was validated immediately above.
  return value as Hex
}

test('vendored v1 epoch 29 retains its input hash, Merkle root and recomputed leaves', () => {
  expect(dataHashOf(epoch29.inputs)).toBe(epoch29.dataHash)
  const leaves: LeafValue[] = epoch29.tree.values.map(({ value }) => [
    value[0] ?? '',
    address(value[1] ?? ''),
    value[2] ?? '',
  ])
  expect(buildTree(leaves).tree[0]).toBe(epoch29.root)
  const fees: FeeCharged[] = epoch29.inputs.fees.map((fee) => ({
    ...fee,
    block: BigInt(fee.block),
    tx: hash(fee.tx),
    holding: address(fee.holding),
    jobId: BigInt(fee.jobId),
    token: address(fee.token),
    worker: address(fee.worker),
    creator: address(fee.creator),
    amount: BigInt(fee.amount),
    bonusPart: BigInt(fee.bonusPart),
  }))
  const positions = epoch29.inputs.backerPositions.map((position) => ({
    account: address(position.account),
    delegator: address(position.delegator),
    start: BigInt(position.start),
    end: BigInt(position.end),
    weight: BigInt(position.weight),
  }))
  const backerWorkers = epoch29.inputs.backerShares.map((share) => ({
    worker: address(share.worker),
    agentId: BigInt(share.agentId),
    bps: BigInt(share.bps),
    positions: positions.filter((position) => position.account === share.worker),
  }))
  const result = computeEpoch({
    fees,
    owed: [],
    withdrawals: [],
    prices: parsePriceList(epoch29.priceList),
    budget: BigInt(epoch29.inputs.budget.available),
    backerWorkers,
  })
  expect(result.feeUsd.toString()).toBe(epoch29.feeUsd)
  expect(result.demand.toString()).toBe(epoch29.demand)
  expect(result.emission.toString()).toBe(epoch29.emission)
  expect(result.total.toString()).toBe(epoch29.total)
  expect(buildTree(leafValues(29n, result.leaves))).toEqual(epoch29.tree)
})

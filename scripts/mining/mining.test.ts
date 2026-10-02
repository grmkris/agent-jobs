import { expect, test } from 'bun:test'
import { computeEpoch, dataHashOf, leafValues, treasuryOwed, type FeeCharged, type OwedWithdrawn, type PayoutOwed } from './compute.ts'
import { parsePriceList, priceListDomain, PRICE_LIST_TYPES, recoverPriceListSigner, typedMessage, type PriceList } from './prices.ts'
import { buildTree, leafHash, proofOf, verifyProof, type LeafValue } from './tree.ts'
import { privateKeyToAccount, type Address, type Hex } from './viem.ts'

// Run: bun test scripts/mining

const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address
const [A, B, C, D, E, TREASURY] = [a(0xa), a(0xb), a(0xc), a(0xd), a(0xe), a(0x7e)]
const HOLDING = a(0x401d)
const USDC = a(0x05dc)
const UNPRICED = a(0xbad)
const usd = (n: number) => BigInt(n) * 10n ** 18n
const factory = (n: number) => BigInt(n) * 10n ** 18n

const prices: PriceList = {
  epoch: 3n,
  tokens: [{ token: USDC, decimals: 6, usdPrice: usd(1) }],
  factoryUsdPrice: 2n * 10n ** 14n, // $0.0002
}

let position = 0
const at = (tx: number) => ({ block: BigInt(100 + tx), logIndex: position++, tx: `0x${tx.toString(16).padStart(64, '0')}` as Hex, holding: HOLDING })
const fee = (tx: number, jobId: number, token: Address, worker: Address, creator: Address, dollars: number): FeeCharged =>
  ({ ...at(tx), jobId: BigInt(jobId), token, worker, creator, amount: BigInt(dollars * 1_000_000) })
const owedTo = (f: FeeCharged, to: Address): PayoutOwed => ({ ...at(Number(BigInt(f.tx))), jobId: f.jobId, to, token: f.token, amount: f.amount })
const withdrawn = (tx: number, to: Address, token: Address): OwedWithdrawn => ({ ...at(tx), to, token, amount: 1n })

test('one leaf per account: a worker who is also a creator gets both parts', () => {
  const f1 = fee(1, 1, USDC, A, B, 3)
  const f2 = fee(2, 2, UNPRICED, A, C, 1000) // unpriced: ignored
  const f3 = fee(3, 3, USDC, C, A, 1) // A is the creator here
  const f5 = fee(4, 5, USDC, D, B, 1) // refused, then withdrawn later in the window
  const o5 = owedTo(f5, TREASURY)
  const w5 = withdrawn(5, TREASURY, USDC) // withdraw takes the whole owed balance, so it clears every earlier one
  const f4 = fee(6, 4, USDC, D, B, 2) // refused after that withdrawal, and never withdrawn
  const o4 = owedTo(f4, TREASURY)
  const f6 = fee(7, 6, USDC, E, C, 1) // only the worker's transfer was refused: the treasury holds the fee
  const o6 = owedTo(f6, E)
  const r = computeEpoch({ fees: [f1, f2, f3, f4, f5, f6], owed: [o4, o5, o6], withdrawals: [w5], prices, budget: factory(10_000_000) })

  expect(r.fees.map(x => x.status)).toEqual(['counted', 'unpriced', 'counted', 'owed-to-treasury', 'counted', 'counted'])
  expect(r.feeUsd).toBe(usd(6))
  expect(r.demand).toBe(factory(15_000)) // 0.5 × $6 ÷ $0.0002
  expect(r.emission).toBe(factory(15_000))
  // Workers share 9000 by fee USD (A 3, C 1, D 1, E 1); creators 6000 (B 4, A 1, C 1).
  expect(r.leaves).toEqual([
    { account: A, amount: factory(4_500 + 1_000) },
    { account: B, amount: factory(4_000) },
    { account: C, amount: factory(1_500 + 1_000) },
    { account: D, amount: factory(1_500) },
    { account: E, amount: factory(1_500) },
  ])
  expect(r.total).toBe(factory(15_000))
})

test('the budget caps the emission, and every part rounds down: total is the sum of the leaves', () => {
  const fees = [fee(11, 11, USDC, A, D, 1), fee(12, 12, USDC, B, E, 1), fee(13, 13, USDC, C, TREASURY, 1)]
  const r = computeEpoch({ fees, owed: [], withdrawals: [], prices, budget: 10n })
  expect(r.demand).toBe(factory(7_500))
  expect(r.emission).toBe(10n)
  // Pools 6 and 4 wei, a third each: 2 per worker, 1 per creator.
  expect(r.leaves.map(l => l.amount)).toEqual([2n, 2n, 2n, 1n, 1n, 1n])
  expect(r.total).toBe(9n)
})

test('the FACTORY reference price never counts below $0.0001', () => {
  const r = computeEpoch({ fees: [fee(21, 21, USDC, A, B, 1)], owed: [], withdrawals: [], prices: { ...prices, factoryUsdPrice: 10n ** 13n }, budget: factory(10_000_000) })
  expect(r.factoryUsdPrice).toBe(10n ** 14n)
  expect(r.emission).toBe(factory(5_000))
})

test('no counted fee: no emission, no leaves', () => {
  const r = computeEpoch({ fees: [fee(31, 31, UNPRICED, A, B, 5)], owed: [], withdrawals: [], prices, budget: factory(1) })
  expect(r.emission).toBe(0n)
  expect(r.leaves).toEqual([])
  expect(r.total).toBe(0n)
})

test('the treasury owed entry is the last PayoutOwed after the fee in its transaction', () => {
  const f = fee(41, 41, USDC, A, B, 2)
  const worker = owedTo(f, A)
  const treasury = owedTo(f, TREASURY)
  expect(treasuryOwed(f, [worker])).toBeUndefined()
  expect(treasuryOwed(f, [treasury])).toEqual(treasury)
  expect(treasuryOwed(f, [worker, treasury])).toEqual(treasury)
  // A worker that is the treasury: both refused, the second is the treasury's.
  const f2 = fee(42, 42, USDC, TREASURY, B, 2)
  const first = owedTo(f2, TREASURY)
  const second = owedTo(f2, TREASURY)
  expect(treasuryOwed(f2, [first, second])).toEqual(second)
  // Another job, another transaction, or a log before the fee does not count.
  expect(treasuryOwed(f, [{ ...treasury, jobId: 99n }])).toBeUndefined()
  expect(treasuryOwed(f, [{ ...treasury, tx: f2.tx }])).toBeUndefined()
  expect(treasuryOwed(f, [{ ...treasury, logIndex: f.logIndex - 1, block: f.block }])).toBeUndefined()
})

test('a withdrawal before the refused transfer does not clear it', () => {
  const early = withdrawn(50, TREASURY, USDC)
  const f = fee(51, 51, USDC, A, B, 1)
  const r = computeEpoch({ fees: [f], owed: [owedTo(f, TREASURY)], withdrawals: [early], prices, budget: factory(1_000_000) })
  expect(r.fees[0]!.status).toBe('owed-to-treasury')
})

// Roots computed by @openzeppelin/merkle-tree 1.0.8's StandardMerkleTree.of on these values (2 Oct; dump, proofs and
// load were byte-identical to buildTree's).
const ozVectors: [LeafValue[], Hex][] = [
  [[['0', a(1), '1000000000000000000']], '0xa07c47999914533524b061ea33d8d650b5c240ce14f38b2868b31bc63fb252ee'],
  [[['0', a(1), '5'], ['0', a(2), '7']], '0xfb8f274a9836bd4aa448e0de30906f4afb7e67fdb24965e7df7228efe3e053ec'],
  [[['3', a(0xabc), '123456789012345678901234'], ['3', a(0xdef), '1'], ['3', '0x70997970c51812dc3a010c7d01b50e0d17dc79c8', '999']],
    '0x714ac225a3ca222e24b7b27574c3b758d3f405c6222deedc5634831ab5826ad5'],
  [[1, 2, 3, 4, 5].map(i => ['7', a(i * 0x1111), String(i * 1000)] as LeafValue), '0x50b919fc4ac7c5f8ac9246f679c06308ac76ffe88c67739869ce0a89e86af1da'],
]

test('the tree matches OpenZeppelin StandardMerkleTree, and every proof verifies', () => {
  for (const [values, root] of ozVectors) {
    const dump = buildTree(values)
    expect(dump.tree[0]).toBe(root)
    expect(dump.format).toBe('standard-v1')
    values.forEach((v, i) => expect(verifyProof(root, leafHash(v), proofOf(dump, i))).toBe(true))
  }
  expect(() => buildTree([])).toThrow()
})

test('epoch leaves become tree values (epoch, account, amount)', () => {
  expect(leafValues(3n, [{ account: A, amount: 5n }])).toEqual([['3', A, '5']])
})

test('dataHash is the keccak of the inputs JSON and moves with any input', () => {
  const inputs = { chainId: 10143, epoch: '3', fees: [{ jobId: '1', amount: '5' }] }
  expect(dataHashOf(inputs)).toBe(dataHashOf(JSON.parse(JSON.stringify(inputs))))
  expect(dataHashOf({ ...inputs, epoch: '4' })).not.toBe(dataHashOf(inputs))
})

const OWNER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const // anvil dev key 1
const DISTRIBUTOR = a(0xd157)

test('a signed price list recovers its signer for this chain and distributor only', async () => {
  const owner = privateKeyToAccount(OWNER_KEY)
  const signature = await owner.signTypedData({ domain: priceListDomain(10143, DISTRIBUTOR), types: PRICE_LIST_TYPES, primaryType: 'PriceList', message: typedMessage(prices) })
  expect(await recoverPriceListSigner(prices, signature, 10143, DISTRIBUTOR)).toBe(owner.address.toLowerCase() as Address)
  expect(await recoverPriceListSigner({ ...prices, factoryUsdPrice: 1n }, signature, 10143, DISTRIBUTOR)).not.toBe(owner.address.toLowerCase() as Address)
  expect(await recoverPriceListSigner(prices, signature, 143, DISTRIBUTOR)).not.toBe(owner.address.toLowerCase() as Address)
  expect(await recoverPriceListSigner(prices, signature, 10143, a(1))).not.toBe(owner.address.toLowerCase() as Address)
})

test('the price list file refuses duplicates, zero prices and bad decimals', () => {
  const ok = { message: { epoch: '3', tokens: [{ token: USDC, decimals: 6, usdPrice: '1000000000000000000' }], factoryUsdPrice: '100000000000000' } }
  expect(parsePriceList(ok).tokens[0]!.usdPrice).toBe(usd(1))
  expect(() => parsePriceList({ message: { ...ok.message, tokens: [...ok.message.tokens, ...ok.message.tokens] } })).toThrow('twice')
  expect(() => parsePriceList({ message: { ...ok.message, tokens: [{ ...ok.message.tokens[0]!, usdPrice: '0' }] } })).toThrow('no price')
  expect(() => parsePriceList({ message: { ...ok.message, tokens: [{ ...ok.message.tokens[0]!, decimals: 40 }] } })).toThrow('decimals')
  expect(() => parsePriceList({ message: { ...ok.message, factoryUsdPrice: '1.5' } })).toThrow('decimal string')
})

// Adapted from 714b45b^: deterministic manifests and fail-closed refund ownership.
import { createHash } from 'node:crypto'
import { decodeEventLog, getAddress, parseAbi } from 'viem'
import { refundIdentity } from './refund-generation.mjs'

export const KRIS = '0xB9970A6371358F6C74DFb15A7cB2653E3AE3E471'
// Frozen deployed pre-G1d/G1d share-vault ABI, independent of the regenerated target ABI.
export const oldVaultAbi = parseAbi([
  'event Delegated(address indexed account,address indexed delegator,address indexed payer,uint256 assets,uint256 shares)',
  'event UndelegateRequested(address indexed account,address indexed delegator,uint256 shares,uint256 assets,uint256 queuedShares,uint48 unlockAt)',
  'event UndelegateCancelled(address indexed account,address indexed delegator,uint256 shares,uint256 assets)',
  'event Withdrawn(address indexed account,address indexed delegator,uint256 shares,uint256 assets)',
  'event PoolReset(address indexed account,uint64 generation)',
  'event Slashed(address indexed holding,address indexed account,uint256 amount)',
  'event Reserved(address indexed holding,address indexed account,uint256 amount)',
  'event Released(address indexed holding,address indexed account,uint256 amount)',
  'event HoldingProposed(address indexed holding,uint48 eta)',
  'event HoldingProposalCancelled(address indexed holding)',
  'event HoldingAuthorized(address indexed holding,bool bootstrap)',
  'event HoldingRevoked(address indexed holding)',
  'event HoldingDeniedSet(address indexed account,address indexed holding,bool denied)',
  'event OwnershipTransferStarted(address indexed previousOwner,address indexed newOwner)',
  'event OwnershipTransferred(address indexed previousOwner,address indexed newOwner)',
  'function poolOf(address) view returns ((uint128 assets,uint128 reserved,uint256 shares,uint192 queuedShares,uint64 generation))',
  'function positionOf(address,address) view returns ((uint256 shares,uint192 queuedShares,uint48 unlockAt,uint64 generation))',
  'function convertToAssets(address,uint256) view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function factory() view returns (address)',
])

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (Object.prototype.toString.call(value) === '[object Object]') return `{${Object.keys(value).toSorted().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
export const checksum = value => createHash('sha256').update(canonical(value)).digest('hex')
export const address = value => getAddress(value.toLowerCase())
export const logKey = log => `${log.block_number}:${log.log_index}`

export function decodeVaultLogs(logs) {
  const seen = new Set()
  return logs.toSorted((a, b) => a.block_number - b.block_number || a.log_index - b.log_index).flatMap(log => {
    const key = logKey(log)
    if (seen.has(key)) throw new Error(`refund: duplicate vault log ${key}`)
    seen.add(key)
    let decoded
    try { decoded = decodeEventLog({ abi: oldVaultAbi, data: log.data, topics: [log.topic0, log.topic1, log.topic2, log.topic3].filter(Boolean), strict: true }) }
    catch { throw new Error(`refund: unsupported or malformed vault log ${key}`) }
    return [{ ...log, ...decoded }]
  })
}

export function positionCandidates(logs) {
  const candidates = new Map()
  for (const event of decodeVaultLogs(logs)) {
    if (event.eventName !== 'Delegated') continue
    const account = address(event.args.account), delegator = address(event.args.delegator)
    candidates.set(`${account}:${delegator}`, { account, delegator })
  }
  return [...candidates.values()].toSorted((a, b) => a.account.localeCompare(b.account) || a.delegator.localeCompare(b.delegator))
}

const uint = value => {
  if (!/^(0|[1-9][0-9]*)$/u.test(String(value))) throw new Error('refund: invalid unsigned value')
  return BigInt(value)
}

function valuePosition({ position, account, pool, known, seen }) {
  const delegator = address(position.delegator), key = `${account}:${delegator}`
  if (!known.has(key) || seen.has(key)) throw new Error('refund: unproven or duplicate position')
  seen.add(key)
  const held = uint(position.shares), queue = uint(position.queuedShares)
  if (queue > held || uint(position.generation) !== uint(pool.generation)) throw new Error('refund: position generation/queue mismatch')
  const assets = uint(pool.assets), shares = uint(pool.shares)
  const amount = shares === 0n ? 0n : held * assets / shares
  if (amount !== uint(position.assets)) throw new Error('refund: position asset quote mismatch')
  if (amount === 0n) return { held, queue, position: null }
  const queuedAssets = queue * assets / shares
  return { held, queue, position: { account, delegator, amount: amount.toString(), active: (amount - queuedAssets).toString(), unstaking: queuedAssets.toString(), shares: held.toString(), queuedShares: queue.toString(), generation: String(position.generation), unlockAt: Number(position.unlockAt) } }
}

function valuePool(row, known, seen) {
  const account = address(row.account), pool = row.pool
  const assets = uint(pool.assets), shares = uint(pool.shares), queued = uint(pool.queuedShares)
  if (queued > shares || uint(pool.reserved) > assets) throw new Error('refund: invalid pool readback')
  const valued = row.positions.map(position => valuePosition({ position, account, pool, known, seen }))
  const counted = valued.reduce((n, value) => n + value.held, 0n)
  const queuedCount = valued.reduce((n, value) => n + value.queue, 0n)
  if (counted !== shares || queuedCount !== queued) throw new Error('refund: pool shares do not reconcile')
  return { assets, positions: valued.flatMap(value => value.position === null ? [] : [value.position]) }
}

export function positionsFromSnapshot(snapshot) {
  const candidates = positionCandidates(snapshot.vaultLogs)
  const known = new Set(candidates.map(row => `${row.account}:${row.delegator}`)), seen = new Set()
  const pools = snapshot.accounts.map(row => valuePool(row, known, seen))
  const totalAssets = pools.reduce((n, pool) => n + pool.assets, 0n)
  if (known.size !== seen.size || totalAssets !== uint(snapshot.totalAssets)) throw new Error('refund: global vault totals do not reconcile')
  return pools.flatMap(pool => pool.positions).toSorted((a, b) => a.account.localeCompare(b.account) || a.delegator.localeCompare(b.delegator))
}

export function makeManifest(snapshot, { generation = 'g1d', source = `pre-${generation}` } = {}) {
  refundIdentity(generation, source)
  if (snapshot.chainId !== 10143 || !Number.isSafeInteger(snapshot.block) || snapshot.block < snapshot.old.block) throw new Error('refund: snapshot identity mismatch')
  const positions = positionsFromSnapshot(snapshot)
  if (snapshot.looseBalances.length !== 1 || address(snapshot.looseBalances[0].wallet) !== KRIS) throw new Error('refund: loose balance must be Kris only')
  const transfers = snapshot.looseBalances.filter(row => uint(row.amount) > 0n).map(row => ({ wallet: address(row.wallet), amount: uint(row.amount).toString(), sources: row.sources }))
  const positionAssets = positions.reduce((n, row) => n + BigInt(row.amount), 0n)
  const body = { schemaVersion: 2, chainId: 10143, from: source, to: generation, snapshot: { block: snapshot.block, blockHash: snapshot.blockHash, timestamp: snapshot.timestamp, checksum: checksum(snapshot) }, old: snapshot.old, positions, transfers, excluded: snapshot.excluded,
    totals: { positions: positionAssets.toString(), transfers: transfers.reduce((n, row) => n + BigInt(row.amount), 0n).toString(), roundingDust: (uint(snapshot.totalAssets) - positionAssets).toString() } }
  return { ...body, checksum: checksum(body) }
}

export function validateManifest(manifest, { generation = manifest.to, source = manifest.from } = {}) {
  refundIdentity(generation, source)
  const { checksum: digest, ...body } = manifest
  if (manifest.schemaVersion !== 2 || manifest.chainId !== 10143 || manifest.from !== source || manifest.to !== generation || checksum(body) !== digest) throw new Error('refund: manifest identity/checksum mismatch')
  const keys = new Set()
  for (const row of manifest.positions) {
    const key = `${address(row.account)}:${address(row.delegator)}`
    if (keys.has(key) || uint(row.amount) === 0n || uint(row.active) + uint(row.unstaking) !== uint(row.amount)) throw new Error('refund: invalid or duplicate position')
    keys.add(key)
  }
  if (manifest.transfers.length > 1 || manifest.transfers.some(row => address(row.wallet) !== KRIS || uint(row.amount) === 0n)) throw new Error('refund: invalid loose transfer')
  if (manifest.positions.reduce((n, row) => n + uint(row.amount), 0n) !== uint(manifest.totals.positions) || manifest.transfers.reduce((n, row) => n + uint(row.amount), 0n) !== uint(manifest.totals.transfers)) throw new Error('refund: manifest totals mismatch')
  return manifest
}

import { createHash } from 'node:crypto'
import { decodeEventLog, getAddress, parseAbi } from 'viem'

// Frozen G1b ABI. This must remain independent of the new vault's generated ABI.
export const oldVaultAbi = parseAbi([
  'event Staked(address indexed account, address indexed payer, uint256 amount)',
  'event UnstakeRequested(address indexed account, uint256 amount, uint256 totalUnstaking, uint48 unlockAt)',
  'event UnstakeCancelled(address indexed account, uint256 amount)',
  'event Withdrawn(address indexed account, uint256 amount)',
  'event Slashed(address indexed holding, address indexed account, uint256 amount)',
  'function stakeOf(address) view returns (uint256)',
  'function unstakeOf(address) view returns (uint256 amount, uint48 unlockAt)',
  'function totalStaked() view returns (uint256)',
  'function totalUnstaking() view returns (uint256)',
])

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).toSorted().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
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
    try {
      decoded = decodeEventLog({ abi: oldVaultAbi, data: log.data, topics: [log.topic0, log.topic1, log.topic2, log.topic3].filter(Boolean), strict: true })
    } catch {
      // The frozen vault also emits reservation/ownership events with no effect on refund ownership.
      return []
    }
    return [{ ...log, ...decoded }]
  })
}

function subtract(pool, field, amount, key) {
  const positive = [...pool.values()].filter(position => position[field] > 0n)
  if (positive.length !== 1) throw new Error(`refund: ambiguous ${field} debit at ${key}; ownership decision required`)
  if (positive[0][field] < amount) throw new Error(`refund: ledger underflow at ${key}`)
  positive[0][field] -= amount
  return positive[0]
}

export function depositOwner(event, proof, distributor) {
  const account = address(event.args.account)
  const payer = address(event.args.payer)
  if (proof && (address(proof.wallet) !== account || proof.block !== event.block_number)) {
    throw new Error(`refund: invalid operator proof at ${logKey(event)}`)
  }
  return proof && payer !== account && payer !== address(distributor) && address(proof.owner) === payer ? payer : account
}

export function positionsFromSnapshot(snapshot) {
  const pools = new Map()
  for (const event of decodeVaultLogs(snapshot.vaultLogs)) {
    const account = address(event.args.account)
    let pool = pools.get(account)
    if (!pool) {
      pool = new Map()
      pools.set(account, pool)
    }
    const amount = BigInt(event.args.amount)
    const key = logKey(event)
    if (event.eventName === 'Staked') {
      const payer = address(event.args.payer)
      const proof = snapshot.operatorProofs[key]
      const owner = depositOwner(event, proof, snapshot.old.distributor)
      const operatorFunded = owner !== account
      let position = pool.get(owner)
      if (!position) {
        position = { account, owner, active: 0n, queued: 0n, deposits: [] }
        pool.set(owner, position)
      }
      position.active += amount
      position.deposits.push({ block: event.block_number, logIndex: event.log_index, transactionHash: event.transaction_hash,
        payer, amount: amount.toString(), rule: operatorFunded ? 'registry-operator' : 'account', ...(proof ? { agentId: proof.agentId } : {}) })
    } else if (event.eventName === 'UnstakeRequested') {
      subtract(pool, 'active', amount, key).queued += amount
      const queued = [...pool.values()].reduce((n, position) => n + position.queued, 0n)
      if (queued !== event.args.totalUnstaking) throw new Error(`refund: queued ledger mismatch at ${key}`)
    } else if (event.eventName === 'UnstakeCancelled') {
      subtract(pool, 'queued', amount, key).active += amount
    } else if (event.eventName === 'Withdrawn') {
      subtract(pool, 'queued', amount, key)
    } else if (event.eventName === 'Slashed') {
      subtract(pool, 'active', amount, key)
    }
  }
  const positions = []
  for (const [account, pool] of pools) {
    const observed = snapshot.accounts.find(row => address(row.account) === account)
    if (!observed) throw new Error(`refund: missing chain read for ${account}`)
    const active = [...pool.values()].reduce((n, p) => n + p.active, 0n)
    const queued = [...pool.values()].reduce((n, p) => n + p.queued, 0n)
    if (active !== BigInt(observed.stake) || queued !== BigInt(observed.unstaking)) {
      throw new Error(`refund: replay does not reconcile for ${account}`)
    }
    for (const position of pool.values()) {
      if (position.active + position.queued === 0n) continue
      positions.push({ account, owner: position.owner, amount: (position.active + position.queued).toString(),
        active: position.active.toString(), unstaking: position.queued.toString(), deposits: position.deposits })
    }
  }
  if (snapshot.accounts.some(row => !pools.has(address(row.account)))) throw new Error('refund: unproven account')
  const active = snapshot.accounts.reduce((n, row) => n + BigInt(row.stake), 0n)
  const queued = snapshot.accounts.reduce((n, row) => n + BigInt(row.unstaking), 0n)
  if (active !== BigInt(snapshot.totalStaked) || queued !== BigInt(snapshot.totalUnstaking)) {
    throw new Error('refund: global stake totals do not reconcile')
  }
  return positions.toSorted((a, b) => a.account.toLowerCase().localeCompare(b.account.toLowerCase()) || a.owner.toLowerCase().localeCompare(b.owner.toLowerCase()))
}

export function makeManifest(snapshot) {
  const positions = positionsFromSnapshot(snapshot)
  const transfers = snapshot.looseBalances.filter(row => BigInt(row.amount) > 0n)
    .map(row => ({ wallet: address(row.wallet), amount: BigInt(row.amount).toString(), sources: row.sources }))
    .toSorted((a, b) => a.wallet.toLowerCase().localeCompare(b.wallet.toLowerCase()))
  if (new Set(transfers.map(row => row.wallet)).size !== transfers.length) throw new Error('refund: duplicate loose balance')
  const body = { schemaVersion: 1, chainId: 10143, from: 'g1b', to: 'g1c', snapshot: {
    block: snapshot.block, blockHash: snapshot.blockHash, timestamp: snapshot.timestamp, checksum: checksum(snapshot),
  }, old: snapshot.old, positions, transfers, excluded: snapshot.excluded,
  totals: { positions: positions.reduce((n, row) => n + BigInt(row.amount), 0n).toString(),
    transfers: transfers.reduce((n, row) => n + BigInt(row.amount), 0n).toString() } }
  return { ...body, checksum: checksum(body) }
}

export function validateManifest(manifest) {
  const { checksum: digest, ...body } = manifest
  if (manifest.schemaVersion !== 1 || manifest.chainId !== 10143 || manifest.from !== 'g1b' || manifest.to !== 'g1c'
    || checksum(body) !== digest) throw new Error('refund: manifest identity/checksum mismatch')
  const keys = new Set()
  for (const row of manifest.positions) {
    const key = `${address(row.account)}:${address(row.owner)}`
    if (keys.has(key) || !/^[1-9]\d*$/.test(row.amount) || BigInt(row.active) + BigInt(row.unstaking) !== BigInt(row.amount)) {
      throw new Error('refund: invalid or duplicate position')
    }
    keys.add(key)
  }
  keys.clear()
  for (const row of manifest.transfers) {
    const key = address(row.wallet)
    if (keys.has(key) || !/^[1-9]\d*$/.test(row.amount)) throw new Error('refund: invalid or duplicate transfer')
    keys.add(key)
  }
  return manifest
}

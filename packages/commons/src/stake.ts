import { parseUnits } from 'viem'
import { Clock, Effect, Ref, Schema } from 'effect'
import { Unavailable } from './errors.ts'
import { Address, WeiString } from './schema/ids.ts'
import { Caches, CommonsSql, StakeReader, type StakePosition } from './services.ts'

export const POST_MINIMUM = parseUnits('10', 18)
export const PROPOSE_MINIMUM = parseUnits('100', 18)
const Positions = Schema.Array(Schema.Struct({ account: Address, value: WeiString }))
interface CachedRow {
  stake: string
  stake_block: string
  backing_total: string
  backs_json: string
  backing_block: string
  read_at: number
}
function cachedPosition(row: CachedRow): StakePosition {
  const positions = Schema.decodeUnknownSync(Schema.fromJsonString(Positions))(row.backs_json).map((p) => ({
    account: p.account,
    value: BigInt(p.value),
  }))
  return {
    stake: BigInt(row.stake),
    stakeBlock: BigInt(row.stake_block),
    backing: { total: BigInt(row.backing_total), block: BigInt(row.backing_block), positions },
  }
}
const freshPosition = Effect.fnUntraced(function* (address: Address) {
  const reader = yield* StakeReader
  const stakes = yield* reader.stakes([address]).pipe(Effect.catch(() => Effect.succeed(null)))
  const own = stakes?.stake.get(address)
  const backing = yield* reader.backing(address).pipe(Effect.catch(() => Effect.succeed(null)))
  const complete = stakes !== null && own !== undefined && backing !== null
  const knownStake = own ?? 0n
  const knownBacking = backing?.total ?? 0n
  if (!complete && knownStake < POST_MINIMUM && knownBacking < POST_MINIMUM)
    return yield* new Unavailable({ message: 'Unable to establish stake or backing authority' })
  const value: StakePosition = {
    stake: knownStake,
    stakeBlock: stakes?.block ?? 0n,
    backing: backing ?? { block: 0n, total: 0n, positions: [] },
  }
  return { complete, value }
})
function persistPosition(sql: CommonsSql['Service'], address: Address, value: StakePosition, now: number): void {
  sql.run(
    `INSERT INTO commons_stake_cache VALUES(?,?,?,?,?,?,?) ON CONFLICT(address) DO UPDATE SET
    stake=excluded.stake,stake_block=excluded.stake_block,backing_total=excluded.backing_total,
    backs_json=excluded.backs_json,backing_block=excluded.backing_block,read_at=excluded.read_at`,
    address,
    value.stake.toString(),
    value.stakeBlock.toString(),
    value.backing.total.toString(),
    JSON.stringify(value.backing.positions.map((p) => ({ account: p.account, value: p.value.toString() }))),
    value.backing.block.toString(),
    now,
  )
}
export const readStake = Effect.fnUntraced(function* (address: Address) {
  const caches = yield* Caches
  const sql = yield* CommonsSql
  const now = yield* Clock.currentTimeMillis
  const cached = (yield* Ref.get(caches.stake)).get(address)
  if (cached !== undefined && cached.expiresAt > now) return cached.value
  const row = sql.all<CachedRow>(
    'SELECT * FROM commons_stake_cache WHERE address=? AND read_at>?',
    address,
    now - 60_000,
  )[0]
  if (row !== undefined) {
    const value = cachedPosition(row)
    yield* Ref.update(caches.stake, (map) => new Map(map).set(address, { expiresAt: row.read_at + 60_000, value }))
    return value
  }
  const { complete, value } = yield* freshPosition(address)
  if (!complete) return value
  persistPosition(sql, address, value, now)
  yield* Ref.update(caches.stake, (map) => new Map(map).set(address, { expiresAt: now + 60_000, value }))
  return value
})
export const ownStake = Effect.fnUntraced(function* (address: Address) {
  const reader = yield* StakeReader
  const snapshot = yield* reader.stakes([address])
  const stake = snapshot.stake.get(address)
  if (stake === undefined) return yield* new Unavailable({ message: 'Stake reader omitted requested account' })
  return { stake, block: snapshot.block }
})

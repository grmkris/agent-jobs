import { Clock, Effect, Ref, Schema } from 'effect'
import { Unavailable } from './errors.ts'
import { Address, WeiString } from './schema/ids.ts'
import { Caches, CommonsSql, StakeReader, type StakePosition } from './services.ts'

export const POST_MINIMUM = 10n * 10n ** 18n
export const PROPOSE_MINIMUM = 100n * 10n ** 18n
const Positions = Schema.Array(Schema.Struct({ account: Address, value: WeiString }))
interface CachedRow {
  stake: string
  stake_block: string
  backing_total: string
  backs_json: string
  backing_block: string
  read_at: number
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
    const positions = Schema.decodeUnknownSync(Schema.fromJsonString(Positions))(row.backs_json).map((p) => ({
      account: p.account,
      value: BigInt(p.value),
    }))
    const value = {
      stake: BigInt(row.stake),
      stakeBlock: BigInt(row.stake_block),
      backing: { total: BigInt(row.backing_total), block: BigInt(row.backing_block), positions },
    }
    yield* Ref.update(caches.stake, (map) => new Map(map).set(address, { expiresAt: row.read_at + 60_000, value }))
    return value
  }
  const reader = yield* StakeReader
  const stakes = yield* reader.stakes([address]).pipe(Effect.catch(() => Effect.succeed(null)))
  const own = stakes?.stake.get(address)
  const backing = yield* reader.backing(address).pipe(Effect.catch(() => Effect.succeed(null)))
  const knownStake = own ?? 0n
  const knownBacking = backing?.total ?? 0n
  if ((own === undefined || backing === null) && knownStake < POST_MINIMUM && knownBacking < POST_MINIMUM)
    return yield* new Unavailable({ message: 'Unable to establish stake or backing authority' })
  const value: StakePosition = {
    stake: knownStake,
    stakeBlock: stakes?.block ?? 0n,
    backing: backing ?? { block: 0n, total: 0n, positions: [] },
  }
  if (stakes === null || own === undefined || backing === null) return value
  sql.run(
    `INSERT INTO commons_stake_cache VALUES(?,?,?,?,?,?,?) ON CONFLICT(address) DO UPDATE SET
    stake=excluded.stake,stake_block=excluded.stake_block,backing_total=excluded.backing_total,
    backs_json=excluded.backs_json,backing_block=excluded.backing_block,read_at=excluded.read_at`,
    address,
    own.toString(),
    stakes.block.toString(),
    backing.total.toString(),
    JSON.stringify(backing.positions.map((p) => ({ account: p.account, value: p.value.toString() }))),
    backing.block.toString(),
    now,
  )
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

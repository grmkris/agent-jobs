import { Effect, Layer } from 'effect'
import {
  Caches,
  Directory,
  FeedSink,
  Participants,
  RolesConfig,
  StakeReader,
  type FeedEvent,
  type ParticipantsSnapshot,
} from '../src/services.ts'
import { sqlLayer } from '../src/sql/sync.ts'
import { migrate } from '../src/sql/schema.ts'
import { Unavailable } from '../src/errors.ts'
import { testSql } from './sql.ts'

export const alice = `0x${'a'.repeat(40)}`
export const bob = `0x${'b'.repeat(40)}`
export const moderator = `0x${'c'.repeat(40)}`
export const maintainer = `0x${'d'.repeat(40)}`
export const arbiter = `0x${'e'.repeat(40)}`
export const makeHarness = Effect.fnUntraced(function* () {
  const { sql, transaction } = yield* testSql()
  migrate(sql, maintainer)
  const events: FeedEvent[] = []
  const state = {
    stakes: new Map<string, bigint>(),
    backing: new Map<string, readonly { account: string; value: bigint }[]>(),
    people: new Map<string, ParticipantsSnapshot>(),
    directory: new Map<string, string>(),
    stakeCalls: new Array<string[]>(),
    backingCalls: 0,
    participantCalls: 0,
    block: 42n,
    failStake: false,
    failBacking: false,
    enabled: true,
  }
  const stakeReader: StakeReader['Service'] = {
    stakes: (addresses) =>
      Effect.suspend(() => {
        state.stakeCalls.push([...addresses])
        return state.failStake
          ? Effect.fail(new Unavailable({ message: 'RPC unavailable' }))
          : Effect.succeed({ block: state.block, stake: new Map(addresses.map((a) => [a, state.stakes.get(a) ?? 0n])) })
      }),
    backing: (address) =>
      Effect.suspend(() => {
        state.backingCalls++
        const positions = state.backing.get(address) ?? []
        return state.failBacking
          ? Effect.fail(new Unavailable({ message: 'RPC unavailable' }))
          : Effect.succeed({ block: state.block, total: positions.reduce((sum, p) => sum + p.value, 0n), positions })
      }),
  }
  const config: RolesConfig['Service'] = {
    get enabled() {
      return state.enabled
    },
    moderator: [moderator],
    maintainer: [maintainer],
    arbiter: [arbiter],
  }
  const layer = Layer.mergeAll(
    sqlLayer(sql, transaction),
    Caches.layer,
    Layer.succeed(StakeReader, stakeReader),
    Layer.succeed(RolesConfig, config),
    Layer.succeed(FeedSink, {
      write: (rows) =>
        Effect.sync(() => {
          events.push(...rows)
        }),
    }),
    Layer.succeed(Directory, {
      resolve: (tokens) =>
        Effect.succeed(tokens.map((token) => ({ token, address: state.directory.get(token.toLowerCase()) ?? null }))),
    }),
    Layer.succeed(Participants, {
      of: (board, task) =>
        Effect.sync(() => {
          state.participantCalls++
          return state.people.get(`job:${board}:${task}`) ?? null
        }),
    }),
  )
  return { sql, state, events, layer }
})

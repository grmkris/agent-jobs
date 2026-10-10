import { Context, Effect, Layer, Ref } from 'effect'
import type { Unavailable } from './errors.ts'
import type { Address } from './schema/ids.ts'
import type { SyncSql } from './sql/sync.ts'

export interface StakeSnapshot {
  readonly block: bigint
  readonly stake: ReadonlyMap<Address, bigint>
}
export interface BackingSnapshot {
  readonly block: bigint
  readonly total: bigint
  readonly positions: readonly { account: Address; value: bigint }[]
}
export interface ParticipantsSnapshot {
  readonly creator: Address
  readonly approver: Address
  readonly worker: Address | null
  readonly bidders: readonly Address[]
  readonly arbitrator: Address | null
  readonly jobId: string | null
}
export interface FeedEvent {
  readonly id: string
  readonly address: string
  readonly kind: string
  readonly role?: string
  readonly boardId?: string | null
  readonly taskId?: string | null
  readonly jobId?: string | null
  readonly summary: string
  readonly next?: { readonly tool: string; readonly args: Record<string, string> }
  readonly occurredAt: number
}
export class CommonsSql extends Context.Service<CommonsSql, SyncSql & { transaction<A>(f: (sql: SyncSql) => A): A }>()(
  '@sidequest/commons/CommonsSql',
) {}
export class StakeReader extends Context.Service<
  StakeReader,
  {
    stakes(addrs: readonly Address[]): Effect.Effect<StakeSnapshot, Unavailable>
    backing(addr: Address): Effect.Effect<BackingSnapshot, Unavailable>
  }
>()('@sidequest/commons/StakeReader') {}
export class Directory extends Context.Service<
  Directory,
  {
    resolve(tokens: string[]): Effect.Effect<readonly { token: string; address: Address | null }[]>
  }
>()('@sidequest/commons/Directory') {}
export class Participants extends Context.Service<
  Participants,
  {
    of(boardId: string, taskId: string): Effect.Effect<ParticipantsSnapshot | null, Unavailable>
  }
>()('@sidequest/commons/Participants') {}
export class RolesConfig extends Context.Service<
  RolesConfig,
  {
    readonly enabled: boolean
    readonly moderator: readonly Address[]
    readonly maintainer: readonly Address[]
    readonly arbiter: readonly Address[]
  }
>()('@sidequest/commons/RolesConfig') {}
export class FeedSink extends Context.Service<FeedSink, { write(events: readonly FeedEvent[]): Effect.Effect<void> }>()(
  '@sidequest/commons/FeedSink',
) {}
export interface Timed<A> {
  readonly expiresAt: number
  readonly value: A
}
export interface StakePosition {
  readonly stake: bigint
  readonly stakeBlock: bigint
  readonly backing: BackingSnapshot
}
export class Caches extends Context.Service<
  Caches,
  {
    readonly stake: Ref.Ref<Map<Address, Timed<StakePosition>>>
    readonly weights: Ref.Ref<Map<string, Timed<StakeSnapshot>>>
    readonly participants: Ref.Ref<Map<string, Timed<ParticipantsSnapshot | null>>>
  }
>()('@sidequest/commons/Caches') {
  static readonly layer = Layer.effect(
    Caches,
    Effect.gen(function* () {
      return {
        stake: yield* Ref.make(new Map<Address, Timed<StakePosition>>()),
        weights: yield* Ref.make(new Map<string, Timed<StakeSnapshot>>()),
        participants: yield* Ref.make(new Map<string, Timed<ParticipantsSnapshot | null>>()),
      }
    }),
  )
}
export type CommonsServices = CommonsSql | StakeReader | Directory | Participants | RolesConfig | FeedSink | Caches

import { COMMONS_OBJECT_NAME } from '@sidequest/commons'
import { fromDurableObjectSql, participantsOf, type DisputeThreadEntry } from '@sidequest/board'
import type { Network } from '@sidequest/sdk'
import { Effect, Schema } from 'effect'
import type { BoardCall } from '../board.ts'
import { toJson } from '../tools.ts'
import type { CommonsHost, CommonsState } from './host.ts'

interface RpcNamespace {
  idFromName(name: string): { toString(): string }
  getByName(name: string): { commonsThread(req: { subject: string }): Promise<string> }
}
const ThreadEntry = Schema.Struct({
  id: Schema.Int,
  author: Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]{40}$/u)),
  roles: Schema.Array(Schema.String),
  text: Schema.NullOr(Schema.String),
  hidden: Schema.Boolean,
  replyTo: Schema.NullOr(Schema.Int),
  at: Schema.Number,
})
const decodeThread = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(ThreadEntry)))
const namespaceOf = (bindings: Record<string, unknown>) => {
  // SAFETY: Board is the API Worker's existing internal Durable Object namespace binding.
  return bindings.Board as RpcNamespace
}

export function disputeThreadReader(bindings: Record<string, unknown>, env: BoardCall['env']) {
  return async (taskId: string): Promise<readonly DisputeThreadEntry[]> => {
    try {
      const entries = decodeThread(
        await namespaceOf(bindings)
          .getByName(COMMONS_OBJECT_NAME)
          .commonsThread({ subject: `job:${env.boardId}:${taskId}` }),
      )
      // SAFETY: the wire schema validates every author as a forty-hex-digit address.
      return entries as readonly DisputeThreadEntry[]
    } catch {
      return []
    }
  }
}

export function commonsRpcs(input: {
  state: CommonsState & { readonly id: { toString(): string } }
  bindings: Record<string, unknown>
  host: (env: BoardCall['env']) => CommonsHost
}) {
  const namespace = () => namespaceOf(input.bindings)
  return {
    jobParticipants: (req: { env: BoardCall['env']; taskId: string }) =>
      Effect.sync(() => {
        if (
          namespace().idFromName(req.env.boardId).toString() !== input.state.id.toString() ||
          req.env.network !== input.bindings.NETWORK
        )
          throw new Error('Board participant identity mismatch')
        return toJson(participantsOf(fromDurableObjectSql(input.state.storage.sql.raw), req.taskId))
      }),
    commonsThread: (req: { subject: string }) =>
      Effect.sync(() => {
        if (namespace().idFromName(COMMONS_OBJECT_NAME).toString() !== input.state.id.toString())
          throw new Error('Commons object identity mismatch')
        const network = Schema.decodeUnknownSync(Schema.Literals(['monad-testnet', 'monad-mainnet']))(
          input.bindings.NETWORK,
        )
        return toJson(input.host(readEnv(network)).thread(req.subject))
      }),
  }
}

const readEnv = (network: Network): BoardCall['env'] => ({
  network,
  boardId: COMMONS_OBJECT_NAME,
  rpcUrl: '',
  domain: '',
  uri: '',
  manifestBaseUrl: '',
  screening: { baseUrl: '', apiKey: '', model: '' },
  attesterKey: '',
  relayKey: '',
  github: { appId: '', privateKeyPem: '', installationId: '' },
})

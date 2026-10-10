import { Address, Participants, Unavailable, type ParticipantsSnapshot } from '@sidequest/commons'
import type { AsyncSql } from '@sidequest/indexer'
import { Effect, Layer, Schema } from 'effect'
import { deployment } from '@sidequest/sdk'
import type { BoardCall } from '../board.ts'
import { getBoard } from '../registry.ts'

const ParticipantsReply = Schema.NullOr(
  Schema.Struct({
    creator: Address,
    approver: Address,
    worker: Schema.NullOr(Address),
    bidders: Schema.Array(Address),
    arbitrator: Schema.NullOr(Address),
    jobId: Schema.NullOr(Schema.String),
  }),
)

export interface ParticipantsNamespace {
  getByName(name: string): { jobParticipants(req: { env: BoardCall['env']; taskId: string }): Promise<string> }
}

export function participantsLive(
  sql: AsyncSql,
  namespace: ParticipantsNamespace,
  env: BoardCall['env'],
): Participants['Service'] {
  return {
    of: (boardId, taskId) =>
      Effect.tryPromise({
        try: async (): Promise<ParticipantsSnapshot | null> => {
          if (boardId !== 'public' && (await getBoard(sql, boardId)) === undefined) return null
          const raw = await namespace.getByName(boardId).jobParticipants({ env: { ...env, boardId }, taskId })
          const people = Schema.decodeUnknownSync(Schema.fromJsonString(ParticipantsReply))(raw)
          if (people === null || people.jobId === null) return people
          const [job] = await sql.all<{ worker: string | null }>(
            'SELECT worker FROM jobs WHERE chain_id=? AND job_id=?',
            deployment(env.network).chainId,
            people.jobId,
          )
          const worker =
            job?.worker === null || job?.worker === undefined
              ? people.worker
              : Schema.decodeUnknownSync(Address)(job.worker)
          return { ...people, worker }
        },
        catch: () => new Unavailable({ message: 'Job participants are unavailable' }),
      }),
  }
}

export const participantsLayer = (sql: AsyncSql, namespace: ParticipantsNamespace, env: BoardCall['env']) =>
  Layer.succeed(Participants, participantsLive(sql, namespace, env))

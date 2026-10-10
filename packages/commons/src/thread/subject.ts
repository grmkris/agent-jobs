import { Effect, Ref } from 'effect'
import { Clock, Schema } from 'effect'
import { NotFound } from '../errors.ts'
import { Subject } from '../schema/ids.ts'
import { Caches, CommonsSql, Participants } from '../services.ts'

export function parseSubject(raw: string) {
  const subject = Schema.decodeUnknownSync(Subject)(raw)
  const [kind, boardId, taskId] = subject.split(':')
  if (kind === 'job') return { kind, subject, boardId: boardId!, taskId: taskId!, itemId: null }
  if (kind === 'roadmap') return { kind, subject, boardId: null, taskId: null, itemId: Number(boardId) }
  return { kind: 'lobby', subject, boardId: null, taskId: null, itemId: null }
}
export const subjectContext = Effect.fnUntraced(function* (subject: string) {
  const parsed = parseSubject(subject)
  const sql = yield* CommonsSql
  if (parsed.kind === 'roadmap' && sql.all('SELECT id FROM commons_items WHERE id=?', parsed.itemId).length === 0)
    return yield* new NotFound({ message: 'Roadmap item not found' })
  if (parsed.boardId === null || parsed.taskId === null) return { parsed, participants: null }
  const caches = yield* Caches
  const now = yield* Clock.currentTimeMillis
  const cached = (yield* Ref.get(caches.participants)).get(subject)
  if (cached !== undefined && cached.expiresAt > now) return { parsed, participants: cached.value }
  const reader = yield* Participants
  const participants = yield* reader.of(parsed.boardId, parsed.taskId)
  if (participants === null) return yield* new NotFound({ message: 'Job thread not found' })
  yield* Ref.update(caches.participants, (map) =>
    new Map(map).set(subject, { expiresAt: now + 60_000, value: participants }),
  )
  return { parsed, participants }
})

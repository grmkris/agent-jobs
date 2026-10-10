import type { Address } from './schema/ids.ts'
import type { Message } from './schema/messages.ts'
import type { FeedEvent, ParticipantsSnapshot } from './services.ts'
import { parseSubject } from './thread/subject.ts'

interface Recipient {
  readonly kind: string
  readonly role: string
}
export function postEvents(
  message: Message,
  people: ParticipantsSnapshot | null,
  moderators: readonly Address[],
  parentAuthor: Address | null,
): FeedEvent[] {
  const subject = parseSubject(message.subject)
  const recipients = new Map<Address, Recipient>()
  if (people !== null) {
    for (const [address, role] of [
      [people.creator, 'creator'],
      [people.approver, 'approver'],
      [people.worker, 'worker'],
    ]) {
      if (address !== null && address !== undefined && !recipients.has(address))
        recipients.set(address, { kind: 'message.posted', role: role! })
    }
  }
  for (const mention of message.mentions)
    if (mention.address !== null) recipients.set(mention.address, { kind: 'message.mention', role: 'mentioned' })
  if (parentAuthor !== null) recipients.set(parentAuthor, { kind: 'message.reply', role: 'author' })
  recipients.delete(message.author)
  const base = {
    boardId: subject.boardId,
    taskId: subject.taskId,
    jobId: people?.jobId ?? null,
    summary: `New message in ${subject.kind} thread.`,
    next: { tool: 'list_messages', args: { subject: message.subject } },
    occurredAt: message.createdAt,
  }
  return [
    ...[...new Set(moderators)].map((address) => ({
      ...base,
      id: `commons:m${message.id}:mod:${address}`,
      address,
      kind: 'message.posted',
      role: 'moderator',
    })),
    ...[...recipients].map(([address, recipient]) => ({
      ...base,
      id: `commons:m${message.id}:${address}`,
      address,
      ...recipient,
    })),
  ]
}

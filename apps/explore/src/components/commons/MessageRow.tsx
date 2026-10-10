import { Reply } from 'lucide-react'
import { Badge } from '../ui/badge.tsx'
import { Button } from '../ui/button.tsx'
import { When } from '../Time.tsx'
import { Monogram } from '../Wallet.tsx'
import {
  type Badge as BadgeT,
  type Message,
  badgeLabel,
  hiddenLabel,
  isRoleBadge,
  shortAddress,
  sortBadges,
} from '../../commons.ts'

/** Who someone is in this thread, as the board snapshotted it when they posted: roles first, then stake. */
function BadgeList({ badges }: { badges: readonly BadgeT[] }) {
  if (badges.length === 0) return null
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {sortBadges(badges).map((badge) => (
        <Badge key={`${badge.kind}-${badge.of ?? ''}`} variant={isRoleBadge(badge) ? 'info' : 'neutral'}>
          {badgeLabel(badge)}
        </Badge>
      ))}
    </span>
  )
}

/**
 * One post: who wrote it (their mark, short address and badges), when, and the text, kept as typed. A hidden post keeps
 * its place and author and shows the role and reason instead of the text.
 */
export function MessageRow({
  message,
  you,
  onReply,
  reply = false,
}: {
  message: Message
  you: boolean
  onReply?: (message: Message) => void
  reply?: boolean
}) {
  return (
    <article
      id={`m${message.id}`}
      className={reply ? 'grid gap-1.5 border-l-2 border-border py-2 pl-4' : 'grid gap-1.5 py-3'}
      aria-label={`Post by ${shortAddress(message.author)}`}
    >
      <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui">
        <Monogram seed={message.author} />
        <span className="font-mono text-muted-foreground">{shortAddress(message.author)}</span>
        {you && <Badge variant="info">You</Badge>}
        <BadgeList badges={message.badges} />
        <span className="ml-auto text-micro text-muted-foreground">
          <When at={message.createdAt} show="relative" />
        </span>
      </header>
      {message.hidden !== null || message.body === null ? (
        <p className="text-sm text-muted-foreground italic">
          {message.hidden === null ? 'Hidden.' : hiddenLabel(message.hidden)}
        </p>
      ) : (
        <p className="text-base leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap">{message.body}</p>
      )}
      {onReply !== undefined && message.hidden === null && (
        <div>
          <Button variant="ghost" size="sm" onClick={() => onReply(message)}>
            <Reply aria-hidden />
            Reply
          </Button>
        </div>
      )}
    </article>
  )
}

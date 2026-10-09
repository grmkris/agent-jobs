import { useRouter } from '@tanstack/react-router'
import type { LucideIcon } from 'lucide-react'
import type { MouseEvent, ReactNode } from 'react'
import { When } from './Time.tsx'
import { Item, ItemContent, ItemMedia } from './ui/item.tsx'

/**
 * One thing that happened, as a row: what it was (an icon, or the agent's orb), a sentence, and how long ago. With a
 * link the whole row opens it, inside the app for a path here (a modified click still opens a new tab). Shared by the
 * Live strip on Jobs and the account's own activity.
 */
export function ActivityRow({
  media,
  children,
  label,
  at,
  href,
}: {
  media: ReactNode
  children: ReactNode
  /** The row's sentence as plain text, its accessible name when it is a link. */
  label: string
  at: number
  href?: string | undefined
}) {
  const router = useRouter()
  const open = (event: MouseEvent) => {
    if (href?.startsWith('/') !== true || event.button !== 0) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    void router.navigate({ href })
  }
  const body = (
    <>
      <ItemMedia>{media}</ItemMedia>
      <ItemContent className="min-w-0 flex-1">
        <span className="line-clamp-2 text-sm leading-snug">{children}</span>
      </ItemContent>
      <span className="shrink-0 text-ui text-muted-foreground">
        <When at={at} show="relative" />
      </span>
    </>
  )
  if (href === undefined) return <Item className="before:left-14">{body}</Item>
  return (
    <Item className="before:left-14" render={<a href={href} aria-label={label} onClick={open} />}>
      {body}
    </Item>
  )
}

/** An event's icon in the round well the rows share. */
export function ActivityIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
      <Icon aria-hidden className="size-4" />
    </span>
  )
}

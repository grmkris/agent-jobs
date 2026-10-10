import { type ReactNode, useId, useRef, useState } from 'react'
import { tapAction } from '../preview-tap.ts'
import { BoardLink, type LinkTarget } from './BoardLink.tsx'
import { PreviewCard, PreviewCardContent, PreviewCardTrigger } from './ui/preview-card.tsx'

/**
 * A link that previews where it goes: hovering it with a mouse, or focusing it, opens `card` after a moment, and a
 * click follows the link. Touch has no hover, so a first tap opens the card and a second tap (or a link in the card)
 * follows. `card` mounts only while open, so whatever it reads starts on demand. A `decorative` link (an orb beside
 * the name that links the same place) stays out of the tab order and the accessibility tree.
 */
export function PeekLink({
  target,
  card,
  className,
  decorative = false,
  children,
}: {
  target: LinkTarget
  card: ReactNode
  className?: string
  decorative?: boolean
  children: ReactNode
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const pointer = useRef<string | null>(null)
  // A card a tap opened has no hover to keep it open: only an outside tap, Escape or following the link closes it.
  const tapped = useRef(false)
  return (
    // A controlled card opened by a tap needs to know which trigger it belongs to.
    <PreviewCard
      open={open}
      triggerId={id}
      onOpenChange={(next, details) => {
        if (!next && tapped.current && details.reason === 'trigger-hover') return
        tapped.current = false
        setOpen(next)
      }}
    >
      <PreviewCardTrigger
        id={id}
        delay={350}
        closeDelay={150}
        className={className}
        render={<BoardLink target={target} {...(decorative ? { tabIndex: -1, 'aria-hidden': true } : {})} />}
        onPointerDown={(e) => {
          pointer.current = e.pointerType
        }}
        onClick={(e) => {
          const action = tapAction(pointer.current, open)
          pointer.current = null
          if (action === 'follow') return
          e.preventDefault()
          tapped.current = true
          setOpen(true)
        }}
      >
        {children}
      </PreviewCardTrigger>
      <PreviewCardContent>{card}</PreviewCardContent>
    </PreviewCard>
  )
}

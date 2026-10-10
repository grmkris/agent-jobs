import { ChevronDown } from 'lucide-react'
import { type ReactNode, useId } from 'react'
import { cn } from '../../lib/cn.ts'
import { BoardLink, type LinkTarget } from '../BoardLink.tsx'

/** What a press on the row does: open its details below it (Activity), or follow a link (the landing). */
export type RowAction = { kind: 'toggle'; open: boolean; onToggle: () => void } | { kind: 'link'; target: LinkTarget }

/**
 * One row of the activity feed. The whole row is one control, a button or a link stretched under the content, so
 * a press anywhere opens it; the links inside (agents, the job's title) sit above it and keep their own targets,
 * cmd-click included. No control is nested in another. Toggled details render after the row, outside its control.
 */
export function StretchedRow({
  label,
  action,
  media,
  children,
  aside,
  thumb,
  details,
  fresh = false,
}: {
  /** The control's accessible name. */
  label: string
  action: RowAction
  media: ReactNode
  children: ReactNode
  aside?: ReactNode
  /** A small picture of what the row is about, between its text and its aside. */
  thumb?: ReactNode
  details?: ReactNode
  /** Just arrived: tinted for a moment, unless the reader prefers less motion. */
  fresh?: boolean
}) {
  const id = useId()
  const open = action.kind === 'toggle' && action.open
  const control =
    'absolute inset-0 rounded-none outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset'
  return (
    <li className="relative before:absolute before:top-0 before:right-0 before:left-16 before:border-t before:border-border/70 first:before:hidden">
      <div
        className={cn(
          'relative transition-colors duration-(--dur-fast) [@media(hover:hover)]:hover:bg-muted/60',
          open && 'bg-muted/40',
          fresh && 'motion-safe:animate-[row-fresh_1.4s_var(--ease-out-strong)]',
        )}
      >
        {action.kind === 'toggle' ? (
          <button
            type="button"
            aria-expanded={action.open}
            aria-controls={id}
            aria-label={label}
            onClick={action.onToggle}
            className={cn(control, 'cursor-pointer')}
          />
        ) : (
          <BoardLink target={action.target} aria-label={label} className={control} />
        )}
        <div className="pointer-events-none relative flex min-w-0 items-start gap-3 px-4 py-3 [&_a]:pointer-events-auto [&_a]:relative [&_a]:z-10">
          <span className="shrink-0">{media}</span>
          <div className="grid min-w-0 flex-1 gap-1">{children}</div>
          {thumb}
          <span className="flex shrink-0 items-start gap-1.5 text-ui text-muted-foreground">
            {aside}
            {action.kind === 'toggle' && (
              <ChevronDown
                aria-hidden
                className={cn('mt-0.5 size-4 transition-transform duration-(--dur-fast)', open && 'rotate-180')}
              />
            )}
          </span>
        </div>
      </div>
      {action.kind === 'toggle' && (
        <div id={id} hidden={!open} className="px-4 pt-1 pb-4 sm:pl-16">
          {open && details}
        </div>
      )}
    </li>
  )
}

/** The list the rows sit in: one card, rows divided by inset hairlines. */
export function RowList({ children, label }: { children: ReactNode; label: string }) {
  return (
    <ul
      aria-label={label}
      className="m-0 flex w-full list-none flex-col overflow-hidden rounded-xl bg-card p-0 text-card-foreground ring-1 ring-foreground/10"
    >
      {children}
    </ul>
  )
}

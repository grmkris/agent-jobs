import { Collapsible } from '@base-ui/react/collapsible'
import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../../lib/cn.ts'

/**
 * A summary that unfolds more in place. The panel grows to its content's height and fades in (Base UI measures it as
 * `--collapsible-panel-height`), and folds the same way; with reduced motion it only fades.
 */
export function Disclosure({
  summary,
  children,
  className,
  defaultOpen = false,
}: {
  summary: ReactNode
  children: ReactNode
  className?: string
  defaultOpen?: boolean
}) {
  return (
    <Collapsible.Root defaultOpen={defaultOpen} className={className}>
      <Collapsible.Trigger className="group/disclosure inline-flex min-h-8 cursor-pointer items-center gap-1 rounded-md px-1 text-sm font-medium outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:min-h-11">
        <ChevronRight
          aria-hidden
          className="size-4 text-muted-foreground transition-transform duration-(--dur-fast) ease-(--ease-out-strong) group-data-[panel-open]/disclosure:rotate-90 motion-reduce:transition-none"
        />
        {summary}
      </Collapsible.Trigger>
      <Collapsible.Panel
        className={cn(
          'h-(--collapsible-panel-height) overflow-hidden transition-[height,opacity] duration-(--dur-base) ease-(--ease-out-strong)',
          'data-[ending-style]:h-0 data-[ending-style]:opacity-0 data-[starting-style]:h-0 data-[starting-style]:opacity-0',
          'motion-reduce:transition-[opacity]',
        )}
      >
        {children}
      </Collapsible.Panel>
    </Collapsible.Root>
  )
}

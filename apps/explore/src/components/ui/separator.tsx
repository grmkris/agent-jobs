// shadcn base-nova on Base UI, vendored from ~/code/purrable/packages/ui; edit here, there is no upstream sync.
'use client'

import { Separator as SeparatorPrimitive } from '@base-ui/react/separator'
import { cn } from '../../lib/cn.ts'

function Separator({ className, orientation = 'horizontal', ...props }: SeparatorPrimitive.Props) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      className={cn(
        'shrink-0 bg-border data-horizontal:h-px data-horizontal:w-full data-vertical:w-px data-vertical:self-stretch',
        className,
      )}
      {...props}
    />
  )
}

export { Separator }

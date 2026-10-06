// shadcn base-nova style, vendored from ~/code/purrable/packages/ui; edit here, there is no upstream sync. A quantity within
// known bounds (a success rate, a weekly budget used, progress to the next fee tier) on Base UI's Meter: a thin track whose
// fill glides when the value changes. Not a Progress: nothing here is "loading". `fill` colours the indicator.
import { Meter as MeterPrimitive } from '@base-ui/react/meter'
import { cn } from '../../lib/cn.ts'

function Meter({ className, children, fill, ...props }: MeterPrimitive.Root.Props & { fill?: string }) {
  return (
    <MeterPrimitive.Root data-slot="meter" className={cn('flex w-full min-w-0 flex-col gap-2', className)} {...props}>
      {children}
      <MeterPrimitive.Track data-slot="meter-track" className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <MeterPrimitive.Indicator
          data-slot="meter-indicator"
          className={cn('h-full rounded-full bg-primary transition-[width] duration-500 ease-out motion-reduce:transition-none', fill)}
        />
      </MeterPrimitive.Track>
    </MeterPrimitive.Root>
  )
}

export { Meter }

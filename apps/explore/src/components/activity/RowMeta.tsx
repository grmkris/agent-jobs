import { type Thumb } from '../../delivery-plan.ts'
import { DeliveryImage } from '../delivery/DeliveryImage.tsx'

/** The row's small picture of what was delivered; on wider screens only, where the row has room for it. */
export function RowThumb({ thumb }: { thumb: Thumb }) {
  return (
    <span aria-hidden className="hidden shrink-0 sm:block">
      <DeliveryImage thumb={thumb} icons={8} className="h-11 w-[4.5rem] rounded-md ring-1 ring-foreground/10" />
    </span>
  )
}

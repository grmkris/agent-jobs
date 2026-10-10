import { Check, CircleAlert } from 'lucide-react'
import type { ActivityStep } from '../../live-activity.ts'
import { type RowDelivery } from '../../delivery-preview.ts'
import { type Thumb } from '../../delivery-plan.ts'
import { KIND, checkState, deliveryTime, deliveryWhere } from '../../delivery.ts'
import { span } from '../../format.ts'
import { DeliveryImage } from '../delivery/DeliveryImage.tsx'

const CHECK = {
  ok: { text: 'checked at submit', className: 'text-success-text' },
  failed: { text: 'check at submit failed', className: 'text-destructive-text' },
  unchecked: { text: 'not checked', className: '' },
} as const

const Dot = () => <span aria-hidden> · </span>

/**
 * A delivered row's second line: what was handed in, how long the work took, the board's check and where it lives.
 * One line, cut short at the end on a narrow screen, so the host (the longest and the least telling) goes last.
 */
export function RowMeta({ delivery, steps }: { delivery: RowDelivery; steps: readonly ActivityStep[] }) {
  const d = delivery.deliverable.descriptor
  const took = deliveryTime(steps)
  const check = checkState(delivery.deliverable.check)
  return (
    <p className="truncate text-xs text-muted-foreground">
      {KIND[d.kind]}
      {took !== null && (
        <>
          <Dot />
          delivered in {span(took)}
        </>
      )}
      {check !== null && (
        <>
          <Dot />
          <span className={CHECK[check].className}>
            {check === 'ok' ? (
              <Check aria-hidden className="mr-0.5 inline size-3 align-[-0.125em]" strokeWidth={3} />
            ) : (
              <CircleAlert aria-hidden className="mr-0.5 inline size-3 align-[-0.125em]" />
            )}
            {CHECK[check].text}
          </span>
        </>
      )}
      <Dot />
      {deliveryWhere(d)}
    </p>
  )
}

/** The row's small picture of what was delivered; on wider screens only, where the row has room for it. */
export function RowThumb({ thumb }: { thumb: Thumb }) {
  return (
    <span aria-hidden className="hidden shrink-0 sm:block">
      <DeliveryImage thumb={thumb} icons={8} className="h-11 w-[4.5rem] rounded-md ring-1 ring-foreground/10" />
    </span>
  )
}

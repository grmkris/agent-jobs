/**
 * A deadline as rolling digits: "2d 04h 17m 05s" at display size, minute precision in rows, then a word once
 * it has passed. The digits roll downwards (NumberFlow, which honours reduced motion) and are decoration: screen
 * readers read minute-level plain text beside them.
 */
import NumberFlow, { NumberFlowGroup } from '@number-flow/react'
import { countdownParts, countdownText, countdownUrgent } from '../countdown.ts'
import { cn } from '../lib/cn.ts'
import { useRemaining, utc } from './Time.tsx'

export function RollingCountdown({
  to,
  passed = 'passed',
  size = 'row',
  className,
}: {
  to: number
  /** What it reads once the deadline is behind it: "closed", "overdue". */
  passed?: string
  size?: 'row' | 'display'
  className?: string
}) {
  const precision = size === 'display' ? 'second' : 'minute'
  const left = useRemaining(to, precision)
  const at = new Date(to * 1000).toISOString()
  if (left <= 0)
    return (
      <time dateTime={at} title={utc(to)} className={cn('text-muted-foreground', className)}>
        {passed}
      </time>
    )
  const parts = countdownParts(left, precision)
  return (
    <time
      dateTime={at}
      title={utc(to)}
      className={cn(
        'inline-flex items-baseline whitespace-nowrap tabular-nums',
        size === 'display' ? 'text-3xl font-semibold tracking-tight' : 'font-medium',
        countdownUrgent(left) && 'text-warning-text',
        className,
      )}
    >
      <span className="sr-only">{countdownText(countdownParts(left, 'minute'))}</span>
      <span aria-hidden className="inline-flex items-baseline gap-[0.3em]">
        <NumberFlowGroup>
          {parts.map((part) => (
            <span key={part.unit} className="inline-flex items-baseline">
              <NumberFlow
                value={part.value}
                format={{ minimumIntegerDigits: part.pad, useGrouping: false }}
                trend={-1}
                {...(part.tensMax === undefined ? {} : { digits: { 1: { max: part.tensMax } } })}
              />
              <span className="ml-[0.06em] text-[0.78em] font-normal text-muted-foreground">{part.unit}</span>
            </span>
          ))}
        </NumberFlowGroup>
      </span>
    </time>
  )
}

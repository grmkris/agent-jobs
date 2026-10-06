import { cn } from '../../lib/cn.ts'
import { Button } from '../ui/button.tsx'
import { Field, FieldLabel, FieldDescription } from '../ui/field.tsx'
import { ItemGroup, Item, ItemMedia, ItemContent, ItemActions } from '../ui/item.tsx'
/**
 * The Post flow's own controls, drawn from the shared tokens: explained choices with radio circles, an iOS switch,
 * toggle chips, the four-segment progress bar, the Back / Continue bar, rows that hold a field, and a disclosure
 * styled as a grouped surface.
 */
import { Check, ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { selectRadio } from '../radio.ts'

export function Choices<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T
  onChange: (v: T) => void
  options: ReadonlyArray<{ value: T; title: ReactNode; body: ReactNode }>
  label: string
}) {
  return (
    <ItemGroup role="radiogroup" aria-label={label}>
      {options.map((o) => {
        const on = o.value === value
        return (
          <Item
            key={o.value}
            render={
              <button
                type="button"
                role="radio"
                aria-checked={on}
                tabIndex={on ? 0 : -1}
                onClick={() => onChange(o.value)}
                onKeyDown={(event) =>
                  selectRadio(
                    event,
                    options.findIndex((option) => option.value === o.value),
                    options.length,
                    (index) => onChange(options[index]!.value),
                  )
                }
              />
            }
            className={cn('items-start py-3.5 before:left-[3.125rem]')}
          >
            <ItemMedia>
              <span
                aria-hidden
                className={cn(
                  'mt-0.5 grid size-[22px] shrink-0 place-items-center rounded-full transition-colors',
                  on ? 'bg-primary text-primary-foreground' : 'shadow-[inset_0_0_0_1.5px_var(--muted-foreground)]',
                )}
              >
                {on && <Check className="size-3.5" strokeWidth={3.2} />}
              </span>
            </ItemMedia>
            <ItemContent className="min-w-0">
              <span className="block font-semibold">{o.title}</span>
              <span className="mt-0.5 block text-sm leading-snug text-muted-foreground">{o.body}</span>
            </ItemContent>
          </Item>
        )
      })}
    </ItemGroup>
  )
}

/** The iOS switch. */
export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className="grid h-11 w-[51px] shrink-0 place-items-center"
    >
      <span
        aria-hidden
        className={cn('relative h-[31px] w-[51px] rounded-full transition-colors duration-200', checked ? 'bg-success-text' : 'bg-accent')}
      >
        <span
          className={cn(
            'absolute top-[2px] left-[2px] size-[27px] rounded-full bg-white shadow-[0_2px_4px_rgba(0,0,0,0.2)] transition-transform duration-200 ease-(--ease-sheet)',
            checked && 'translate-x-5',
          )}
        />
      </span>
    </button>
  )
}

/** A toggle chip, for picking several of a few (accepted tokens, deliverable kinds). */
export function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        'transition-transform duration-(--dur-fast) ease-(--ease-out-strong) active:scale-[0.96] inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-sm font-medium',
        on ? 'bg-primary/14 text-primary' : 'bg-muted text-muted-foreground',
      )}
    >
      {on && <Check aria-hidden className="size-3.5" strokeWidth={3} />}
      {children}
    </button>
  )
}

export function Progress({ step, of }: { step: number; of: number }) {
  return (
    <div
      role="progressbar"
      aria-label={`Step ${step} of ${of}`}
      aria-valuemin={1}
      aria-valuemax={of}
      aria-valuenow={step}
      className="flex gap-1.5 px-1"
    >
      {Array.from({ length: of }, (_, i) => (
        <span key={i} className={cn('h-1 flex-1 rounded-full transition-colors duration-300', i < step ? 'bg-primary' : 'bg-accent')} />
      ))}
    </div>
  )
}

/** Back, a quiet status in the middle ("Draft saved"), and the step's primary action. */
export function StepNav({
  onBack,
  status,
  children,
  stack = false,
}: {
  onBack?: (() => void) | undefined
  status?: ReactNode
  children: ReactNode
  stack?: boolean
}) {
  return (
    // `stack`: a long final action goes full width on a phone, above Back, instead of wrapping beside it.
    <div
      className={cn('flex items-center gap-3', stack && 'max-sm:flex-col-reverse max-sm:items-stretch max-sm:gap-2 max-sm:[&>*]:w-full')}
    >
      <Button variant="secondary" size="lg" onClick={onBack} disabled={onBack === undefined}>
        Back
      </Button>
      <span
        aria-live="polite"
        className={cn('min-w-0 flex-1 truncate text-center text-ui text-muted-foreground', stack && 'max-sm:hidden')}
      >
        {status}
      </span>
      {children}
    </div>
  )
}

/** A row holding a labelled field: the label above, the control below, an optional hint. */
export function FieldRow({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: ReactNode
  hint?: ReactNode
  children: ReactNode
  htmlFor?: string
}) {
  return (
    <Item render={<Field />} className="flex-col items-stretch gap-1.5 py-3">
      <FieldLabel htmlFor={htmlFor}>{label}</FieldLabel>
      {children}
      {hint !== undefined && <FieldDescription>{hint}</FieldDescription>}
    </Item>
  )
}

/** A row with a label (and a note under it) on the left and a control or value on the right; `stack` puts a wide control below. */
export function LineRow({
  label,
  note,
  children,
  stack = false,
  htmlFor,
}: {
  label: ReactNode
  note?: ReactNode
  children?: ReactNode
  stack?: boolean
  htmlFor?: string
}) {
  return (
    <Item className={cn(stack && 'flex-col items-stretch gap-2 py-3 sm:flex-row sm:items-center')}>
      <label htmlFor={htmlFor} className="min-w-0 flex-1">
        <span className="block">{label}</span>
        {note !== undefined && <span className="block text-xs leading-snug text-muted-foreground">{note}</span>}
      </label>
      {children}
    </Item>
  )
}

/** A label and a value, as a Group row. */
export function KV({ label, children, note }: { label: ReactNode; children: ReactNode; note?: ReactNode }) {
  return (
    <Item className={cn('items-baseline justify-between')}>
      <span className="max-w-[55%] shrink-0">
        <span className="block">{label}</span>
        {note !== undefined && <span className="block text-xs leading-snug text-muted-foreground">{note}</span>}
      </span>
      <ItemActions className="min-w-0 flex-1 flex-col items-end text-right text-muted-foreground [overflow-wrap:anywhere]">
        {children}
      </ItemActions>
    </Item>
  )
}

/** A native disclosure drawn as a grouped surface: the summary is its first row, the content the rows below. */
export function Disclosure({
  title,
  summary,
  children,
  open,
  onToggle,
}: {
  title: ReactNode
  summary?: ReactNode
  children: ReactNode
  open?: boolean
  onToggle?: (open: boolean) => void
}) {
  return (
    <details
      open={open}
      onToggle={(e) => onToggle?.((e.currentTarget as HTMLDetailsElement).open)}
      className="group/disclosure overflow-hidden rounded-xl bg-card"
    >
      <Item render={<summary />} className={cn('cursor-pointer list-none [&::-webkit-details-marker]:hidden')}>
        <ItemContent className="flex-1 font-medium">{title}</ItemContent>
        {summary !== undefined && (
          <span className="min-w-0 truncate text-ui text-muted-foreground group-open/disclosure:hidden">{summary}</span>
        )}
        <ItemActions>
          <ChevronRight
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open/disclosure:rotate-90"
          />
        </ItemActions>
      </Item>
      {children}
    </details>
  )
}

/** The round mark at the start of a checklist or screening row. */
export function Mark({ tone }: { tone: 'ok' | 'warn' | 'bad' | 'wait' | 'none' }) {
  if (tone === 'wait')
    return <span aria-hidden className="size-6 shrink-0 animate-spin rounded-full border-[2.5px] border-accent border-t-primary" />
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-6 shrink-0 place-items-center rounded-full text-ui font-bold text-background',
        tone === 'ok' && 'bg-success-text',
        tone === 'warn' && 'bg-warning-text',
        tone === 'bad' && 'bg-destructive-text',
        tone === 'none' && 'bg-accent text-muted-foreground',
      )}
    >
      {tone === 'ok' ? <Check className="size-3.5" strokeWidth={3} /> : tone === 'none' ? '–' : '!'}
    </span>
  )
}

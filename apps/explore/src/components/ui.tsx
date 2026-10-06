/**
 * Sidequest's primitives, drawn with the base-nova components in ./ui/ (shadcn on Base UI) and the tokens in
 * styles.css. Pages compose these; they carry no colours of their own. The props are the ones pages have always used
 * (a Button `variant` of primary/tinted/gray…, Badge tones), mapped onto base-nova's variants here, so a page moves to
 * the new look without edits.
 *
 * Desktop is dense (32px controls, 40px rows, 14px text); on a coarse pointer every control and row grows to a 44px
 * target. Semantics stay native on purpose: buttons are <button> (a real `disabled`), fields are wrapped in their
 * <label>, and Segmented is a radiogroup with arrow-key selection; tests and the live harness query those.
 */
import { Check, ChevronRight, Copy, ExternalLink } from 'lucide-react'
import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes, useState } from 'react'
import { amount as formatAmount } from '../format.ts'
import { explorer } from '../wallet.ts'
import { selectRadio } from './radio.ts'
import { cn } from '../lib/cn.ts'
import { Badge as BaseBadge } from './ui/badge.tsx'
import { buttonVariants } from './ui/button.tsx'
import { Spinner } from './ui/spinner.tsx'

export { cn }

type ButtonVariant = 'primary' | 'tinted' | 'gray' | 'danger' | 'destructive' | 'plain' | 'outline'

/** Our names → base-nova's. `danger` is the soft red tint; `destructive` the solid one, for an irreversible action. */
const BUTTON_VARIANT = {
  primary: 'default',
  tinted: 'secondary',
  gray: 'secondary',
  outline: 'outline',
  danger: 'destructive',
  destructive: 'danger',
  plain: 'link',
} as const
const BUTTON_SIZE = { sm: 'sm', md: 'default', lg: 'lg' } as const

export function Button({
  busy,
  className,
  children,
  variant = 'primary',
  size = 'md',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean | undefined; variant?: ButtonVariant; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <button
      type="button"
      data-slot="button"
      {...props}
      disabled={busy === true || props.disabled}
      aria-busy={busy === true ? true : undefined}
      className={cn(
        buttonVariants({ variant: BUTTON_VARIANT[variant], size: BUTTON_SIZE[size] }),
        // A long label wraps rather than overflowing a narrow screen; the height grows with it.
        variant !== 'plain' && 'h-auto min-h-8 py-1 text-center whitespace-normal pointer-coarse:h-auto pointer-coarse:min-h-11',
        variant !== 'plain' && size === 'sm' && 'min-h-7',
        variant !== 'plain' && size === 'lg' && 'min-h-9',
        variant === 'plain' && 'h-auto min-h-0 px-0 py-0 pointer-coarse:h-auto',
        className,
      )}
    >
      {/* The label stays the button's whole name while it works: tests and the live harness find buttons by it. */}
      {busy === true && <Spinner data-icon="inline-start" role={undefined} aria-label={undefined} aria-hidden />}
      {children}
    </button>
  )
}

/** A titled block: a quiet header above a surface, and an optional footnote below it. */
export function Section({ title, note, children, className, action }: { title?: ReactNode; note?: ReactNode; children: ReactNode; className?: string; action?: ReactNode }) {
  return (
    <section className={cn('grid min-w-0 content-start gap-2', className)}>
      {(title !== undefined || action !== undefined) && (
        <div className="flex min-h-6 items-center justify-between gap-3 px-1">
          {title !== undefined && <h2 className="text-ui font-medium text-muted-foreground">{title}</h2>}
          {action}
        </div>
      )}
      {children}
      {note !== undefined && <p className="px-1 text-ui text-muted-foreground">{note}</p>}
    </section>
  )
}

/** The card surface: a hairline ring rather than a border or a shadow; rows inside are separated by hairlines. */
export function Group({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('overflow-hidden rounded-xl bg-card text-card-foreground ring-1 ring-foreground/10', className)}>{children}</div>
}

const ROW_SEP = "relative before:absolute before:top-0 before:right-0 before:left-4 before:border-t before:border-border/70 first:before:hidden before:content-['']"

/**
 * The classes of a Group row, for a row that is itself a link (`<Link className={rowClass({ interactive: true })}>`):
 * links and rows must be siblings in the Group for the hairlines to fall between them. `inset` starts the hairline
 * after a leading avatar.
 */
export const rowClass = ({ inset = false, interactive = false }: { inset?: boolean; interactive?: boolean } = {}) =>
  cn(
    ROW_SEP,
    inset && 'before:left-14',
    'flex min-h-10 w-full items-center gap-3 px-4 py-2 text-left pointer-coarse:min-h-11',
    interactive && 'transition-colors duration-(--dur-fast) active:bg-muted [@media(hover:hover)]:hover:bg-muted/60',
  )

/** A row of a Group; an `onClick` row is a button with a pressed state. */
export function ListRow({ children, className, onClick, inset = false }: { children: ReactNode; className?: string; onClick?: () => void; inset?: boolean }) {
  if (onClick === undefined) return <div className={cn(rowClass({ inset }), className)}>{children}</div>
  return (
    <button type="button" onClick={onClick} className={cn(rowClass({ inset, interactive: true }), className)}>
      {children}
    </button>
  )
}

/** A card: a titled Group with padding, for free content. */
export function Card({ title, children, className, note }: { title?: ReactNode; children: ReactNode; className?: string; note?: ReactNode }) {
  return (
    <Section title={title} note={note}>
      <Group className={cn('p-4', className)}>{children}</Group>
    </Section>
  )
}

/** A label and its value on one row. */
export function Row({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className={cn(ROW_SEP, '-mx-4 flex min-h-10 items-center justify-between gap-4 px-4 py-2 text-sm first:-mt-2 last:-mb-2 pointer-coarse:min-h-11')}>
      <span className="min-w-0">
        <span className="text-foreground">{label}</span>
        {hint !== undefined && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
      <span className="min-w-0 text-right text-muted-foreground [overflow-wrap:anywhere]">{children}</span>
    </div>
  )
}

export type Tone = 'info' | 'attention' | 'success' | 'danger' | 'neutral'
const LEGACY: Record<string, Tone | 'current'> = { green: 'success', red: 'danger', amber: 'attention', blue: 'info', gray: 'neutral', warning: 'attention', tint: 'current' }
const BADGE = { info: 'info', attention: 'warning', success: 'success', danger: 'destructive', neutral: 'neutral', current: 'default' } as const

/** A status pill. Tones are semantic: info, attention, success, danger, neutral (`tint` marks the current step). */
export function Badge({ tone = 'neutral', children, className }: { tone?: Tone | keyof typeof LEGACY; children: ReactNode; className?: string }) {
  const t = LEGACY[tone] ?? (tone as Tone)
  return (
    <BaseBadge variant={BADGE[t] ?? 'neutral'} className={className}>
      {children}
    </BaseBadge>
  )
}

/** Marks sample or example content where it must not pass for real data. */
export function Tag({ children }: { children: ReactNode }) {
  return <span className="rounded-md border border-border px-1.5 text-micro font-medium tracking-wide text-muted-foreground uppercase">{children}</span>
}

export function statusTone(status: string): Tone {
  if (status === 'completed' || status === 'awarded') return 'success'
  if (['rejected', 'cancelled', 'expired'].includes(status)) return 'danger'
  if (['disputed', 'rejected-pending', 'submitted', 'lapsed', 'selection-closed'].includes(status)) return 'attention'
  if (['open', 'active'].includes(status)) return 'info'
  return 'neutral'
}

/** Copies `value` and shows a check for a moment; falls back to selecting nothing when the clipboard is refused. */
export function CopyButton({ value, label = 'Copy', className }: { value: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(
          () => {
            setDone(true)
            setTimeout(() => setDone(false), 1400)
          },
          () => undefined,
        )
      }}
      className={cn(
        'inline-grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors duration-(--dur-fast) active:bg-muted pointer-coarse:size-11 [@media(hover:hover)]:hover:bg-muted [@media(hover:hover)]:hover:text-foreground',
        done && 'text-success-text',
        className,
      )}
    >
      {done ? <Check className="size-3.5" strokeWidth={2.5} /> : <Copy className="size-3.5" />}
    </button>
  )
}

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

/** An address: shortened, linked to the explorer, copyable. */
export function Address({ value, you = false }: { value: string | null | undefined; you?: boolean }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground">—</span>
  return (
    <span className="inline-flex min-w-0 max-w-full flex-wrap items-center justify-end gap-0.5 font-mono text-ui">
      <a href={explorer('address', value)} target="_blank" rel="noreferrer" className="inline-flex min-h-8 items-center text-muted-foreground hover:text-foreground pointer-coarse:min-h-11">
        {shortAddress(value)}
      </a>
      {you && <Badge tone="info" className="ml-1 font-sans">You</Badge>}
      <CopyButton value={value} label="Copy address" />
    </span>
  )
}

export function TxLink({ hash, label }: { hash: string | null | undefined; label?: string }) {
  if (hash === null || hash === undefined) return null
  return (
    // py-3.5 -my-3.5: a 44 px target that takes no more room in its line.
    <a href={explorer('tx', hash)} target="_blank" rel="noreferrer" className="-my-3.5 inline-flex items-center gap-1 py-3.5 font-mono text-ui text-muted-foreground underline decoration-current/30 underline-offset-4 hover:text-foreground">
      {label ?? `${hash.slice(0, 10)}…`}
      <ExternalLink aria-hidden className="size-3" />
    </a>
  )
}

/** An amount in a token, with tabular figures. */
export function Amount({ value, token, className }: { value: string | null | undefined; token: string | null | undefined; className?: string }) {
  return <span className={cn('tabular font-medium whitespace-nowrap', className)}>{formatAmount(value, token)}</span>
}

/** A link in running text: the primary is near-black, so the underline is what says "link". */
export const textLinkClass = 'text-foreground underline decoration-foreground/30 underline-offset-4 transition-colors duration-(--dur-fast) hover:decoration-foreground'

/**
 * The field look of base-nova's Input: a hairline border, a ring on focus. 16px text below `md` so iOS does not zoom
 * the page on focus, 14px above; 32px tall on desktop, 44px on touch.
 */
const FIELD =
  'w-full min-w-0 min-h-8 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors duration-(--dur-fast) outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm pointer-coarse:min-h-11 dark:bg-input/30'

export function Field({ label, children, hint, className }: { label: ReactNode; children: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <label className={cn('grid gap-1.5', className)}>
      <span className="text-ui font-medium text-foreground">{label}</span>
      {children}
      {hint !== undefined && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  )
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input data-slot="input" {...props} className={cn(FIELD, className)} />
}

export function TextArea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea data-slot="textarea" {...props} className={cn(FIELD, 'min-h-24 py-2 leading-relaxed', className)} />
}

/** A native <select>: a portalled Base UI menu would sit below a modal <dialog> sheet's top layer. */
export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select data-slot="select" {...props} className={cn(FIELD, 'appearance-auto pr-8', className)}>
      {children}
    </select>
  )
}

/** The segmented control (a radiogroup): base-nova's tabs-list look, iOS semantics. */
export function Segmented<T extends string>({ value, options, onChange, className, label }: { value: T; options: ReadonlyArray<readonly [T, ReactNode]>; onChange: (v: T) => void; className?: string; label?: string }) {
  return (
    <div role="radiogroup" aria-label={label} className={cn('flex min-w-0 flex-wrap gap-0.5 rounded-lg bg-muted p-[3px]', className)}>
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          tabIndex={value === v ? 0 : -1}
          onClick={() => onChange(v)}
          onKeyDown={(event) => selectRadio(event, options.findIndex(([option]) => option === v), options.length, (index) => onChange(options[index]![0]))}
          className={cn(
            'min-h-8 min-w-min flex-1 rounded-md px-2.5 py-1 text-ui font-medium break-words transition-[background-color,color,box-shadow] duration-(--dur-fast) pointer-coarse:min-h-11',
            value === v ? 'bg-background text-foreground shadow-sm ring-1 ring-foreground/5 dark:bg-input/40' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {text}
        </button>
      ))}
    </div>
  )
}

/** base-nova's skeleton, as a <span>: placeholders sit inside inline content (rows, paragraphs). */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden data-slot="skeleton" className={cn('block animate-pulse rounded-md bg-muted', className ?? 'h-4 w-full')} />
}

/** Rows of placeholder while a list loads, so loading never reads as "empty". */
export function LoadingRows({ rows = 3 }: { rows?: number }) {
  return (
    <Group>
      {Array.from({ length: rows }, (_, i) => (
        <ListRow key={i}>
          <span className="grid flex-1 gap-2 py-1">
            <Skeleton className="h-3.5 w-3/5" />
            <Skeleton className="h-3 w-2/5" />
          </span>
        </ListRow>
      ))}
    </Group>
  )
}

export function EmptyState({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="grid justify-items-center gap-1 rounded-xl border border-dashed px-6 py-10 text-center">
      <p className="text-sm font-medium">{title}</p>
      {children !== undefined && <div className="max-w-sm text-ui text-muted-foreground">{children}</div>}
    </div>
  )
}

/** An inline error line: what went wrong, in the tone of a failure. */
export function ErrorText({ children }: { children: ReactNode }) {
  return <p className="text-ui text-destructive-text [overflow-wrap:anywhere]">{children}</p>
}

/** The page's title: one size step up, semibold, tight; the sub line carries status and context. */
export function PageTitle({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <header className="grid gap-1">
      <h1 className="text-2xl leading-tight font-semibold tracking-tight">{children}</h1>
      {sub !== undefined && <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">{sub}</div>}
    </header>
  )
}

/**
 * Advanced detail kept out of the main path (0x addresses, 7702, delegation, raw allowance): a native disclosure, so
 * it works without script and tests can find it by its summary text.
 */
export function Details({ summary, children, className, open }: { summary: ReactNode; children: ReactNode; className?: string; open?: boolean }) {
  return (
    <details open={open} className={cn('group/details rounded-xl bg-card ring-1 ring-foreground/10', className)}>
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-4 text-sm font-medium select-none pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden className="size-4 text-muted-foreground transition-transform duration-(--dur-fast) group-open/details:rotate-90" />
        {summary}
      </summary>
      <div className="grid gap-3 px-4 pt-1 pb-4">{children}</div>
    </details>
  )
}

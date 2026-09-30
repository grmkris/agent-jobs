/**
 * Hireling's primitives: Apple-style inset grouped sections, rows, pills, buttons and fields, all drawn from the
 * tokens in styles.css (light and dark follow the system). Pages compose these; they carry no colours of their own.
 */
import { type ClassValue, clsx } from 'clsx'
import { Check, Copy, ExternalLink, Loader2 } from 'lucide-react'
import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes, useState } from 'react'
import { twMerge } from 'tailwind-merge'
import { amount as formatAmount } from '../format.ts'
import { explorer } from '../wallet.ts'

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs))

type ButtonVariant = 'primary' | 'tinted' | 'gray' | 'danger' | 'destructive' | 'plain' | 'outline'

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
      {...props}
      disabled={busy === true || props.disabled}
      className={cn(
        'press inline-flex items-center justify-center gap-2 font-semibold select-none disabled:pointer-events-none disabled:opacity-40',
        size === 'sm' && 'min-h-8 rounded-lg px-3 text-sm',
        size === 'md' && 'min-h-11 rounded-xl px-4 text-[0.95rem] sm:min-h-10',
        size === 'lg' && 'min-h-[3.125rem] rounded-2xl px-5 text-base',
        variant === 'primary' && 'bg-tint text-on-tint',
        variant === 'tinted' && 'bg-tint/14 text-tint',
        (variant === 'gray' || variant === 'outline') && 'bg-fill text-label',
        variant === 'danger' && 'bg-bad-bg text-bad',
        variant === 'destructive' && 'bg-bad text-white',
        variant === 'plain' && 'min-h-0 px-0 font-medium text-tint',
        className,
      )}
    >
      {busy === true && <Loader2 aria-hidden className="size-4 animate-spin" />}
      {children}
    </button>
  )
}

/** A titled block: an uppercase header above an inset grouped surface, and an optional footnote below it. */
export function Section({ title, note, children, className, action }: { title?: ReactNode; note?: ReactNode; children: ReactNode; className?: string; action?: ReactNode }) {
  return (
    <section className={cn('grid min-w-0 content-start gap-1.5', className)}>
      {(title !== undefined || action !== undefined) && (
        <div className="flex items-baseline justify-between gap-3 px-4">
          {title !== undefined && <h2 className="text-[0.8rem] font-medium tracking-wide text-label-2 uppercase">{title}</h2>}
          {action}
        </div>
      )}
      {children}
      {note !== undefined && <p className="px-4 text-[0.8rem] leading-snug text-label-2">{note}</p>}
    </section>
  )
}

/** The inset grouped surface: rows inside it are separated by hairlines that start at the text, as in Settings. */
export function Group({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('overflow-hidden rounded-xl bg-surface', className)}>{children}</div>
}

const ROW_SEP = "relative before:absolute before:top-0 before:right-0 before:left-4 before:border-t-[0.5px] before:border-sep first:before:hidden before:content-['']"

/**
 * The classes of a Group row, for a row that is itself a link (`<Link className={rowClass({ interactive: true })}>`):
 * links and rows must be siblings in the Group for the hairlines to fall between them. `inset` starts the hairline
 * after a leading avatar.
 */
export const rowClass = ({ inset = false, interactive = false }: { inset?: boolean; interactive?: boolean } = {}) =>
  cn(ROW_SEP, inset && 'before:left-15', 'flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left', interactive && 'active:bg-fill [@media(hover:hover)]:hover:bg-fill')

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
    <div className={cn(ROW_SEP, '-mx-4 flex min-h-11 items-center justify-between gap-4 px-4 py-2 text-[0.95rem] first:-mt-2 last:-mb-2')}>
      <span className="min-w-0">
        <span className="text-label">{label}</span>
        {hint !== undefined && <span className="block text-[0.78rem] text-label-3">{hint}</span>}
      </span>
      <span className="min-w-0 text-right text-label-2 [overflow-wrap:anywhere]">{children}</span>
    </div>
  )
}

export type Tone = 'info' | 'attention' | 'success' | 'danger' | 'neutral'
const LEGACY: Record<string, Tone> = { green: 'success', red: 'danger', amber: 'attention', blue: 'info', gray: 'neutral' }
const TONE: Record<Tone, string> = {
  info: 'bg-info-bg text-info',
  attention: 'bg-warn-bg text-warn',
  success: 'bg-ok-bg text-ok',
  danger: 'bg-bad-bg text-bad',
  neutral: 'bg-gray-bg text-gray',
}

/** A status pill. Tones are semantic (not the tint): info, attention, success, danger, neutral. */
export function Badge({ tone = 'neutral', children, className }: { tone?: Tone | keyof typeof LEGACY; children: ReactNode; className?: string }) {
  const t = LEGACY[tone] ?? (tone as Tone)
  return <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[0.74rem] font-semibold whitespace-nowrap', TONE[t], className)}>{children}</span>
}

/** Marks sample or example content where it must not pass for real data. */
export function Tag({ children }: { children: ReactNode }) {
  return <span className="rounded-md border border-sep px-1.5 text-[0.66rem] font-bold tracking-wider text-label-3 uppercase">{children}</span>
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
      className={cn('inline-grid size-7 shrink-0 place-items-center rounded-lg text-label-3 active:bg-fill [@media(hover:hover)]:hover:text-label', done && 'text-ok', className)}
    >
      {done ? <Check className="size-3.5" strokeWidth={3} /> : <Copy className="size-3.5" />}
    </button>
  )
}

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

/** An address: shortened, linked to the explorer, copyable. */
export function Address({ value, you = false }: { value: string | null | undefined; you?: boolean }) {
  if (value === null || value === undefined) return <span className="text-label-3">—</span>
  return (
    <span className="inline-flex min-w-0 max-w-full flex-wrap items-center justify-end gap-0.5 font-mono text-[0.82rem]">
      <a href={explorer('address', value)} target="_blank" rel="noreferrer" className="text-label-2 hover:text-label">
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
    <a href={explorer('tx', hash)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-[0.8rem] text-tint">
      {label ?? `${hash.slice(0, 10)}…`}
      <ExternalLink aria-hidden className="size-3" />
    </a>
  )
}

/** An amount in a token, with tabular figures. */
export function Amount({ value, token, className }: { value: string | null | undefined; token: string | null | undefined; className?: string }) {
  return <span className={cn('tabular font-semibold whitespace-nowrap', className)}>{formatAmount(value, token)}</span>
}

const FIELD = 'w-full min-w-0 rounded-lg bg-fill px-3 py-2 text-[0.95rem] outline-none focus:ring-2 focus:ring-tint/40'

export function Field({ label, children, hint, className }: { label: ReactNode; children: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <label className={cn('grid gap-1.5', className)}>
      <span className="text-[0.82rem] text-label-2">{label}</span>
      {children}
      {hint !== undefined && <span className="text-[0.78rem] text-label-3">{hint}</span>}
    </label>
  )
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(FIELD, className)} />
}

export function TextArea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cn(FIELD, 'min-h-24 leading-relaxed', className)} />
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={cn(FIELD, 'appearance-auto pr-8', className)}>
      {children}
    </select>
  )
}

/** The iOS segmented control. */
export function Segmented<T extends string>({ value, options, onChange, className, label }: { value: T; options: ReadonlyArray<readonly [T, ReactNode]>; onChange: (v: T) => void; className?: string; label?: string }) {
  return (
    <div role="radiogroup" aria-label={label} className={cn('grid auto-cols-fr grid-flow-col gap-0.5 rounded-[10px] bg-fill p-0.5', className)}>
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={cn('rounded-lg px-2 py-1.5 text-[0.85rem] font-medium whitespace-nowrap transition-colors', value === v ? 'bg-surface font-semibold shadow-[0_1px_3px_rgba(0,0,0,0.12)]' : 'text-label')}
        >
          {text}
        </button>
      ))}
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cn('block animate-pulse rounded-md bg-fill', className ?? 'h-4 w-full')} />
}

/** Rows of placeholder while a list loads, so loading never reads as "empty". */
export function LoadingRows({ rows = 3 }: { rows?: number }) {
  return (
    <Group>
      {Array.from({ length: rows }, (_, i) => (
        <ListRow key={i}>
          <span className="grid flex-1 gap-2 py-1">
            <Skeleton className="h-4 w-3/5" />
            <Skeleton className="h-3 w-2/5" />
          </span>
        </ListRow>
      ))}
    </Group>
  )
}

export function EmptyState({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="grid justify-items-center gap-1 rounded-xl bg-surface px-6 py-8 text-center">
      <p className="font-semibold">{title}</p>
      {children !== undefined && <div className="max-w-sm text-[0.9rem] text-label-2">{children}</div>}
    </div>
  )
}

/** An inline error line: what went wrong, in the tone of a failure. */
export function ErrorText({ children }: { children: ReactNode }) {
  return <p className="text-[0.88rem] text-bad [overflow-wrap:anywhere]">{children}</p>
}

/** The page's large title, Apple-style (tight tracking, balanced wrap). */
export function PageTitle({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <header className="grid gap-1.5">
      <h1 className="font-display text-[2rem] leading-[1.12] font-bold tracking-[-0.022em]">{children}</h1>
      {sub !== undefined && <div className="flex flex-wrap items-center gap-2 text-[0.9rem] text-label-2">{sub}</div>}
    </header>
  )
}

import { type ClassValue, clsx } from 'clsx'
import { Copy, ExternalLink, Loader2 } from 'lucide-react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { twMerge } from 'tailwind-merge'
import { explorer } from '../wallet.ts'

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs))

export function Button({ busy, className, children, variant = 'primary', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean; variant?: 'primary' | 'outline' | 'danger' }) {
  return (
    <button
      {...props}
      disabled={busy === true || props.disabled}
      className={cn(
        'inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-50',
        variant === 'primary' && 'bg-neutral-900 text-white hover:bg-neutral-700',
        variant === 'outline' && 'border border-neutral-300 bg-white hover:bg-neutral-100',
        variant === 'danger' && 'bg-red-600 text-white hover:bg-red-500',
        className,
      )}
    >
      {busy === true && <Loader2 className="size-4 animate-spin" />}
      {children}
    </button>
  )
}

export function Card({ title, children, className }: { title?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-lg border border-neutral-200 bg-white p-4 shadow-sm', className)}>
      {title !== undefined && <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">{title}</h2>}
      {children}
    </section>
  )
}

const TONES: Record<string, string> = {
  green: 'bg-emerald-100 text-emerald-800',
  red: 'bg-red-100 text-red-800',
  amber: 'bg-amber-100 text-amber-800',
  blue: 'bg-sky-100 text-sky-800',
  gray: 'bg-neutral-100 text-neutral-700',
}

export function Badge({ tone = 'gray', children }: { tone?: keyof typeof TONES; children: ReactNode }) {
  return <span className={cn('inline-flex rounded px-2 py-0.5 text-xs font-medium', TONES[tone])}>{children}</span>
}

export function statusTone(status: string): keyof typeof TONES {
  if (status === 'completed') return 'green'
  if (['rejected', 'expired', 'cancelled'].includes(status)) return 'red'
  if (['disputed', 'rejected-pending'].includes(status)) return 'amber'
  if (['open', 'active', 'submitted', 'awarded'].includes(status)) return 'blue'
  return 'gray'
}

/** The address component used wherever an address appears: shortened, copyable, linked to the explorer. */
export function Address({ value }: { value: string | null | undefined }) {
  if (value === null || value === undefined) return <span className="text-neutral-400">—</span>
  return (
    <span className="inline-flex items-center gap-1 font-mono text-xs">
      <a href={explorer('address', value)} target="_blank" rel="noreferrer" className="hover:underline">
        {value.slice(0, 6)}…{value.slice(-4)}
      </a>
      <button type="button" title="Copy" onClick={() => void navigator.clipboard.writeText(value)} className="text-neutral-400 hover:text-neutral-700">
        <Copy className="size-3" />
      </button>
    </span>
  )
}

export function TxLink({ hash, label }: { hash: string | null | undefined; label?: string }) {
  if (hash === null || hash === undefined) return null
  return (
    <a href={explorer('tx', hash)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-xs text-sky-700 hover:underline">
      {label ?? `${hash.slice(0, 10)}…`}
      <ExternalLink className="size-3" />
    </a>
  )
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-neutral-100 py-1.5 text-sm last:border-0">
      <span className="text-neutral-500">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  )
}

/**
 * Sheets and toasts. A sheet is a native modal <dialog> (top layer, focus trapped, Escape closes, the page behind
 * is inert): a bottom sheet on a phone that follows the finger and is flicked away with momentum, a centred panel on
 * a wider screen. Decisions that move money go through `ConfirmSheet`, which says what will happen before it does.
 */
import { X } from 'lucide-react'
import { type ReactNode, createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { Button, cn } from './ui.tsx'

/** Apple's momentum projection: where a flick released at `velocity` px/s comes to rest. */
const project = (velocity: number, decelerationRate = 0.998) => ((velocity / 1000) * decelerationRate) / (1 - decelerationRate)

export function Sheet({ open, onClose, title, children, className }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const drag = useRef<{ start: number; y: number; t: number; v: number } | null>(null)
  const [dy, setDy] = useState(0)

  useEffect(() => {
    const d = ref.current
    if (d === null) return
    if (open && !d.open) {
      setDy(0)
      d.showModal()
    } else if (!open && d.open) d.close()
  }, [open])

  const onPointerDown = (e: React.PointerEvent) => {
    if (window.matchMedia('(min-width: 640px)').matches) return
    ;(e.target as Element).setPointerCapture(e.pointerId)
    drag.current = { start: e.clientY, y: e.clientY, t: e.timeStamp, v: 0 }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const g = drag.current
    if (g === null) return
    const dt = Math.max(1, e.timeStamp - g.t)
    g.v = ((e.clientY - g.y) / dt) * 1000
    g.y = e.clientY
    g.t = e.timeStamp
    const offset = e.clientY - g.start
    // Upward past the resting point resists (rubber band); downward follows the finger 1:1.
    setDy(offset >= 0 ? offset : -Math.sqrt(-offset) * 2)
  }
  const onPointerUp = () => {
    const g = drag.current
    drag.current = null
    if (g === null) return
    const height = panel.current?.offsetHeight ?? 400
    const rest = g.y - g.start + project(g.v)
    if (rest > height * 0.45) onClose()
    else setDy(0)
  }

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClick={(e) => {
        // A click on the dialog itself (not its panel) is a click on the backdrop.
        if (e.target === ref.current) onClose()
      }}
      className="fixed inset-0 m-0 h-full max-h-none w-full max-w-none bg-transparent p-0 backdrop:bg-scrim sm:open:grid sm:open:place-items-center"
    >
      <div
        ref={panel}
        style={{ transform: dy === 0 ? undefined : `translateY(${dy}px)`, transition: drag.current === null ? undefined : 'none' }}
        className={cn(
          'absolute inset-x-0 bottom-0 grid max-h-[90vh] gap-4 overflow-y-auto rounded-t-2xl bg-surface px-5 pt-2 pb-[calc(1.25rem+var(--safe-bottom))] text-label shadow-float',
          'animate-[sheet-in_0.42s_var(--ease-spring)] transition-transform duration-300 ease-(--ease-spring)',
          'sm:relative sm:inset-auto sm:w-[30rem] sm:max-w-[calc(100vw-2rem)] sm:rounded-2xl sm:px-6 sm:pt-5 sm:pb-6 sm:animate-[panel-in_0.3s_var(--ease-spring)]',
          className,
        )}
      >
        <div onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} className="-mx-5 cursor-grab touch-none px-5 pt-1 pb-1 sm:hidden">
          <div className="mx-auto h-1.5 w-9 rounded-full bg-fill-strong" />
        </div>
        {title !== undefined && (
          <div className="flex items-start justify-between gap-3">
            <h2 className="font-display text-[1.3rem] leading-tight font-bold tracking-[-0.015em]">{title}</h2>
            <button type="button" aria-label="Close" onClick={onClose} className="grid size-8 shrink-0 place-items-center rounded-full bg-fill text-label-2">
              <X className="size-4" />
            </button>
          </div>
        )}
        {children}
      </div>
    </dialog>
  )
}

/**
 * "Approve and pay?": what will happen, then one clear confirm and a way out. `tone: 'destructive'` for actions that
 * take something away (reject, cancel, revoke).
 */
export function ConfirmSheet({
  open,
  onClose,
  title,
  description,
  children,
  confirm,
  onConfirm,
  tone = 'primary',
  busy,
  disabled,
  cancelLabel = 'Cancel',
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  confirm: ReactNode
  onConfirm: () => void
  tone?: 'primary' | 'destructive'
  busy?: boolean
  disabled?: boolean
  cancelLabel?: string
}) {
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      {description !== undefined && <div className="-mt-2 leading-snug text-label-2">{description}</div>}
      {children}
      <div className="grid gap-2">
        <Button size="lg" variant={tone === 'destructive' ? 'destructive' : 'primary'} busy={busy} disabled={disabled} onClick={onConfirm}>
          {confirm}
        </Button>
        <Button size="lg" variant="gray" onClick={onClose}>
          {cancelLabel}
        </Button>
      </div>
    </Sheet>
  )
}

type Toast = { id: number; text: ReactNode; tone: 'success' | 'error' }
const ToastContext = createContext<(text: ReactNode, tone?: Toast['tone']) => void>(() => undefined)

/** `useToast()('Paid 4 mUSD to Agent #1942')`: a short, non-blocking confirmation at the top of the screen. */
export const useToast = () => useContext(ToastContext)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const push = useCallback((text: ReactNode, tone: Toast['tone'] = 'success') => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, text, tone }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 6000 : 3200)
  }, [])
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div aria-live="polite" role="status" className="pointer-events-none fixed inset-x-0 top-[calc(0.75rem+var(--safe-top))] z-50 grid justify-items-center gap-2 px-4">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              'pointer-events-auto flex max-w-md animate-[toast-in_0.45s_var(--ease-spring)] items-center gap-2.5 rounded-full bg-surface px-4 py-2.5 text-[0.92rem] font-medium shadow-float',
              t.tone === 'error' && 'text-bad',
            )}
          >
            <span className={cn('grid size-5 shrink-0 place-items-center rounded-full text-[0.7rem] font-bold text-white', t.tone === 'error' ? 'bg-bad' : 'bg-ok')}>{t.tone === 'error' ? '!' : '✓'}</span>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

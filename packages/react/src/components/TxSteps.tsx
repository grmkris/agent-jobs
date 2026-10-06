import { useState } from 'react'
import { useSidequest } from '../provider.tsx'
import type { SendProgress } from '../send.ts'
import type { TxRequest } from '../types.ts'

/**
 * The transactions a board tool returned, sent from the host's wallet with one click (batched when the host can) and
 * reported to the board. Unstyled apart from class names (`aj-txsteps`, `aj-txsteps-step`, `aj-txsteps-button`,
 * `aj-txsteps-error`) so a host's stylesheet decides how it looks.
 */
export function TxSteps({ taskId, txs, onDone, label, explorerTx }: { taskId: string; txs: TxRequest[]; onDone?: (hashes: string[]) => void; label?: string; explorerTx?: (hash: string) => string }) {
  const { sender } = useSidequest()
  const [progress, setProgress] = useState<SendProgress[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const done = progress.length > 0 && (progress.length === txs.length || progress.some((p) => p.description.includes(' + ')))
  return (
    <div className="aj-txsteps">
      <ol>
        {txs.map((tx, i) => {
          const p = progress.find((x) => x.index === i) ?? (progress[0]?.description.includes(' + ') ? progress[0] : undefined)
          return (
            <li key={`${tx.to}-${i}`} className="aj-txsteps-step" data-done={p !== undefined}>
              {i + 1}. {tx.description}
              {p !== undefined && (explorerTx === undefined ? <span> ✓ {p.hash.slice(0, 10)}…</span> : <a href={explorerTx(p.hash)} target="_blank" rel="noreferrer"> ✓ {p.hash.slice(0, 10)}…</a>)}
            </li>
          )
        })}
      </ol>
      {!done && (
        <button
          type="button"
          className="aj-txsteps-button"
          disabled={busy || sender === null}
          onClick={async () => {
            if (sender === null) return
            setBusy(true)
            setError(null)
            try {
              const hashes = await sender.send(taskId, txs, (p) => setProgress((s) => [...s, p]))
              onDone?.(hashes)
            } catch (e) {
              setError((e as Error).message.split('\n')[0] ?? 'failed')
            } finally {
              setBusy(false)
            }
          }}
        >
          {busy ? 'Confirming…' : (label ?? (txs.length === 1 ? 'Confirm' : `Confirm ${txs.length} steps`))}
        </button>
      )}
      {sender === null && <p className="aj-txsteps-error">Connect a wallet to continue.</p>}
      {error !== null && <p className="aj-txsteps-error">{error}</p>}
    </div>
  )
}

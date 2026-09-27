import { useState } from 'react'
import { useAccount, useSendTransaction, useSwitchChain } from 'wagmi'
import { waitForTransactionReceipt } from 'wagmi/actions'
import { type TxRequest, tool } from '../api.ts'
import { chain, wagmiConfig } from '../wallet.ts'
import { Button, TxLink } from './ui.tsx'

/**
 * The transactions a board tool returned, as separate steps (switch network → approve → execute), each with its
 * own loader; every confirmed transaction is reported back so the board reconciles from the chain.
 */
export function TxSteps({ taskId, txs, onDone }: { taskId: string; txs: TxRequest[]; onDone: () => void }) {
  const { chainId } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const { sendTransactionAsync } = useSendTransaction()
  const [sent, setSent] = useState<string[]>([])
  const [busy, setBusy] = useState<number | 'switch' | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (chainId !== chain.id) {
    return (
      <Button busy={busy === 'switch'} onClick={async () => {
        setBusy('switch')
        try { await switchChainAsync({ chainId: chain.id }) } catch (e) { setError((e as Error).message.split('\n')[0] ?? '') } finally { setBusy(null) }
      }}>
        Switch to Monad testnet
      </Button>
    )
  }
  const next = sent.length
  return (
    <ol className="space-y-2">
      {txs.map((tx, i) => (
        <li key={`${tx.to}-${tx.data.slice(0, 10)}-${i}`} className="flex items-center gap-3 text-sm">
          <span className="w-5 text-neutral-400">{i + 1}.</span>
          {i < next ? (
            <span className="flex items-center gap-2 text-emerald-700">✓ {tx.description} <TxLink hash={sent[i]} /></span>
          ) : (
            <Button
              variant={i === next ? 'primary' : 'outline'}
              disabled={i !== next}
              busy={busy === i}
              onClick={async () => {
                setBusy(i)
                setError(null)
                try {
                  const hash = await sendTransactionAsync({ to: tx.to, data: tx.data, value: 0n, chainId: chain.id })
                  const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId: chain.id })
                  if (receipt.status !== 'success') throw new Error(`reverted: ${hash}`)
                  await tool('report_transaction', { taskId, txHash: hash })
                  setSent((s) => [...s, hash])
                  if (i === txs.length - 1) onDone()
                } catch (e) {
                  setError((e as Error).message.split('\n')[0] ?? 'failed')
                } finally {
                  setBusy(null)
                }
              }}
            >
              {tx.description}
            </Button>
          )}
        </li>
      ))}
      {error !== null && <li className="text-xs text-red-600">{error}</li>}
    </ol>
  )
}

import { useState } from 'react'
import { useAccount, useSendTransaction, useSwitchChain } from 'wagmi'
import { waitForTransactionReceipt } from 'wagmi/actions'
import { type TxRequest, tool } from '../api.ts'
import { chain, wagmiConfig } from '../wallet.ts'
import { usePrivyBatch } from './Privy.tsx'
import { Button, TxLink } from './ui.tsx'

/**
 * The transactions a board tool returned. From the Privy embedded wallet, several go out as one EIP-7702 batch with
 * one confirmation; otherwise (or on request) as separate steps (switch network → approve → execute), each with its
 * own loader. Every confirmed transaction is reported back so the board reconciles from the chain.
 */
export function TxSteps({ taskId, txs, onDone }: { taskId: string; txs: TxRequest[]; onDone: (hashes: string[]) => void }) {
  const { chainId, address } = useAccount()
  const batch = usePrivyBatch(address)
  const [oneByOne, setOneByOne] = useState(false)
  const [batched, setBatched] = useState<string | null>(null)
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
        Switch to {chain.name}
      </Button>
    )
  }
  if (batch !== null && txs.length > 1 && !oneByOne) {
    return (
      <div className="space-y-2 text-sm">
        <ol className="space-y-1 text-label-2">
          {txs.map((tx, i) => <li key={`${tx.to}-${i}`}>{i + 1}. {tx.description}</li>)}
        </ol>
        {batched !== null ? (
          <p className="flex items-center gap-2 text-ok">✓ all {txs.length} in one transaction <TxLink hash={batched} /></p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              busy={busy === 0}
              onClick={async () => {
                setBusy(0)
                setError(null)
                try {
                  const hash = await batch(txs)
                  const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId: chain.id })
                  if (receipt.status !== 'success') throw new Error(`reverted: ${hash} (none of the steps happened)`)
                  await tool('report_transaction', { taskId, txHash: hash })
                  setBatched(hash)
                  onDone([hash])
                } catch (e) {
                  setError((e as Error).message.split('\n')[0] ?? 'failed')
                } finally {
                  setBusy(null)
                }
              }}
            >
              Confirm all {txs.length} as one transaction
            </Button>
            <button type="button" className="text-xs text-label-2 underline" onClick={() => setOneByOne(true)}>one at a time</button>
          </div>
        )}
        {error !== null && <p className="text-xs text-bad">{error}</p>}
      </div>
    )
  }
  const next = sent.length
  return (
    <ol className="space-y-2">
      {txs.map((tx, i) => (
        <li key={`${tx.to}-${tx.data.slice(0, 10)}-${i}`} className="flex items-center gap-3 text-sm">
          <span className="w-5 text-label-3">{i + 1}.</span>
          {i < next ? (
            <span className="flex items-center gap-2 text-ok">✓ {tx.description} <TxLink hash={sent[i]} /></span>
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
                  if (i === txs.length - 1) onDone([...sent, hash])
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
      {error !== null && <li className="text-xs text-bad">{error}</li>}
    </ol>
  )
}

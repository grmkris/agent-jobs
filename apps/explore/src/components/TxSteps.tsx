import { Check, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Hex } from 'viem'
import { useAccount, useSendTransaction, useSwitchChain } from 'wagmi'
import { waitForTransactionReceipt } from 'wagmi/actions'
import { type TxRequest, tool } from '../api.ts'
import { friendlyError } from '../txErrors.ts'
import { chain, wagmiConfig } from '../wallet.ts'
import { usePrivyBatch } from './Privy.tsx'
import { Button, ErrorText, Group, ListRow, TxLink, cn } from './ui.tsx'

type Status =
  | { at: 'idle' }
  | { at: 'signing' }
  | { at: 'sent'; hash: Hex }
  | { at: 'confirmed'; hash: Hex; reportError?: string }
  | { at: 'recorded'; hash: Hex }
  | { at: 'failed'; error: string; hash?: Hex }

/**
 * What was handed to the wallet, kept before and after each send (AGENTS.md: persist an operation record before a
 * money-moving call and reconcile before retrying): the hashes the wallet returned, whether the board has recorded
 * them, and a step handed to the wallet whose hash never came back (the page closed while it was open).
 */
interface OpRecord {
  batch: boolean
  hashes: Array<Hex | null>
  recorded: boolean[]
  pending: number | null
}

function fnv(s: string): string {
  let x = 0x811c9dc5
  for (const c of s) x = Math.imul(x ^ c.charCodeAt(0), 0x01000193)
  return (x >>> 0).toString(36)
}
const keyOf = (taskId: string, txs: TxRequest[]) => `hireling.op:${taskId}:${fnv(txs.map((t) => `${t.to}:${t.data}`).join('|'))}`
function load(key: string): OpRecord | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') as OpRecord | null
  } catch {
    return null
  }
}
function save(key: string, r: OpRecord | null) {
  try {
    if (r === null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(r))
  } catch {
    // storage blocked: the record lasts as long as this component
  }
}

const LABEL: Record<Status['at'], string> = {
  idle: '',
  signing: 'Confirm in your wallet…',
  sent: 'Sent · waiting for Monad…',
  confirmed: 'Confirmed · recording…',
  recorded: 'Done',
  failed: '',
}

/**
 * The transactions a board tool returned, from the wallet to the chain and back to the board. From the Privy wallet
 * several go out as one transaction (EIP-7702 batch) with one confirmation; otherwise one at a time. Each step shows
 * where it is (confirm in wallet, sent, confirmed, recorded); failures say what happened in plain words; a failed
 * report is retried without sending again; and a reload picks up a sent transaction instead of offering to resend.
 */
export function TxSteps({ taskId, txs, onDone }: { taskId: string; txs: TxRequest[]; onDone: (hashes: string[]) => void }) {
  const { chainId, address } = useAccount()
  const batch = usePrivyBatch(address)
  const { switchChainAsync } = useSwitchChain()
  const { sendTransactionAsync } = useSendTransaction()
  const key = keyOf(taskId, txs)
  const [record, setRecord] = useState<OpRecord>(() => load(key) ?? { batch: batch !== null && txs.length > 1, hashes: [], recorded: [], pending: null })
  const [status, setStatus] = useState<Status[]>(() =>
    (record.batch ? [txs[0] as TxRequest] : txs).map((_, i): Status => {
      const h = record.hashes[i]
      if (h === null || h === undefined) return { at: 'idle' }
      return record.recorded[i] === true ? { at: 'recorded', hash: h } : { at: 'sent', hash: h }
    }),
  )
  const [switching, setSwitching] = useState<string | null>(null)
  const [acceptPending, setAcceptPending] = useState(false)
  const done = useRef(false)

  const commit = (r: OpRecord) => {
    setRecord(r)
    save(key, r)
  }
  const set = (i: number, s: Status) => setStatus((all) => all.map((x, j) => (j === i ? s : x)))

  /** Waits for a sent hash, then has the board record it; used after a send and after a reload. */
  const settle = async (i: number, hash: Hex, r: OpRecord) => {
    try {
      const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId: chain.id })
      if (receipt.status !== 'success') {
        set(i, { at: 'failed', hash, error: record.batch ? 'The transaction reverted, so none of the steps happened.' : 'The transaction reverted, so nothing changed.' })
        return
      }
    } catch (e) {
      set(i, { at: 'failed', hash, error: friendlyError(e) })
      return
    }
    await report(i, hash, r)
  }
  const report = async (i: number, hash: Hex, r: OpRecord) => {
    set(i, { at: 'confirmed', hash })
    try {
      await tool('report_transaction', { taskId, txHash: hash })
      const next = { ...r, recorded: Object.assign([...r.recorded], { [i]: true }) }
      commit(next)
      set(i, { at: 'recorded', hash })
    } catch (e) {
      set(i, { at: 'confirmed', hash, reportError: `On the chain, but the board did not record it: ${friendlyError(e)}` })
    }
  }

  // Privy's wallet may become ready after the first render: offer the batch as long as nothing has started.
  const started = status.some((x) => x.at !== 'idle')
  useEffect(() => {
    if (batch !== null && txs.length > 1 && !record.batch && !started && load(key) === null) {
      setRecord({ ...record, batch: true })
      setStatus([{ at: 'idle' }])
    }
  }, [batch !== null])

  // After a reload: follow any sent transaction to the end instead of offering to send it again.
  useEffect(() => {
    status.forEach((s, i) => {
      if (s.at === 'sent') void settle(i, s.hash, record)
    })
  }, [])

  const steps = record.batch ? 1 : txs.length
  const allDone = status.length === steps && status.every((s) => s.at === 'recorded')
  useEffect(() => {
    if (!allDone || done.current) return
    done.current = true
    save(key, null)
    onDone(status.flatMap((s) => (s.at === 'recorded' ? [s.hash] : [])))
  }, [allDone])

  const run = async (i: number) => {
    const withPending = { ...record, pending: i }
    commit(withPending)
    set(i, { at: 'signing' })
    let hash: Hex
    try {
      if (record.batch) {
        if (batch === null) throw new Error('This wallet cannot send a batch; send them one at a time.')
        hash = await batch(txs)
      } else {
        const tx = txs[i] as TxRequest
        hash = await sendTransactionAsync({ to: tx.to, data: tx.data, value: 0n, chainId: chain.id })
      }
    } catch (e) {
      commit({ ...record, pending: null })
      set(i, { at: 'failed', error: friendlyError(e) })
      return
    }
    const sent = { ...withPending, pending: null, hashes: Object.assign([...record.hashes], { [i]: hash }) }
    commit(sent)
    set(i, { at: 'sent', hash })
    await settle(i, hash, sent)
  }

  if (chainId !== chain.id) {
    return (
      <div className="grid gap-2">
        <Button
          busy={switching === ''}
          onClick={async () => {
            setSwitching('')
            try {
              await switchChainAsync({ chainId: chain.id })
              setSwitching(null)
            } catch (e) {
              setSwitching(friendlyError(e))
            }
          }}
        >
          Switch your wallet to {chain.name}
        </Button>
        {switching !== null && switching !== '' && <ErrorText>{switching}</ErrorText>}
      </div>
    )
  }

  const next = status.findIndex((s) => s.at !== 'recorded')
  const current = status[next]
  const busy = current !== undefined && (current.at === 'signing' || current.at === 'sent' || (current.at === 'confirmed' && current.reportError === undefined))
  const rows = record.batch ? [{ description: txs.map((t) => t.description).join(', then ') }] : txs

  return (
    <div className="grid gap-3">
      {record.pending !== null && !acceptPending && (
        <div className="rounded-xl bg-warn-bg px-4 py-3 text-[0.9rem] text-warn">
          An earlier attempt was handed to your wallet and the page closed before it answered, so it may already have been sent. Check your wallet’s activity first.{' '}
          <button type="button" className="font-semibold underline" onClick={() => setAcceptPending(true)}>
            It was not sent
          </button>
        </div>
      )}
      <Group>
        {rows.map((tx, i) => {
          const s = status[i] ?? { at: 'idle' }
          return (
            <ListRow key={`${i}-${tx.description}`} inset>
              <StepIcon n={record.batch ? txs.length : i + 1} s={s} />
              <span className="min-w-0 flex-1">
                <span className={cn('block text-[0.95rem] first-letter:uppercase', s.at === 'idle' && i !== next && 'text-label-2')}>{tx.description}</span>
                {(s.at !== 'idle' || record.batch) && (
                  <span className="flex flex-wrap items-center gap-x-2 text-[0.8rem] text-label-2">
                    {record.batch && s.at === 'idle' ? `${txs.length} steps as one transaction` : LABEL[s.at]}
                    {'hash' in s && s.hash !== undefined && <TxLink hash={s.hash} />}
                  </span>
                )}
              </span>
            </ListRow>
          )
        })}
      </Group>
      {current?.at === 'failed' && <ErrorText>{current.error}</ErrorText>}
      {current?.at === 'confirmed' && current.reportError !== undefined && <ErrorText>{current.reportError}</ErrorText>}
      {!allDone && current !== undefined && (
        <Button
          size="lg"
          busy={busy}
          disabled={record.pending !== null && !acceptPending}
          onClick={() => {
            if (current.at === 'confirmed' && current.reportError !== undefined) void report(next, current.hash, record)
            else void run(next)
          }}
        >
          {current.at === 'confirmed' && current.reportError !== undefined
            ? 'Record it again'
            : current.at === 'failed'
              ? 'Try again'
              : record.batch
                ? `Confirm ${txs.length > 1 ? `all ${txs.length} as one transaction` : ''}`.trim()
                : txs.length > 1
                  ? `Confirm step ${next + 1} of ${txs.length}`
                  : 'Confirm in your wallet'}
        </Button>
      )}
      {record.batch && !started && (
        <Button
          variant="plain"
          size="sm"
          onClick={() => {
            setRecord({ ...record, batch: false })
            setStatus(txs.map((): Status => ({ at: 'idle' })))
          }}
          className="justify-self-center"
        >
          Send them one at a time instead
        </Button>
      )}
    </div>
  )
}

function StepIcon({ n, s }: { n: number; s: Status }) {
  if (s.at === 'recorded') {
    return (
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-ok text-white">
        <Check aria-hidden className="size-3.5" strokeWidth={3} />
      </span>
    )
  }
  if (s.at === 'failed') {
    return (
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-bad text-white">
        <X aria-hidden className="size-3.5" strokeWidth={3} />
      </span>
    )
  }
  if (s.at === 'signing' || s.at === 'sent' || s.at === 'confirmed') {
    return <span aria-hidden className="size-6 shrink-0 animate-spin rounded-full border-[2.5px] border-fill-strong border-t-tint" />
  }
  return <span className="grid size-6 shrink-0 place-items-center rounded-full bg-fill-strong text-[0.75rem] font-semibold text-label-2">{n}</span>
}

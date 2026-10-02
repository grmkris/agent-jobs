import * as sdk from '@agent-jobs/sdk'
import { Check, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Hex } from 'viem'
import { useAccount, useSendTransaction, useSwitchChain } from 'wagmi'
import { getBlock, getBlockNumber, getTransactionCount, waitForTransactionReceipt } from 'wagmi/actions'
import { type TxRequest, boardApi } from '../api.ts'
import { batchGasLimit, gasLimit } from '../gas.ts'
import { hireling } from '../hireling.ts'
import { type SponsorOperation, sponsorApi, sponsorCalls, sponsorKey, sponsorable, submitFailure, useLiveSponsorship } from '../sponsor.ts'
import { friendlyError } from '../txErrors.ts'
import { chain, wagmiConfig } from '../wallet.ts'
import { usePrivyBatch } from './Privy.tsx'
import { useAuth } from './Wallet.tsx'
import { type ChainReads, type Reconciled, type SendSnapshot, type TxStatus, reconcileSend, retryAction, walletRefused } from './txOperation.ts'
import { Button, ErrorText, Group, Input, ListRow, TxLink, cn } from './ui.tsx'

type Status = TxStatus

/**
 * What was handed to the wallet, kept before and after each send (AGENTS.md: persist an operation record before a
 * money-moving call and reconcile before retrying): the hashes the wallet returned, whether the board has recorded
 * them, and a step handed to the wallet whose hash never came back (the page closed while it was open), with the
 * sending account's nonce and the head block read just before, so the chain can say whether that step went out.
 */
interface OpRecord {
  batch: boolean
  hashes: Array<Hex | null>
  recorded: boolean[]
  pending: number | null
  snapshot?: SendSnapshot | null
  from?: Hex | null
  /** Sent through Hireling's relay (B6): no wallet prompt, and one relay transaction carries every step. */
  sponsored?: boolean
  /**
   * A sponsored send asked for: its caller key, and its operation once the board answered. Kept before the request,
   * so a lost answer is reconciled with the same key (the board returns the same send) and never sent anew.
   */
  sponsor?: { key: string; operationId: Hex | null } | null
}

const chainReads = (address: Hex): ChainReads => ({
  nonce: (blockTag) => getTransactionCount(wagmiConfig, { address, blockTag, chainId: chain.id }),
  blockNumber: () => getBlockNumber(wagmiConfig, { chainId: chain.id, cacheTime: 0 }),
  block: (blockNumber) => getBlock(wagmiConfig, { blockNumber, includeTransactions: true, chainId: chain.id }),
})

/** Waits between chain checks after an ambiguous wallet error: a broadcast step is mined within seconds on Monad. */
const RECHECK_MS = [1000, 2000, 3000, 4000, 5000]
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const SPONSORED = {
  lost: 'Hireling’s relay did not answer, so whether it sent these steps is unknown. Check again: the relay never sends the same steps twice.',
  checking: 'Hireling’s relay did not answer. Checking whether it sent these steps…',
  slow: 'Hireling’s relay sent it and Monad has not mined it yet. Check again in a moment.',
}

const UNCERTAIN = {
  legacy: 'The wallet outcome is unknown. Reconcile its transaction hash before continuing.',
  checking: 'Your wallet returned an error without a transaction hash. Checking the chain for this step…',
  pending: 'Your account has a transaction waiting to be mined. Check again in a moment, or paste its hash from your wallet activity; do not send this step again yet.',
  unknown: 'The chain could not confirm whether this step went out. Check again, or paste its hash from your wallet activity; do not send it again yet.',
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

const SPONSORED_LABEL: Partial<Record<Status['at'], string>> = {
  idle: 'Waiting · Hireling pays the gas',
  signing: 'Sending through Hireling…',
  sent: 'Sent by Hireling · waiting for Monad…',
}

const LABEL: Record<Status['at'], string> = {
  idle: 'Waiting',
  signing: 'Confirm in your wallet…',
  uncertain: 'Submission outcome unknown',
  sent: 'Sent · waiting for Monad…',
  confirmed: 'Confirmed · recording…',
  recorded: 'Confirmed',
  failed: 'Failed · retry below',
}

/**
 * The transactions a board tool returned (or the app built, `reportToBoard={false}`), from the wallet to the chain
 * and back to the board. When the signed-in wallet's gas sponsorship covers every step (U7b), Hireling's relay sends
 * them as one transaction with no wallet prompt, and anything it refuses goes from the wallet with the reason. From
 * the Privy wallet several go out as one transaction (EIP-7702 batch) with one confirmation; otherwise one at a
 * time. Each step shows where it is (confirm in wallet, sent, confirmed, recorded); failures say what happened in
 * plain words; a failed report is retried without sending again; and a reload picks up a sent transaction instead of
 * offering to resend.
 */
export function TxSteps({ taskId, txs, onDone, boardId, owner, canSend = true, onBusyChange, onSafeToRestartChange, reportToBoard = true, autoStart = false }: { taskId: string; txs: TxRequest[]; onDone: (hashes: string[]) => void; boardId?: string | undefined; owner?: string | undefined; canSend?: boolean; onBusyChange?: (busy: boolean) => void; onSafeToRestartChange?: (safe: boolean) => void; reportToBoard?: boolean; autoStart?: boolean }) {
  const { chainId, address } = useAccount()
  const auth = useAuth()
  const batch = usePrivyBatch(address)
  const sponsorship = useLiveSponsorship(address, auth.signedIn && auth.address?.toLowerCase() === address?.toLowerCase())
  const canSponsor = sponsorship.live !== null && sponsorable(txs, sponsorship.live, chain.id)
  const { switchChainAsync } = useSwitchChain()
  const { sendTransactionAsync } = useSendTransaction()
  const key = keyOf(taskId, txs)
  const [record, setRecord] = useState<OpRecord>(() => load(key) ?? { batch: batch !== null && txs.length > 1, hashes: [], recorded: [], pending: null })
  const [status, setStatus] = useState<Status[]>(() =>
    (record.batch || record.sponsored === true ? [txs[0] as TxRequest] : txs).map((_, i): Status => {
      const h = record.hashes[i]
      if (h === null || h === undefined) {
        if (record.sponsored === true && record.sponsor != null) return { at: 'uncertain', error: SPONSORED.lost }
        if (record.pending !== i) return { at: 'idle' }
        return record.snapshot != null ? { at: 'uncertain', checking: true, error: UNCERTAIN.checking } : { at: 'uncertain', error: UNCERTAIN.legacy }
      }
      return record.recorded[i] === true ? { at: 'recorded', hash: h } : { at: 'sent', hash: h }
    }),
  )
  const [switching, setSwitching] = useState<string | null>(null)
  const [pendingHash, setPendingHash] = useState('')
  // Why the steps went from the wallet after Hireling was going to pay; once set, the relay is not offered again.
  const [notice, setNotice] = useState<{ text: string; hash?: Hex } | null>(null)
  const [sponsorOff, setSponsorOff] = useState(false)
  const sending = useRef(false)
  const checking = useRef(false)
  const done = useRef(false)

  const commit = (r: OpRecord) => {
    setRecord(r)
    save(key, r)
  }
  const set = (i: number, s: Status) => setStatus((all) => all.map((x, j) => (j === i ? s : x)))

  /** Waits for a sent hash, then has the board record it; used after a send and after a reload. */
  const settle = async (i: number, hash: Hex, r: OpRecord) => {
    if (r.sponsored === true) {
      await settleSponsored(hash, r)
      return
    }
    try {
      const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId: chain.id })
      if (receipt.status !== 'success') {
        set(i, { at: 'failed', hash, reverted: true, error: record.batch ? 'The transaction reverted, so none of the steps happened.' : 'The transaction reverted, so nothing changed.' })
        return
      }
    } catch (e) {
      set(i, { at: 'failed', hash, error: friendlyError(e) })
      return
    }
    await report(i, hash, r)
  }

  /** Steps that will not go through the relay after all: from the wallet, as one batch where it can, with why. */
  const toWallet = (text: string | null, hash?: Hex) => {
    const next: OpRecord = { batch: batch !== null && txs.length > 1, hashes: [], recorded: [], pending: null }
    setSponsorOff(true)
    commit(next)
    setStatus((next.batch ? [txs[0] as TxRequest] : txs).map((): Status => ({ at: 'idle' })))
    setNotice(text === null ? null : hash === undefined ? { text } : { text, hash })
  }

  /**
   * The relay's transaction, from the chain: confirmed, it is recorded like any step; reverted, nothing happened and
   * the steps are offered from the wallet (under this delegation the same calls would only return the same failure).
   * Not mined within a minute, it waits on a check that submits the same key again: the board answers with the same
   * operation and rebroadcasts its identical signed bytes.
   */
  const settleSponsored = async (hash: Hex, r: OpRecord) => {
    try {
      const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId: chain.id, timeout: 60_000 })
      if (receipt.status !== 'success') {
        toWallet('Hireling sent these steps and the transaction reverted, so nothing changed. You can send them from your wallet; you pay the gas.', hash)
        return
      }
    } catch {
      set(0, { at: 'uncertain', error: SPONSORED.slow })
      return
    }
    await report(0, hash, r)
  }

  /** Follows the operation the board answered with to the chain. */
  const follow = async (op: SponsorOperation, r: OpRecord) => {
    // Reverted: nothing happened, and a retry with this key would only answer the same.
    if (op.status === 'reverted') {
      toWallet('Hireling sent these steps and the transaction reverted, so nothing changed. You can send them from your wallet; you pay the gas.', op.txHash)
      return
    }
    const known: OpRecord = { ...r, sponsor: { key: r.sponsor?.key ?? '', operationId: op.operationId }, hashes: [op.txHash] }
    commit(known)
    set(0, { at: 'sent', hash: op.txHash })
    await settleSponsored(op.txHash, known)
  }

  /**
   * The relay sends the steps (sponsor_submit). The request is recorded first; a refusal sends them from the wallet
   * instead (or says why not, for a failing simulation); no answer is reconciled by asking again with the identical
   * calls, which returns the same operation if the first request reached the relay.
   */
  const runSponsored = async () => {
    const at = status[0]?.at
    if (sending.current || !canSend || address === undefined || (owner !== undefined && owner.toLowerCase() !== address.toLowerCase()) || at === 'signing' || at === 'sent' || at === 'confirmed' || at === 'recorded') return
    sending.current = true
    set(0, { at: 'signing' })
    let r = record
    // Whether an earlier request for these steps may have reached the relay: then a refusal now proves nothing.
    let ambiguous = r.sponsor != null
    if (r.sponsor == null) {
      r = { ...r, sponsor: { key: sponsorKey(), operationId: null } }
      commit(r)
    }
    const callerKey = r.sponsor?.key ?? ''
    for (const wait of [0, ...RECHECK_MS]) {
      if (wait > 0) {
        await sleep(wait)
        set(0, { at: 'uncertain', checking: true, error: SPONSORED.checking })
      }
      let op: SponsorOperation
      try {
        op = await sponsorApi.submit(address, callerKey, sponsorCalls(txs))
      } catch (e) {
        const failure = submitFailure(e)
        if (failure.kind === 'lost') {
          ambiguous = true
          continue
        }
        sending.current = false
        if (ambiguous) {
          // An earlier request may have been sent (the board looks the key up before refusing, but a gateway in front
          // of it, such as the hosted rate limit, does not): never send from the wallet on top. Check again later.
          set(0, { at: 'uncertain', error: SPONSORED.lost })
          return
        }
        const cleared = { ...r, sponsor: null }
        commit(cleared)
        if (failure.kind === 'wallet') toWallet(`${failure.why[0]?.toUpperCase()}${failure.why.slice(1)}, so these go from your wallet; you pay the gas.`)
        else set(0, { at: 'failed', error: failure.message })
        return
      }
      sending.current = false
      await follow(op, r)
      return
    }
    sending.current = false
    set(0, { at: 'uncertain', error: SPONSORED.lost })
  }
  const report = async (i: number, hash: Hex, r: OpRecord) => {
    set(i, { at: 'confirmed', hash })
    try {
      // The task's own board records it (a job may be shown on another board's page). A step that belongs to no job
      // (staking) is done once the chain confirms it.
      if (reportToBoard) await boardApi(boardId).tool('report_transaction', { taskId, txHash: hash })
      const next = { ...r, recorded: Object.assign([...r.recorded], { [i]: true }) }
      commit(next)
      set(i, { at: 'recorded', hash })
    } catch (e) {
      set(i, { at: 'confirmed', hash, reportError: `On the chain, but the board did not record it: ${friendlyError(e)}` })
    }
  }

  /**
   * After a wallet error that was not a refusal: asks the chain, a few times over some seconds, whether the step went
   * out. Mined: follow it like any sent step. Provably not sent: a real retry. Otherwise it stays uncertain, with a
   * check again and the hash from wallet activity as the ways out; it is never sent twice on a guess.
   */
  const reconcile = async (i: number, r: OpRecord) => {
    if (checking.current) return
    const snapshot = r.snapshot
    const from = r.from
    if (snapshot == null || from == null) {
      set(i, { at: 'uncertain', error: UNCERTAIN.legacy })
      return
    }
    checking.current = true
    set(i, { at: 'uncertain', checking: true, error: UNCERTAIN.checking })
    const call = r.batch ? { to: from, data: sdk.batchCalldata(txs.map((t) => ({ ...t, value: '0' as const }))) } : { to: (txs[i] as TxRequest).to, data: (txs[i] as TxRequest).data as Hex }
    let outcome: Reconciled = { at: 'unknown' }
    let notSent = 0
    for (const wait of RECHECK_MS) {
      await sleep(wait)
      outcome = await reconcileSend(chainReads(from), snapshot, from, call)
      notSent = outcome.at === 'not-sent' ? notSent + 1 : 0
      // Twice in a row: a step the wallet broadcast just before failing would be pending or mined by then.
      if (outcome.at === 'found' || notSent === 2) break
    }
    checking.current = false
    if (outcome.at === 'found') {
      const known = { ...r, pending: null, snapshot: null, hashes: Object.assign([...r.hashes], { [i]: outcome.hash }) }
      commit(known)
      set(i, { at: 'sent', hash: outcome.hash })
      await settle(i, outcome.hash, known)
    } else if (outcome.at === 'not-sent') {
      commit({ ...r, pending: null, snapshot: null })
      set(i, { at: 'failed', error: 'Your wallet returned an error and nothing left your account, so nothing was sent. You can send it again.' })
    } else {
      set(i, { at: 'uncertain', error: outcome.at === 'pending' ? UNCERTAIN.pending : UNCERTAIN.unknown })
    }
  }

  // Privy's wallet may become ready after the first render: offer the batch as long as nothing has started.
  const started = status.some((x) => x.at !== 'idle')
  useEffect(() => {
    if (batch !== null && txs.length > 1 && !record.batch && record.sponsored !== true && !started && load(key) === null) {
      setRecord({ ...record, batch: true })
      setStatus([{ at: 'idle' }])
    }
  }, [batch !== null])

  // The signed-in wallet's sponsorship is read after the first render: offer the relay as long as nothing has started.
  useEffect(() => {
    if (canSponsor && record.sponsored !== true && !sponsorOff && !started && load(key) === null) {
      setRecord({ ...record, sponsored: true, batch: false })
      setStatus([{ at: 'idle' }])
    }
  }, [canSponsor])

  // After a reload: follow any sent transaction to the end, and settle an uncertain one against the chain, instead of
  // offering to send either again.
  useEffect(() => {
    status.forEach((s, i) => {
      if (s.at === 'sent') void settle(i, s.hash, record)
      if (s.at === 'uncertain' && s.checking === true) void reconcile(i, record)
    })
  }, [])

  const steps = record.batch || record.sponsored === true ? 1 : txs.length
  const allDone = status.length === steps && status.every((s) => s.at === 'recorded')
  useEffect(() => {
    if (!allDone || done.current) return
    done.current = true
    save(key, null)
    onDone(status.flatMap((s) => (s.at === 'recorded' ? [s.hash] : [])))
  }, [allDone])

  const run = async (i: number) => {
    if (record.sponsored === true) {
      await runSponsored()
      return
    }
    if (sending.current || !canSend || address === undefined || (owner !== undefined && owner.toLowerCase() !== address.toLowerCase()) || record.pending !== null || retryAction(status[i] ?? { at: 'signing' }) !== 'send') return
    if (record.batch && batch === null) {
      set(i, { at: 'failed', error: 'This wallet cannot send a batch; send them one at a time.' })
      return
    }
    sending.current = true
    set(i, { at: 'signing' })
    // The nonce before the wallet is opened is what later tells a lost send from one that went out.
    const from = address as Hex
    let snapshot: SendSnapshot
    try {
      const reads = chainReads(from)
      const [nonce, block] = await Promise.all([reads.nonce('pending'), reads.blockNumber()])
      snapshot = { nonce, block: block.toString() }
    } catch (e) {
      set(i, { at: 'failed', error: `Your account could not be read from the chain, so nothing was sent. ${friendlyError(e)}` })
      sending.current = false
      return
    }
    const withPending = { ...record, pending: i, snapshot, from }
    commit(withPending)
    let hash: Hex
    try {
      if (record.batch) {
        if (batch === null) throw new Error('This wallet cannot send a batch; send them one at a time.')
        hash = await batch(txs, batchGasLimit(txs, hireling))
      } else {
        const tx = txs[i] as TxRequest
        const gas = gasLimit(tx, hireling)
        hash = await sendTransactionAsync({ to: tx.to, data: tx.data, value: 0n, chainId: chain.id, ...(gas === undefined ? {} : { gas }) })
      }
    } catch (e) {
      sending.current = false
      if (walletRefused(e)) {
        commit({ ...withPending, pending: null, snapshot: null })
        set(i, { at: 'failed', error: friendlyError(e) })
      } else {
        void reconcile(i, withPending)
      }
      return
    }
    const sent = { ...withPending, pending: null, snapshot: null, hashes: Object.assign([...record.hashes], { [i]: hash }) }
    commit(sent)
    set(i, { at: 'sent', hash })
    await settle(i, hash, sent)
    sending.current = false
  }

  const next = status.findIndex((s) => s.at !== 'recorded')
  const current = status[next]
  // `autoStart`: the tap that showed these steps was the decision, so the wallet opens at once for a fresh operation
  // (never for one restored from a reload, which reconciles instead).
  // It waits for the sponsorship status, so a step Hireling pays for never opens the wallet first.
  const autoStarted = useRef(false)
  useEffect(() => {
    if (!autoStart || autoStarted.current || !sponsorship.settled || started || load(key) !== null) return
    if (canSponsor && record.sponsored !== true && !sponsorOff) return
    if (record.sponsored !== true && chainId !== chain.id) return
    autoStarted.current = true
    void run(0)
  }, [sponsorship.settled, record.sponsored])
  const busy = current !== undefined && (current.at === 'signing' || current.at === 'sent' || (current.at === 'confirmed' && current.reportError === undefined))
  useEffect(() => { onBusyChange?.(busy) }, [busy, onBusyChange])
  const safeToRestart = record.pending === null && status.every((entry) => entry.at === 'idle' || entry.at === 'recorded' || (entry.at === 'failed' && (entry.hash === undefined || entry.reverted === true)))
  useEffect(() => { onSafeToRestartChange?.(safeToRestart) }, [safeToRestart, onSafeToRestartChange])

  if (chainId !== chain.id && record.sponsored !== true) {
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

  const rows = txs

  return (
    <div className="grid gap-3">
      {record.pending !== null && current?.at === 'uncertain' && (
        <div role="status" className="grid gap-2 rounded-xl bg-warn-bg px-4 py-3 text-[0.9rem] text-warn">
          <p>{current.error}</p>
          {current.checking !== true && (
            <>
              {record.snapshot != null && (
                <Button variant="tinted" onClick={() => { if (record.pending !== null) void reconcile(record.pending, record) }}>
                  Check the chain again
                </Button>
              )}
              <Input aria-label="Transaction hash from wallet activity" value={pendingHash} onChange={(event) => setPendingHash(event.target.value)} placeholder="0x… transaction hash" />
              <Button variant="tinted" disabled={!/^0x[0-9a-fA-F]{64}$/.test(pendingHash)} onClick={() => {
                const index = record.pending
                if (index === null) return
                const hash = pendingHash as Hex
                const known = { ...record, pending: null, snapshot: null, hashes: Object.assign([...record.hashes], { [index]: hash }) }
                commit(known)
                void settle(index, hash, known)
              }}>Check existing transaction</Button>
            </>
          )}
        </div>
      )}
      {notice !== null && (
        <p role="status" className="flex flex-wrap items-center gap-x-2 rounded-xl bg-warn-bg px-4 py-3 text-[0.9rem] leading-snug text-warn">
          {notice.text}
          {notice.hash !== undefined && <TxLink hash={notice.hash} />}
        </p>
      )}
      {record.sponsored === true && current?.at === 'uncertain' && (
        <div role="status" className="grid gap-2 rounded-xl bg-warn-bg px-4 py-3 text-[0.9rem] text-warn">
          <p>{current.error}</p>
          {current.checking !== true && (
            <Button variant="tinted" onClick={() => void runSponsored()}>
              Check again
            </Button>
          )}
        </div>
      )}
      <Group>
        {rows.map((tx, i) => {
          const s = status[record.batch || record.sponsored === true ? 0 : i] ?? { at: 'idle' }
          return (
            <ListRow key={`${i}-${tx.description}`} inset>
              <StepIcon n={i + 1} s={s} />
              <span className="min-w-0 flex-1">
                <span className={cn('block text-[0.95rem] first-letter:uppercase', s.at === 'idle' && i !== next && 'text-label-2')}>{tx.description}</span>
                {(
                  <span className="flex flex-wrap items-center gap-x-2 text-[0.8rem] text-label-2">
                    {record.sponsored === true && SPONSORED_LABEL[s.at] !== undefined
                      ? SPONSORED_LABEL[s.at]
                      : record.batch && s.at === 'idle'
                        ? `Waiting · ${txs.length} steps as one transaction`
                        : s.at === 'uncertain' && s.checking === true
                          ? record.sponsored === true ? 'Checking with Hireling…' : 'Checking the chain…'
                          : LABEL[s.at]}
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
      {!allDone && current !== undefined && current.at !== 'uncertain' && (
        <Button
          size="lg"
          busy={busy}
          disabled={(!canSend || (owner !== undefined && owner.toLowerCase() !== address?.toLowerCase())) && retryAction(current) === 'send'}
          onClick={() => {
            if (current.at === 'confirmed' && current.reportError !== undefined) void report(next, current.hash, record)
            else if (retryAction(current) === 'receipt' && 'hash' in current && current.hash !== undefined) void settle(next, current.hash, record)
            else void run(next)
          }}
        >
          {current.at === 'confirmed' && current.reportError !== undefined
            ? 'Record it again'
            : current.at === 'failed'
              ? 'Try again'
              : record.sponsored === true
                ? txs.length > 1 ? `Send all ${txs.length} · Hireling pays the gas` : 'Send · Hireling pays the gas'
                : record.batch
                ? `Confirm ${txs.length > 1 ? `all ${txs.length} as one transaction` : ''}`.trim()
                : txs.length > 1
                  ? `Confirm step ${next + 1} of ${txs.length}`
                  : 'Confirm in your wallet'}
        </Button>
      )}
      {record.sponsored === true && (!started || (current?.at === 'failed' && record.sponsor == null)) && (
        <Button
          variant="plain"
          size="sm"
          onClick={() => toWallet(null)}
          className="justify-self-center"
        >
          Pay the gas yourself instead
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
  if (s.at === 'signing' || s.at === 'sent' || s.at === 'confirmed' || (s.at === 'uncertain' && s.checking === true)) {
    return <span aria-hidden className="size-6 shrink-0 animate-spin rounded-full border-[2.5px] border-fill-strong border-t-tint" />
  }
  return <span className="grid size-6 shrink-0 place-items-center rounded-full bg-fill-strong text-[0.75rem] font-semibold text-label-2">{n}</span>
}

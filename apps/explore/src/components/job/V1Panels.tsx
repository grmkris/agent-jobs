/**
 * What a Hireling v1 job adds to its page (ADR-0011): before activation, the fee a worker would pay and what it would
 * receive, from `quoteActivation`; after activation, a top-up anyone can add to the reward. Both read and write the v1
 * Holding directly, in this file only, until the board's `fee_quote` and `top_up` tools land.
 */
import * as sdk from '@agent-jobs/sdk'
import { Link } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { type Address, encodeFunctionData, erc20Abi } from 'viem'
import { useReadContracts } from 'wagmi'
import type { TxRequest } from '../../api.ts'
import { amount, tokenInfo } from '../../format.ts'
import { percent } from '../../stake.ts'
import { chain } from '../../wallet.ts'
import { toBase } from '../post/form.ts'
import { useToast } from '../Sheet.tsx'
import { TxSteps } from '../TxSteps.tsx'
import { Button, ErrorText, Group, Input, ListRow, Section } from '../ui.tsx'

/** Before activation: the viewer's fee tier and net payout if they activate now. */
export function FeeQuote({ jobId, holding, viewer, token }: { jobId: string; holding: Address; viewer: Address; token: string | null }) {
  const quote = useReadContracts({
    contracts: [{ address: holding, abi: sdk.hirelingHoldingAbi, functionName: 'quoteActivation', args: [BigInt(jobId), viewer], chainId: chain.id }],
    query: { refetchInterval: 30_000 },
  })
  const r = quote.data?.[0]
  const [bps, fee, net] = r?.status === 'success' ? (r.result as readonly [number, bigint, bigint]) : [undefined, undefined, undefined]
  return (
    <Section title="If you take this job" note="Your fee rate is fixed when you activate: a later change of stake or schedule does not move it.">
      {quote.isError || r?.status === 'failure' ? (
        <ErrorText>Your fee for this job cannot be read from the chain right now.</ErrorText>
      ) : (
        <Group>
          <ListRow>
            <span className="flex-1">
              <span className="block">Hireling’s fee{bps === undefined ? '' : ` · ${percent(Number(bps))}`}</span>
              <span className="block text-[0.78rem] leading-snug text-label-3">Your rate, set by total backing</span>
            </span>
            {/* min-w-24: the value's room is kept while it loads, so the label does not rewrap when it lands. */}
            <span className="tabular min-w-24 text-right text-label-2">{fee === undefined ? '…' : `− ${amount(fee.toString(), token)}`}</span>
          </ListRow>
          <ListRow>
            <span className="flex-1 font-semibold">You receive</span>
            <span className="tabular min-w-24 text-right font-semibold">{net === undefined ? '…' : amount(net.toString(), token)}</span>
          </ListRow>
          <Link to="/stake" className="flex min-h-11 items-center px-4 text-[0.9rem] text-tint">
            Delegate more to pay a lower fee
          </Link>
        </Group>
      )}
    </Section>
  )
}

/** After activation: anyone adds to the reward. Paid to the agent with it (same fee rate), or refundable. */
export function TopUp({ jobId, holding, token, viewer }: { jobId: string; holding: Address; token: Address; viewer: Address }) {
  const qc = useQueryClient()
  const toast = useToast()
  const reads = useReadContracts({
    contracts: [
      { address: holding, abi: sdk.hirelingHoldingAbi, functionName: 'getListing', args: [BigInt(jobId)], chainId: chain.id },
      { address: holding, abi: sdk.hirelingHoldingAbi, functionName: 'topUpOf', args: [BigInt(jobId), viewer], chainId: chain.id },
    ],
    query: { refetchInterval: 30_000 },
  })
  const listing = reads.data?.[0]?.status === 'success' ? (reads.data[0].result as { bonus: bigint }) : undefined
  const mine = reads.data?.[1]?.status === 'success' ? (reads.data[1].result as bigint) : undefined
  const [text, setText] = useState('')
  const [txs, setTxs] = useState<TxRequest[] | null>(null)
  const value = text.trim() === '' ? null : toBase(text, token)
  const valid = value !== null && value > 0n
  const add = () => {
    if (!valid || value === null) return
    setTxs([
      { description: `Approve ${amount(value.toString(), token)} for the job`, chainId: chain.id, to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [holding, value] }), value: '0' },
      { description: `Add ${amount(value.toString(), token)} to job #${jobId}`, chainId: chain.id, to: holding, data: encodeFunctionData({ abi: sdk.hirelingHoldingAbi, functionName: 'topUp', args: [BigInt(jobId), value] }), value: '0' },
    ])
    setText('')
  }
  return (
    <Section
      title="Add to the reward"
      note="Anyone can add to the reward while the job is under way. The agent is paid it with the reward, minus the same fee rate. If the creator is refunded instead, each contributor can claim their top-up back."
    >
      <Group>
        <ListRow>
          <span className="flex-1">Added so far</span>
          <span className="tabular">{listing === undefined ? '…' : amount(listing.bonus.toString(), token)}</span>
        </ListRow>
        {mine !== undefined && mine > 0n && (
          <ListRow>
            <span className="flex-1 text-label-2">By you</span>
            <span className="tabular text-label-2">{amount(mine.toString(), token)}</span>
          </ListRow>
        )}
      </Group>
      {txs !== null ? (
        <div className="mt-2">
          <TxSteps
            key={txs.map((t) => t.data).join()}
            taskId={`topup:${jobId}`}
            txs={txs}
            owner={viewer}
            reportToBoard={false}
            onDone={() => {
              setTxs(null)
              void qc.invalidateQueries()
              toast('Added to the reward')
            }}
          />
        </div>
      ) : (
        <form
          className="mt-2 flex items-stretch gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            add()
          }}
        >
          <Input aria-label="Amount to add" value={text} onChange={(e) => setText(e.target.value)} inputMode="decimal" placeholder="0.00" className="tabular flex-1 text-right" />
          <span className="self-center text-label-2">{tokenInfo(token).symbol}</span>
          <Button type="submit" variant="tinted" disabled={!valid}>
            Add
          </Button>
        </form>
      )}
    </Section>
  )
}

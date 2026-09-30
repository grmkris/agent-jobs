import { useQuery } from '@tanstack/react-query'
import { Lock } from 'lucide-react'
import { useState } from 'react'
import { type DeliverableKind, type DeliverableSpec, type TxRequest, currentBoardId, tool } from '../../api.ts'
import { amount, bond } from '../../format.ts'
import { useToken } from '../../useTokens.ts'
import { BoardLink, boardRoutes, useBoardNavigate } from '../BoardLink.tsx'
import { useToast } from '../Sheet.tsx'
import { When, useNow } from '../Time.tsx'
import { TxSteps } from '../TxSteps.tsx'
import { Badge, Button, CopyButton, EmptyState, ErrorText, Group, ListRow, LoadingRows, PageTitle, Section, rowClass } from '../ui.tsx'
import type { useSignedIn } from '../Wallet.tsx'
import { KV } from './parts.tsx'
import { Preflight } from './Preflight.tsx'
import { ScreeningCard } from './Screening.tsx'
import { SignInToPublish } from './SignInToPublish.tsx'

type Auth = ReturnType<typeof useSignedIn>

/** The board's `get_task` answer, as far as resuming a frozen offer reads it (amounts in base units). */
interface SavedOffer {
  taskId: string
  title: string
  mode: 'hire' | 'contest'
  stack: string
  token: string
  reward: string
  creatorBond: string
  workerBond: string
  creator: string
  deliveryDeadline: number
  selectionDeadline: number | null
  manifestUrl: string
  deliverable?: DeliverableSpec | null
  executionBudget: { kind: 'advance' | 'call'; amount: string; symbol: string; function?: string } | null
  jobId: string | null
  screening: { verdict: string; reasons: string[] }
  terms: { brief?: string; acceptanceCriteria?: string[]; evidencePolicy?: { checks?: string[] } | null }
}

const KIND_LABEL: Record<DeliverableKind, string> = { git: 'Git commit', patch: 'Patch', artifact: 'File', url: 'Live URL', onchain: 'On-chain' }

/**
 * An offer the board froze that never reached the chain (`?resume=<taskId>`, linked from the drafts in Jobs): shown as
 * agents will see it, with its screening, and published by its creator through the board's `publish_transactions`,
 * which hands out the approvals and the publish again (a terms hash lists once, so it cannot publish twice).
 */
export function ResumeOffer({ taskId, auth, onPublished }: { taskId: string; auth: Auth; onPublished?: ((p: { taskId: string; jobId: string | null; txHash: string | null }) => void) | undefined }) {
  const navigate = useBoardNavigate()
  const toast = useToast()
  const now = useNow()
  const task = useQuery({ queryKey: ['resume-offer', currentBoardId(), taskId, auth.signedIn], queryFn: () => tool<SavedOffer>('get_task', { taskId }) })
  const [txs, setTxs] = useState<TxRequest[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const t = task.data
  useToken(t?.token)
  const mine = t !== undefined && auth.address !== undefined && t.creator.toLowerCase() === auth.address.toLowerCase()

  const header = (
    <>
      <BoardLink target={boardRoutes().publish()} className="text-[0.9rem] text-tint">
        Post a new job instead
      </BoardLink>
      <PageTitle sub={t !== undefined && t.jobId === null ? <Badge tone="attention">Not published yet</Badge> : undefined}>{t?.title ?? 'A saved offer'}</PageTitle>
    </>
  )
  if (task.isLoading) {
    return (
      <>
        {header}
        <LoadingRows rows={4} />
      </>
    )
  }
  if (t === undefined) {
    return (
      <>
        {header}
        <ErrorText>This offer could not be loaded: {(task.error as Error | null)?.message ?? 'it was not found on this board'}.</ErrorText>
      </>
    )
  }
  if (t.jobId !== null) {
    return (
      <>
        {header}
        <EmptyState title="Already published">
          <BoardLink target={boardRoutes().job(t.jobId)} className="text-tint">
            Open job #{t.jobId}
          </BoardLink>
        </EmptyState>
      </>
    )
  }

  const contest = t.mode === 'contest'
  const lapsed = t.deliveryDeadline <= now || (contest && t.selectionDeadline !== null && t.selectionDeadline <= now)
  const reward = amount(t.reward, t.token)
  const criteria = t.terms.acceptanceCriteria ?? []
  const checks = t.terms.evidencePolicy?.checks ?? []
  const accepts = t.deliverable?.accepts ?? ['git']

  const prepare = async () => {
    if (txs !== null) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const r = await tool<{ transactions: TxRequest[] }>('publish_transactions', { taskId })
      setTxs(r.transactions)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const published = async (hashes: string[]) => {
    const jobId = await tool<{ jobId: string | null }>('get_task', { taskId }).then(
      (x) => x.jobId,
      () => null,
    )
    toast(`Published · ${reward} locked in escrow`)
    if (onPublished !== undefined) onPublished({ taskId, jobId, txHash: hashes.at(-1) ?? null })
    else await navigate(jobId !== null ? boardRoutes().job(jobId) : boardRoutes().jobs())
  }

  return (
    <>
      {header}
      <Section title="What agents will see">
        <Group>
          <ListRow>
            <span className="grid min-w-0 gap-1 py-1">
              <span className="font-semibold [overflow-wrap:anywhere]">{t.title}</span>
              <span className="text-[0.92rem] leading-relaxed whitespace-pre-wrap text-label-2 [overflow-wrap:anywhere]">{t.terms.brief ?? ''}</span>
            </span>
          </ListRow>
          {criteria.length > 0 && (
            <ListRow>
              <span className="grid min-w-0 gap-1 py-1">
                <span className="text-[0.8rem] text-label-2">Accepted when</span>
                <ul className="grid list-disc gap-0.5 pl-5 text-[0.92rem] [overflow-wrap:anywhere]">
                  {criteria.map((c, i) => (
                    <li key={`${i}-${c}`}>{c}</li>
                  ))}
                </ul>
              </span>
            </ListRow>
          )}
          <KV label="How agents compete">{contest ? 'Run a contest' : 'Hire one agent'}</KV>
          <KV label={contest ? 'Prize' : 'Reward'}>
            <span className="tabular font-semibold text-label">{reward}</span>
          </KV>
          <KV label="Deliver by">
            <When at={t.deliveryDeadline} />
          </KV>
          {contest && (
            <KV label="Award by">
              <When at={t.selectionDeadline} />
            </KV>
          )}
          <KV label="Deliver as">{accepts.map((k) => KIND_LABEL[k]).join(', ')}</KV>
          {checks.length > 0 && (
            <KV label="Required GitHub check">
              <code className="font-mono text-[0.85rem]">{checks.join(', ')}</code>
            </KV>
          )}
          <KV label="Bonds">{contest ? `${bond(t.creatorBond)} from you` : `${bond(t.creatorBond)} from you · ${bond(t.workerBond)} from the agent`}</KV>
          {t.executionBudget !== null && (
            <KV label="Running-cost budget">{t.executionBudget.kind === 'call' ? `Up to ${t.executionBudget.amount} ${t.executionBudget.symbol} for one contract call` : `Up to ${t.executionBudget.amount} ${t.executionBudget.symbol}`}</KV>
          )}
        </Group>
      </Section>

      <ScreeningCard screening={t.screening} />

      {!auth.signedIn ? (
        <Section note="Only the person who prepared this offer can publish it.">
          <SignInToPublish auth={auth} />
        </Section>
      ) : !mine ? (
        <EmptyState title="Not your offer">Only the person who prepared this offer can publish it. You can post a job of your own from Post.</EmptyState>
      ) : (
        <>
          <Preflight address={auth.address} stack={t.stack} token={t.token} reward={BigInt(t.reward)} bond={BigInt(t.creatorBond)} />
          <div className="flex items-center gap-3.5 rounded-xl bg-surface p-4">
            <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-tint/14 text-tint">
              <Lock aria-hidden className="size-5" />
            </span>
            <span className="min-w-0">
              <span className="tabular block font-display text-[1.6rem] leading-tight font-bold tracking-[-0.02em] [overflow-wrap:anywhere]">{reward}</span>
              <span className="block text-[0.86rem] text-label-2">
                Locked in escrow when you publish · due <When at={t.deliveryDeadline} show="relative" />
              </span>
            </span>
          </div>
          {lapsed && (
            <p className="rounded-xl bg-warn-bg px-4 py-3 text-[0.9rem] text-warn">
              Its {t.deliveryDeadline <= now ? 'delivery deadline' : 'award deadline'} has passed, so it can no longer be published. Post the job again with new dates.
            </p>
          )}
          {error !== null && <ErrorText>{error}</ErrorText>}
          <Section title="Publish" note={`Your wallet sends the ${contest ? 'prize' : 'reward'} approval, FACTORY bond approval and publish transaction in order. Only the wallet confirmation is an overlay.`}>
            {txs !== null ? <TxSteps key={taskId} taskId={taskId} txs={txs} owner={t.creator} canSend={!lapsed && mine} onDone={(hashes) => void published(hashes)} /> : <Button size="lg" busy={busy} disabled={lapsed} onClick={() => void prepare()}>Prepare wallet steps</Button>}
          </Section>
        </>
      )}

      <Section title="Details">
        <Group>
          <div className={rowClass()}>
            <span className="flex-1">Offer ID</span>
            <span className="font-mono text-[0.82rem] text-label-2">{t.taskId}</span>
            <CopyButton value={t.taskId} label="Copy offer ID" />
          </div>
          <a href={t.manifestUrl} target="_blank" rel="noreferrer" className={`${rowClass({ interactive: true })} text-tint`}>
            The full terms, as agents read them
          </a>
        </Group>
      </Section>

    </>
  )
}

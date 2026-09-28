/**
 * One arbiter pass (plan B2.4): hold the lease, then for every open dispute on the board without a decision, read
 * the bundle, let the model propose, and sign only what the deterministic gate allows. The board records the
 * decision per dispute and relays the signed ruling; the harness never sends a transaction and never signs a
 * message it did not rebuild itself: the Ruling it signs uses the evaluator domain from the SDK deployment, the
 * job from the bundle and exactly the validated proposal.
 */
import { type DisputeBundle, checkRulingRequest, validateProposal } from '@agent-jobs/board'
import * as sdk from '@agent-jobs/sdk'
import type { Hex, LocalAccount } from 'viem'

export interface BoardLike {
  call<T = any>(tool: string, args?: Record<string, unknown>): Promise<T>
}

export interface ArbiterDeps {
  readonly board: BoardLike
  readonly account: LocalAccount
  readonly network: sdk.Network
  readonly runner: string
  /** The model's proposal for a bundle; anything it returns goes through `validateProposal`. */
  readonly propose: (bundle: DisputeBundle) => Promise<unknown>
  readonly now?: () => number
  readonly log?: (message: string) => void
  readonly leaseSeconds?: number
  /** Recorded with a new decision (R114-08). */
  readonly model?: string
  readonly promptVersion?: string
}

export type Outcome =
  | { readonly taskId: string; readonly result: 'ruled'; readonly forWorker: boolean; readonly slashLoser: boolean; readonly txHash: string | null }
  | { readonly taskId: string; readonly result: 'skipped'; readonly why: string }

interface DisputeRow {
  taskId: string
  stack: string
  arbitrationEndsAt: number
  decision: { forWorker: boolean; slashLoser: boolean; reason: string | null; txHash: string | null } | null
}

export async function arbitrateOnce(deps: ArbiterDeps): Promise<{ lease: boolean; outcomes: Outcome[] }> {
  const log = deps.log ?? (() => {})
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000))
  const lease = await deps.board.call<{ held: boolean; holder: string | null }>('arbiter_lease', {
    runner: deps.runner,
    ttlSeconds: deps.leaseSeconds ?? 300,
  })
  if (!lease.held) {
    log(`lease held by ${lease.holder}; idle`)
    return { lease: false, outcomes: [] }
  }
  const outcomes: Outcome[] = []
  for (const d of await deps.board.call<DisputeRow[]>('list_disputes')) {
    if (d.decision?.txHash != null) continue
    try {
      outcomes.push(await decide(deps, d, now, log))
    } catch (e) {
      outcomes.push({ taskId: d.taskId, result: 'skipped', why: (e as Error).message })
    }
  }
  for (const o of outcomes) log(o.result === 'ruled' ? `${o.taskId}: ruled forWorker=${o.forWorker} slashLoser=${o.slashLoser} ${o.txHash ?? ''}` : `${o.taskId}: skipped (${o.why})`)
  return { lease: true, outcomes }
}

async function decide(deps: ArbiterDeps, d: DisputeRow, now: () => number, log: (m: string) => void): Promise<Outcome> {
  if (now() >= d.arbitrationEndsAt) return { taskId: d.taskId, result: 'skipped', why: 'the window has closed' }
  const { bundle, bundleHash } = await deps.board.call<{ bundle: DisputeBundle; bundleHash: Hex }>('get_dispute_bundle', { taskId: d.taskId })
  // The evaluator must be one of this network's pairs, current or legacy (a job stays on the pair it was published on).
  const stack = sdk.allStacks(sdk.deployment(deps.network)).find(([, s]) => s.evaluator.toLowerCase() === bundle.evaluator.toLowerCase())?.[1]
  const chainId = sdk.deployment(deps.network).chainId
  if (stack === undefined || bundle.chainId !== chainId) {
    return { taskId: d.taskId, result: 'skipped', why: 'the bundle names another chain or evaluator' }
  }
  if (bundle.arbitrator.toLowerCase() !== deps.account.address.toLowerCase()) {
    return { taskId: d.taskId, result: 'skipped', why: 'not this key’s dispute' }
  }

  // A decision already recorded for this dispute (by this runner before a crash, or by another harness) is final:
  // re-use it and never ask the model again (R114-08). It still passes the same deterministic gate.
  const recorded = d.decision
  const raw =
    recorded !== null && recorded.reason !== null
      ? { forWorker: recorded.forWorker, slashLoser: recorded.slashLoser, reason: recorded.reason }
      : await deps.propose(bundle)
  const checked = validateProposal(bundle, raw)
  if (!checked.ok) return { taskId: d.taskId, result: 'skipped', why: `proposal refused: ${checked.error}` }
  const proposal = checked.proposal
  log(`${d.taskId}: ${recorded === null ? 'proposal' : 're-using the recorded decision'} forWorker=${proposal.forWorker} slashLoser=${proposal.slashLoser}`)

  const prepared = await deps.board.call<{ sign: { typedData: string } }>('prepare_ruling', {
    taskId: d.taskId,
    forWorker: proposal.forWorker,
    slashLoser: proposal.slashLoser,
    reason: proposal.reason,
    bundleHash,
    runner: deps.runner,
    ...(deps.model === undefined ? {} : { model: deps.model }),
    ...(deps.promptVersion === undefined ? {} : { promptVersion: deps.promptVersion }),
  })
  const request = checkRulingRequest(bundle, proposal, prepared.sign.typedData, { chainId, evaluator: stack.evaluator, now: now() })
  if (!request.ok) return { taskId: d.taskId, result: 'skipped', why: `ruling request refused: ${request.error}` }
  const signature = await deps.account.signTypedData({
    domain: sdk.evaluatorDomain(chainId, stack.evaluator),
    types: sdk.rulingTypes,
    primaryType: 'Ruling',
    message: request.ruling,
  })
  const submitted = await deps.board.call<{ txHash?: string; relayed: boolean }>('submit_ruling', { taskId: d.taskId, signature })
  return { taskId: d.taskId, result: 'ruled', forWorker: proposal.forWorker, slashLoser: proposal.slashLoser, txHash: submitted.txHash ?? null }
}

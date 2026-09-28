/**
 * The Dispatch adapter (CP5, demo step 1): a Cloudflare OS instance's Dispatch board publishes one of its tasks to
 * agent-jobs as a quote request, through this SDK and the board's REST API. The OS holds no key: it signs through a
 * wallet the caller passes (a Privy server wallet in the demo), so "no secrets on the OS side" still holds.
 *
 * A Dispatch task (the `DispatchSession.createTask` shape: title, description, repo with its base commit, optional
 * acceptance lines) becomes a quote request whose brief names the repository and the base commit to branch from,
 * and whose acceptance criteria include the required GitHub check on the submitted SHA. Picking a quote then
 * publishes the ordinary escrow-backed hire from the same wallet.
 */
import type { Address, Hex } from 'viem'
import { sendBatch } from './batch.ts'
import { type TxRequest, boardClient, sendAll, signTypedDataJson } from './board-client.ts'
import type { Wallet } from './actions.ts'
import { signerOf } from './privy.ts'

/** The part of a Dispatch task agent-jobs needs (Cloudflare OS `DispatchSession.createTask`). */
export interface DispatchTask {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly repo: { readonly url: string; readonly baseCommit?: string; readonly baseBranch?: string }
  readonly acceptance?: readonly string[]
}

/** What the OS owner decides once for every task it sends out. */
export interface DispatchPolicy {
  /** Accepted reward tokens, by symbol or address. */
  readonly tokens: readonly string[]
  readonly creatorBond: string
  readonly workerBond: string
  readonly deliveryHours: number
  readonly quoteHours: number
  /** GitHub check names the submitted SHA must pass. */
  readonly requiredChecks: readonly string[]
  readonly stack?: 'main' | 'demo'
}

/** The `request_quotes` arguments for one Dispatch task. Pure: the same task and policy give the same request. */
export function quoteRequestFromDispatch(task: DispatchTask, policy: DispatchPolicy, now: number) {
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(task.repo.url.replace(/\.git$/, ''))) {
    throw new Error(`Dispatch task ${task.id}: only public GitHub repositories can be published (${task.repo.url})`)
  }
  if (policy.quoteHours >= policy.deliveryHours) throw new Error('quotes must close before the delivery deadline')
  const base = task.repo.baseCommit === undefined ? `its ${task.repo.baseBranch ?? 'default'} branch` : `commit ${task.repo.baseCommit}`
  const brief = `${task.description.trim()}\n\nRepository: ${task.repo.url} (branch from ${base}). Push your work on a new branch of that repository, never its main branch, and submit that branch's exact commit.\n\n(Published from a Cloudflare OS Dispatch board, task ${task.id}.)`
  const checks = policy.requiredChecks.map((c) => `A GitHub check run named "${c}" completes with conclusion "success" on the submitted SHA.`)
  return {
    title: task.title,
    brief,
    acceptanceCriteria: [...checks, ...(task.acceptance ?? [])],
    tokens: [...policy.tokens],
    creatorBond: policy.creatorBond,
    workerBond: policy.workerBond,
    deliveryDeadline: now + Math.round(policy.deliveryHours * 3600),
    quoteDeadline: now + Math.round(policy.quoteHours * 3600),
    requiredChecks: [...policy.requiredChecks],
    ...(policy.stack === undefined ? {} : { stack: policy.stack }),
  }
}

type Reads = Parameters<typeof sendBatch>[1]

/**
 * A Dispatch board's connection to agent-jobs: one signed-in board client acting for the OS's wallet. With
 * `batchDelegate` (the deployment's EIP-7702 delegate), each step's transactions go out as one batch.
 */
export async function dispatchPublisher(boardUrl: string, wallet: Wallet, publicClient: Reads, opts: { batchDelegate?: Address } = {}) {
  const board = boardClient(boardUrl)
  await board.signIn(signerOf(wallet) as never)
  const send = async (taskId: string, txs: TxRequest[]) => {
    const hashes = opts.batchDelegate === undefined || txs.length < 2
      ? await sendAll(wallet, publicClient, txs)
      : [await sendBatch(wallet, publicClient, txs, opts.batchDelegate)]
    for (const h of hashes) await board.call('report_transaction', { taskId, txHash: h })
    return hashes
  }
  return {
    board,
    /** Posts the task as "Accepting quotes — reward not escrowed"; nothing moves on-chain. */
    requestQuotes: (task: DispatchTask, policy: DispatchPolicy, now = Math.floor(Date.now() / 1000)) =>
      board.call<{ requestId: string; requestHash: Hex }>('request_quotes', quoteRequestFromDispatch(task, policy, now)),
    quotes: (requestId: string) =>
      board.call<{ picked: string | null; quotes: Array<{ quoteId: string; worker: string; agentId: string; symbol: string; amount: string; note: string }> }>('list_quotes', { requestId }),
    /** Picks one quote (the OS owner's choice, not the cheapest by rule), publishes the escrowed hire and selects the bidder. */
    async pick(requestId: string, quoteId: string) {
      const { picked } = await board.call<{ picked: string | null }>('list_quotes', { requestId })
      // A pick whose publish failed (e.g. the wallet lacked the reward) resumes with the same frozen offer.
      const created =
        picked === null
          ? await board.call<{ taskId: string; applicationId: string; transactions: TxRequest[] }>('pick_quote', { requestId, quoteId })
          : { taskId: picked, applicationId: undefined, ...(await board.call<{ transactions: TxRequest[] }>('publish_transactions', { taskId: picked })) }
      const hashes = await send(created.taskId, created.transactions)
      const applicationId =
        created.applicationId ?? (await board.call<Array<{ id: string; note: string }>>('list_applications', { taskId: created.taskId })).find((a) => a.note === `picked quote ${quoteId}`)?.id
      const sel = await board.call<{ nonce: string; sign: { typedData: string } }>('select_worker', { taskId: created.taskId, applicationId })
      await board.call('submit_selection', { taskId: created.taskId, nonce: sel.nonce, signature: await signTypedDataJson(wallet, sel.sign.typedData) })
      return { taskId: created.taskId, publishTx: hashes.at(-1) }
    },
    /** The OS owner's decision after its own review (in the Dispatch pattern, the creator's chat agent). */
    async decide(taskId: string, decision: { accept: true } | { accept: false; violation: 'None' | 'Quality' | 'Falsified'; reason: string }) {
      const r = decision.accept
        ? await board.call<{ transactions: TxRequest[] }>('approve_work', { taskId })
        : await board.call<{ transactions: TxRequest[] }>('reject_work', { taskId, violation: decision.violation, reason: decision.reason })
      return send(taskId, r.transactions)
    },
  }
}

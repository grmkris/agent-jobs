import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { ArrowLeft, Check, Clock3, ShieldCheck, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { useAccount, useSignTypedData } from 'wagmi'
import { boardApi, type TxRequest } from '../api.ts'
import { approvalSendError, approvalSigner, approvalTypedData, frozenOperation, frozenTransactions, type FrozenOperation } from '../approval-operation.ts'
import { useAgentWallets } from '../components/Privy.tsx'
import { When, useNow } from '../components/Time.tsx'
import { TxSteps } from '../components/TxSteps.tsx'
import { initializeTxJournal } from '../components/txJournal.ts'
import { Address, Badge, Button, EmptyState, ErrorText, Group, LoadingRows, PageTitle, TxLink } from '../components/ui.tsx'
import { useAuth } from '../components/Wallet.tsx'
import { humanAction, type Approval, fleetRequest, operatorSession, useFleet } from '../fleet.ts'
import { typedDataArgs } from '../typed-data.ts'
import { chain, deployment, writesOpen } from '../wallet.ts'

function useApprovals() {
  const auth = useAuth()
  const wallets = useAgentWallets()
  const owner = wallets?.operatorAddress ?? auth.address
  return {
    owner,
    query: useQuery({
      queryKey: ['approvals', owner],
      queryFn: () => fleetRequest<{ approvals: Approval[] }>('/api/approvals', { owner }),
      enabled: owner !== undefined && operatorSession(owner) !== null,
      refetchInterval: 5000,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
    }),
  }
}

export function ApprovalsPage() {
  const { owner, query } = useApprovals()
  const now = useNow()
  const entries = query.data?.approvals ?? []
  const pending = entries.filter((entry) => entry.status === 'pending' && entry.expiresAt > now)
  const history = entries.filter((entry) => entry.status !== 'pending' || entry.expiresAt <= now)
  return (
    <>
      <header>
        <p className="eyebrow">YOUR NEXT DECISION</p>
        <PageTitle>Approvals</PageTitle>
        <p className="mt-2 max-w-[55ch] text-sm leading-relaxed text-label-2">
          Review what your agent prepared, then complete it with that agent’s wallet. Funding, selection, activation, and bonds always wait for you.
        </p>
      </header>
      {owner === undefined || operatorSession(owner) === null ? (
        <EmptyState title="Sign in to see approvals">
          The inbox belongs to your operator wallet.{' '}
          <Link to="/me" className="text-tint">
            Sign in
          </Link>
        </EmptyState>
      ) : query.isLoading ? (
        <LoadingRows rows={4} />
      ) : query.error !== null ? (
        <ErrorText>Approval inbox unavailable: {query.error.message}</ErrorText>
      ) : (
        <>
          {pending.length === 0 ? (
            <EmptyState title="Nothing needs your signature">New requests from your agent appear here.</EmptyState>
          ) : (
            <Group className="border border-sep">
              {pending.map((entry) => (
                <ApprovalRow key={entry.id} approval={entry} />
              ))}
            </Group>
          )}
          {history.length > 0 && (
            <section className="grid gap-3">
              <h2 className="section-title">Recent decisions</h2>
              <Group className="border border-sep">
                {history.slice(0, 20).map((entry) => (
                  <ApprovalRow key={entry.id} approval={entry} />
                ))}
              </Group>
            </section>
          )}
        </>
      )}
      <p className="text-xs leading-relaxed text-label-2">
        Refreshes every five seconds while visible. A permission decision prepares the wallet step; confirmed chain receipts establish what happened.
      </p>
    </>
  )
}

function ApprovalRow({ approval }: { approval: Approval }) {
  const now = useNow()
  const status =
    approval.execution?.state === 'completed'
      ? 'Completed'
      : approval.status === 'pending' && approval.expiresAt <= now
        ? 'Expired'
        : humanAction(approval.status)
  return (
    <Link
      to="/approvals/$approvalId"
      params={{ approvalId: approval.id }}
      className="flex min-h-20 items-center gap-3 border-b border-sep px-4 py-3 last:border-0 [@media(hover:hover)]:hover:bg-fill"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-warn-bg text-warn">
        <Clock3 aria-hidden className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <strong className="block truncate">{humanAction(approval.action)}</strong>
        <span className="mt-1 block text-xs text-label-2">
          Agent {approval.agentId} · <When at={approval.createdAt} show="relative" />
        </span>
      </span>
      <Badge tone={status === 'Pending' ? 'attention' : status === 'Completed' ? 'success' : 'neutral'}>{status === 'Pending' ? 'Review' : status}</Badge>
    </Link>
  )
}

export function ApprovalPage() {
  const { approvalId } = useParams({ strict: false }) as { approvalId: string }
  const { owner, query } = useApprovals()
  const cache = useQueryClient()
  const now = useNow()
  const fleet = useFleet(owner, owner !== undefined && operatorSession(owner) !== null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const approval = query.data?.approvals.find((entry) => entry.id === approvalId)
  const agent = fleet.data?.agents.find((entry) => entry.id === approval?.agentId)
  const decide = async (decision: 'approve' | 'reject') => {
    if (owner === undefined) return
    setBusy(true)
    setError(null)
    try {
      await fleetRequest(`/api/approvals/${encodeURIComponent(approvalId)}/approve`, {
        method: 'POST',
        body: { decision },
        owner,
      })
      await cache.invalidateQueries({ queryKey: ['approvals', owner] })
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }
  if (query.isLoading) return <LoadingRows rows={3} />
  if (query.isError) return <ErrorText>Approval unavailable: {query.error.message}</ErrorText>
  if (approval === undefined)
    return (
      <>
        <Back />
        <EmptyState title="Approval not found">
          It may belong to another operator.{' '}
          <Link to="/me" className="text-tint">
            Manage your account
          </Link>
        </EmptyState>
      </>
    )
  let operation: FrozenOperation | null = null
  let problem: string | null = null
  try {
    operation = frozenOperation(approval)
    if (operation.chainId !== chain.id || (agent !== undefined && operation.from.toLowerCase() !== agent.walletAddress.toLowerCase()))
      throw new Error('The frozen request differs from this agent wallet or network.')
  } catch (failure) {
    problem = (failure as Error).message
  }
  return (
    <>
      <Back />
      <header>
        <p className="eyebrow">FROZEN REQUEST</p>
        <PageTitle>{humanAction(approval.action)}</PageTitle>
        <p className="mt-2 text-sm text-label-2">
          {agent?.name ?? approval.agentId} · request <span className="break-all font-mono text-xs">{approval.operationId}</span>
        </p>
      </header>
      <section className="workspace-panel grid gap-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-5 text-tint" />
          <h2 className="section-title">Review the exact operation</h2>
        </div>
        <dl className="review-grid">
          <dt>Agent wallet</dt>
          <dd>{operation === null ? 'Unavailable' : <Address value={operation.from} />}</dd>
          <dt>Network</dt>
          <dd>
            {chain.name} · {operation?.chainId ?? 'Unavailable'}
          </dd>
          <dt>Created</dt>
          <dd>
            <When at={approval.createdAt} />
          </dd>
          <dt>Expires</dt>
          <dd>
            <When at={approval.expiresAt} />
          </dd>
          <dt>State</dt>
          <dd>
            <Badge tone={approval.status === 'pending' ? 'attention' : approval.status === 'approved' ? 'success' : 'neutral'}>
              {approval.execution?.state ?? approval.status}
            </Badge>
          </dd>
        </dl>
        {operation?.result.transactions !== undefined && <TransactionReview txs={operation.result.transactions} />}
        {operation?.result.sign !== undefined && (
          <>
            <p className="text-sm font-semibold">{operation.result.sign.description}</p>
            <pre className="code-block">{prettyJson(operation.result.sign.typedData)}</pre>
          </>
        )}
        <details>
          <summary className="cursor-pointer text-sm font-semibold text-tint">Show all frozen terms, fees, and calldata</summary>
          <pre className="code-block mt-3">{JSON.stringify(approval.payload, null, 2)}</pre>
        </details>
        {problem !== null && <ErrorText>{problem} Nothing will be signed.</ErrorText>}
        {approval.status === 'pending' && approval.expiresAt > now && (
          <div className="flex flex-wrap gap-3 border-t border-sep pt-4">
            <Button busy={busy} disabled={problem !== null || agent === undefined || !writesOpen} onClick={() => void decide('approve')}>
              <Check className="size-4" />
              Approve & open wallet step
            </Button>
            <Button busy={busy} variant="danger" onClick={() => void decide('reject')}>
              <X className="size-4" />
              Reject
            </Button>
          </div>
        )}
        {approval.status === 'approved' && operation !== null && problem === null && agent !== undefined && (
          <ExecutionPanel key={approval.id} approval={approval} operation={operation} owner={owner} agentName={agent.name} />
        )}
        {approval.expiresAt <= now && approval.execution?.state !== 'completed' && (
          <p className="text-sm text-warn">
            This request expired. Existing receipts can still be reconciled; ask your agent for a fresh request before starting another operation.
          </p>
        )}
        {error !== null && <ErrorText>{error}</ErrorText>}
      </section>
    </>
  )
}

function Back() {
  return (
    <Link to="/approvals" className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-tint">
      <ArrowLeft className="size-4" />
      All approvals
    </Link>
  )
}

interface Journal {
  frozen: string
  wallet: string
  claimId?: string
  signature?: string
  transactions?: TxRequest[]
  hashes?: string[]
  continuationDone?: boolean
  completed?: boolean
}
function readJournal(key: string, frozen: string, wallet: string): Journal {
  const saved = localStorage.getItem(key)
  if (saved === null) return { frozen, wallet }
  const record = JSON.parse(saved) as Journal
  if (record.frozen !== frozen || record.wallet.toLowerCase() !== wallet.toLowerCase())
    throw new Error('The saved operation differs from this approval. Reconcile it before continuing.')
  return record
}

function ExecutionPanel({
  approval,
  operation,
  owner,
  agentName,
}: {
  approval: Approval
  operation: FrozenOperation
  owner: string | undefined
  agentName: string
}) {
  const auth = useAuth()
  const wallets = useAgentWallets()
  const account = useAccount()
  const current = useRef({
    address: account.address,
    chainId: account.chainId,
    signedIn: auth.signedIn,
  })
  current.current = { address: account.address, chainId: account.chainId, signedIn: auth.signedIn }
  const { signTypedDataAsync } = useSignTypedData()
  const now = useNow()
  const cache = useQueryClient()
  const key = `hireling.approval-operation:${approval.id}`
  const frozen = JSON.stringify(approval.payload)
  const [initial] = useState(() => {
    try {
      return { record: readJournal(key, frozen, operation.from), error: null }
    } catch (failure) {
      return { record: null, error: (failure as Error).message }
    }
  })
  const [record, setRecord] = useState<Journal | null>(initial.record)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(initial.error)
  const selected = account.address?.toLowerCase() === operation.from.toLowerCase() && account.chainId === chain.id
  const commit = (next: Journal) => {
    // A failed durable write stops before a wallet prompt or a follow-up request.
    if (next.transactions !== undefined && record?.transactions === undefined)
      initializeTxJournal(localStorage, `approval:${approval.id}`, next.transactions)
    localStorage.setItem(key, JSON.stringify(next))
    setRecord(next)
    return next
  }
  const guard = () => {
    approvalSigner(operation.from, current.current.address, chain.id, current.current.chainId)
    if (!current.current.signedIn) throw new Error('Finish this agent wallet’s website sign-in before continuing.')
    if (!writesOpen) throw new Error('Wallet operations are unavailable on this network.')
  }
  const refresh = () => cache.invalidateQueries({ queryKey: ['approvals', owner] })
  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const claim = async (saved: Journal): Promise<Journal> => {
    if (typeof approval.payload.actionHash !== 'string') throw new Error('The request has no frozen action hash.')
    const reply = await fleetRequest<{ claimId: string }>(`/api/approvals/${encodeURIComponent(approval.id)}/claim`, {
      method: 'POST',
      owner,
      body: {
        actionHash: approval.payload.actionHash,
        ...(saved.claimId === undefined ? {} : { claimId: saved.claimId }),
      },
    })
    return commit({ ...saved, claimId: reply.claimId })
  }
  const prepare = async () => {
    if (record === null) throw new Error('The durable operation record is unavailable.')
    guard()
    if (approval.expiresAt <= Date.now() / 1000 && record.signature === undefined && record.transactions === undefined)
      throw new Error('This request expired before execution started.')
    let next = await claim(commit(record))
    guard()
    if (operation.result.sign !== undefined) {
      if (next.signature === undefined) {
        const expired = approvalSendError(approval.expiresAt)
        if (expired !== null) throw new Error(expired)
        const typed = approvalTypedData(operation, deployment)
        const signature = await signTypedDataAsync(typedDataArgs(typed))
        next = commit({ ...next, signature })
        guard()
      }
      if (!next.continuationDone) {
        const built = await fleetRequest<{ result: { transactions?: TxRequest[] } }>(`/api/approvals/${encodeURIComponent(approval.id)}/continue`, {
          method: 'POST',
          owner,
          body: { claimId: next.claimId, signature: next.signature },
        })
        next = commit({
          ...next,
          continuationDone: true,
          ...(built.result.transactions === undefined ? {} : { transactions: frozenTransactions(built.result.transactions, chain.id) }),
        })
        await refresh()
      }
      if (operation.tool === 'select_worker' && next.continuationDone) {
        await fleetRequest(`/api/approvals/${encodeURIComponent(approval.id)}/complete`, {
          method: 'POST',
          owner,
          body: { claimId: next.claimId, transactionHashes: [] },
        })
        next = commit({ ...next, completed: true })
        await refresh()
      }
    } else if (next.transactions === undefined) {
      next = commit({
        ...next,
        transactions: frozenTransactions(operation.result.transactions, chain.id),
      })
    }
    if (!next.completed && (next.transactions?.length ?? 0) === 0) throw new Error('This request contains no executable wallet steps. Nothing was sent.')
  }
  const finish = async (saved: Journal) => {
    if (saved.hashes === undefined || saved.claimId === undefined) throw new Error('The saved receipt or claim is missing. No transaction will be resent.')
    guard()
    const taskId = operation.result.taskId ?? (typeof operation.args.taskId === 'string' ? operation.args.taskId : undefined)
    for (const txHash of saved.hashes) {
      if (operation.result.operationId !== undefined)
        await boardApi(operation.boardId).tool('report_transaction', {
          operationId: operation.result.operationId,
          txHash,
        })
      else if (taskId !== undefined) await boardApi(operation.boardId).tool('report_transaction', { taskId, txHash })
    }
    await fleetRequest(`/api/approvals/${encodeURIComponent(approval.id)}/complete`, {
      method: 'POST',
      owner,
      body: { claimId: saved.claimId, transactionHashes: saved.hashes },
    })
    commit({ ...saved, completed: true })
    await refresh()
  }
  const receiptHashes = approval.execution?.transactionHashes ?? record?.hashes ?? []
  const completed = approval.execution?.state === 'completed' || record?.completed === true
  const claimedElsewhere = approval.execution?.state === 'claimed' && record?.claimId === undefined
  return (
    <div className="grid gap-4 border-t border-sep pt-4">
      <h2 className="section-title">{completed ? 'Operation completed' : 'Complete with the agent wallet'}</h2>
      {completed ? (
        <p className="text-sm text-ok">
          {operation.tool === 'select_worker'
            ? 'Your signed selection is stored. The worker confirms it during activation.'
            : 'The exact wallet operation was confirmed and recorded.'}
        </p>
      ) : (
        <>
          <p className="text-sm leading-relaxed text-label-2">
            Sign as {agentName}. Each wallet step is recorded before it is sent. A reload resumes the saved operation.
          </p>
          <p className="text-xs text-label-2">
            Current signer: <Address value={account.address ?? 'not connected'} /> · {selected ? 'correct network' : `select this agent on ${chain.name}`}
          </p>
          {!selected && (
            <Button
              variant="tinted"
              busy={wallets?.busy}
              disabled={wallets === null}
              onClick={() =>
                void run(async () => {
                  await wallets?.select(operation.from)
                })
              }
            >
              Use {agentName}’s wallet
            </Button>
          )}
          {selected && !auth.signedIn && (
            <Button busy={busy} onClick={() => void run(auth.signIn)}>
              Sign in as this agent
            </Button>
          )}
          {claimedElsewhere && (
            <ErrorText>This operation was started in another browser. Reconcile it there before continuing; Hireling will not send it again here.</ErrorText>
          )}
          {record !== null && !claimedElsewhere && record.hashes === undefined && record.transactions === undefined && (
            <Button busy={busy} disabled={!selected || !auth.signedIn || !writesOpen} onClick={() => void run(prepare)}>
              {record.signature === undefined ? 'Review & sign exact operation' : 'Resume saved signature'}
            </Button>
          )}
          {record?.transactions !== undefined && record.hashes === undefined && !claimedElsewhere && (
            <>
              <TransactionReview txs={record.transactions} />
              <TxSteps
                taskId={`approval:${approval.id}`}
                txs={record.transactions}
                owner={operation.from}
                boardId={operation.boardId}
                reportToBoard={false}
                retainRecord
                allowBatch={false}
                allowSponsorship={false}
                requireJournal
                sendGuard={() => approvalSendError(approval.expiresAt)}
                canSend={selected && auth.signedIn && !busy && approval.expiresAt > now}
                onDone={(hashes) => {
                  try {
                    const saved = commit({ ...record, hashes })
                    void run(() => finish(saved))
                  } catch (failure) {
                    setError((failure as Error).message)
                  }
                }}
              />
            </>
          )}
          {record?.hashes !== undefined && (
            <Button busy={busy} disabled={!selected || !auth.signedIn} onClick={() => void run(() => finish(record))}>
              Reconcile saved receipts
            </Button>
          )}
        </>
      )}
      {receiptHashes.map((hash) => (
        <TxLink key={hash} hash={hash} />
      ))}
      {error !== null && <ErrorText>{error}</ErrorText>}
    </div>
  )
}

function TransactionReview({ txs }: { txs: TxRequest[] }) {
  if (txs.length === 0) return null
  return (
    <ol className="grid gap-3">
      {txs.map((tx, i) => (
        <li key={`${i}:${tx.to}:${tx.data}`} className="grid gap-2 rounded-xl bg-fill p-4">
          <strong className="text-sm">
            {i + 1}. {tx.description}
          </strong>
          <dl className="review-grid text-xs">
            <dt>Contract</dt>
            <dd>
              <Address value={tx.to} />
            </dd>
            <dt>Method selector</dt>
            <dd className="font-mono">{tx.data.slice(0, 10)}</dd>
            <dt>Chain / native value</dt>
            <dd>
              {tx.chainId} / {tx.value}
            </dd>
          </dl>
          <details>
            <summary className="text-xs font-semibold text-tint">Exact calldata</summary>
            <code className="mt-2 block break-all text-xs">{tx.data}</code>
          </details>
        </li>
      ))}
    </ol>
  )
}
function prettyJson(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2)
  } catch {
    return json
  }
}

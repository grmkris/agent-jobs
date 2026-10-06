import { useQuery } from '@tanstack/react-query'
import { useLocation } from '@tanstack/react-router'
import { Lock } from 'lucide-react'
import * as sdk from '@agent-jobs/sdk'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { type Address, isAddress } from 'viem'
import { useReadContracts } from 'wagmi'
import { type BoardInfo, DELIVERABLE_KINDS, type DeliverableKind, currentBoardId, data, taskIndex, tool } from '../api.ts'
import { BoardLink, boardRoutes, useBoardNavigate } from '../components/BoardLink.tsx'
import { paidJob } from '../components/job/HireAgain.tsx'
import { Preflight } from '../components/post/Preflight.tsx'
import { ResumeOffer } from '../components/post/Resume.tsx'
import { ScreeningCard } from '../components/post/Screening.tsx'
import { SignInToPublish } from '../components/post/SignInToPublish.tsx'
import {
  type Created,
  type Draft,
  type Frozen,
  type Mode,
  type PostForm,
  type Step,
  type WindowBounds,
  type WindowPreset,
  clearDraft,
  createTaskArgs,
  criteriaList,
  draftKey,
  fingerprint,
  hireAgainPrefill,
  hireTermsProblem,
  hoursText,
  initialForm,
  inviteFrom,
  loadDraft,
  prefillKey,
  prefillToken,
  requestQuotesArgs,
  rewardText,
  saveDraft,
  stepProblem,
  toBase,
  windowForm,
  windowsOf,
} from '../components/post/form.ts'
import { Chip, Choices, Disclosure, FieldRow, KV, LineRow, Mark, Progress, StepNav, Switch } from '../components/post/parts.tsx'
import { useToast } from '../components/Sheet.tsx'
import { When, useNow } from '../components/Time.tsx'
import { TxSteps } from '../components/TxSteps.tsx'
import { Button, CopyButton, ErrorText, Group, Input, ListRow, PageTitle, Section, Segmented, Select, Skeleton, TextArea, cn, rowClass } from '../components/ui.tsx'
import { Monogram, type useSignedIn } from '../components/Wallet.tsx'
import { rewardTokenList, span, tokenInfo } from '../format.ts'
import { hireling } from '../hireling.ts'
import { useToken } from '../useTokens.ts'
import { chain, deployment, isMainnet } from '../wallet.ts'
import { duration } from '../duration.ts'

type Auth = ReturnType<typeof useSignedIn>

/** What a publish from the embed widget reports to its host (ADR-0008 `published`). */
export interface Published {
  taskId: string
  jobId: string | null
  txHash: string | null
}

const MODES: ReadonlyArray<{ value: Mode; title: string; body: string }> = [
  {
    value: 'hire',
    title: 'Direct hire',
    body: 'Name the agent you want, or let agents apply and pick one. The reward is locked in escrow when you publish; the agent starts once it activates and posts its bond, and is paid when you accept the work.',
  },
  {
    value: 'quotes',
    title: 'Request quotes',
    body: 'Agents bid a price. Nothing is locked until you pick a quote; then the job is published at that price and the reward is locked.',
  },
]
const MODE_TITLE: Record<Mode, string> = { hire: 'Direct hire', quotes: 'Request quotes' }

/** The token control's "Other" choice: any ERC-20, typed as an address (the public board only). */
const OTHER = 'other'
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

const DELIVERY: ReadonlyArray<readonly [string, string]> = [
  ['24', '1 day'],
  ['48', '2 days'],
  ['168', '1 week'],
]
const QUOTING: ReadonlyArray<readonly [string, string]> = [
  ['1', '1 h'],
  ['6', '6 h'],
  ['24', '1 day'],
]
const KIND_LABEL: Record<DeliverableKind, string> = { git: 'Git commit', patch: 'Patch', artifact: 'File', url: 'Live URL', onchain: 'On-chain' }

const STEP_TITLE: Record<Step, string> = { 1: 'What needs doing', 2: 'How agents compete', 3: 'Reward and deadline', 4: 'Review' }

/**
 * Post a job: what needs doing, how agents compete, the reward and deadlines, then a review with the advisory
 * screening and a live wallet check before anything is signed. A hire is frozen by the board
 * (`create_task`) on the way to the review and published from inline wallet steps; the reward is escrowed only
 * when the publish transaction confirms. Asking for quotes (`request_quotes`) locks nothing until a quote is picked.
 * The form is kept as a draft per board and address until it is published. `?resume=<taskId>` reopens an offer that
 * was frozen and never published.
 *
 * A hire may carry an execution budget (ADR-0009): what the agent may spend from your wallet on running costs, apart
 * from the reward. It is bound into the offer; you grant it on the job page once the agent has started.
 */
export function PublishPage({ auth, prefill = {}, onPublished }: { auth: Auth; prefill?: Record<string, string>; onPublished?: (p: Published) => void }) {
  // Re-read on every navigation: the same page serves a new job and `?resume=`. The id is read raw; only a value the
  // router quoted (an all-digit id, or one like `1e5…`, which it would otherwise read as a number) is unquoted.
  useLocation()
  const raw = new URLSearchParams(window.location.search).get('resume')
  const resume = raw !== null && /^"[0-9a-f]+"$/.test(raw) ? raw.slice(1, -1) : raw
  if (resume !== null && resume !== '') return <ResumeOffer key={resume} taskId={resume} auth={auth} onPublished={onPublished} />
  const again = new URLSearchParams(window.location.search).get('again')?.replace(/^"(\d+)"$/, '$1')
  if (again !== undefined && /^\d+$/.test(again)) return <HireAgain key={again} jobId={again} auth={auth} onPublished={onPublished} />
  // An agent profile's "Hire this agent": a direct hire with that agent invited. A new agent is a new form.
  const invite = inviteFrom(window.location.search)
  const withInvite = invite === undefined ? prefill : { ...prefill, agentId: invite }
  return <PostFlow key={withInvite.agentId ?? ''} auth={auth} prefill={withInvite} onPublished={onPublished} />
}

/**
 * `?again=<jobId>`: a paid job's offer, read from the board it was published on, as the prefill of a new direct hire
 * of the same agent (`hireAgainPrefill`). Only a paid job with an agent can be hired again.
 */
function HireAgain({ jobId, auth, onPublished }: { jobId: string; auth: Auth; onPublished?: ((p: Published) => void) | undefined }) {
  const detail = useQuery({ queryKey: ['job', jobId], queryFn: () => data<{ job: { status: string; agent_id: string | null; worker: string | null }; board: { boardId: string } | null }>(`jobs/${jobId}`) })
  const boardId = detail.data?.board?.boardId ?? 'public'
  const index = useQuery({ queryKey: ['task_index', boardId], queryFn: () => taskIndex(boardId), enabled: detail.data !== undefined })
  const task = index.data?.find((t) => t.jobId === jobId)
  const reward = useToken(task?.token)
  const budgetToken = task?.executionBudget?.kind === 'advance' ? task.executionBudget.token : null
  const budget = useToken(budgetToken)
  const job = detail.data?.job
  const failed = detail.isError || index.isError
  const eligible = job !== undefined && paidJob(job) && job.agent_id !== null && job.worker !== null && task !== undefined
  if (failed || (detail.data !== undefined && index.data !== undefined && !eligible) || reward === 'none') {
    return (
      <>
        <PageTitle>Hire again</PageTitle>
        <div className="grid gap-3 rounded-2xl bg-surface p-6 text-center">
          <p className="font-semibold">{failed ? `Job #${jobId}'s offer is unavailable right now` : `Job #${jobId} cannot be hired again`}</p>
          <p className="text-sm text-label-2">{failed ? 'Its terms could not be read from the board.' : 'Only a paid job, with the agent that did it, can be hired again.'}</p>
          {failed && <Button variant="tinted" onClick={() => void Promise.all([detail.refetch(), index.refetch()])}>Retry</Button>}
          <BoardLink target={boardRoutes().publish()} className="text-tint">Post a new job instead</BoardLink>
        </div>
      </>
    )
  }
  if (!eligible || typeof reward !== 'object' || (budgetToken !== null && budget === 'reading')) {
    return (
      <>
        <PageTitle>Hire again</PageTitle>
        <div className="grid gap-3" aria-busy="true">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      </>
    )
  }
  const prefill = hireAgainPrefill({
    jobId,
    agentId: job.agent_id as string,
    worker: job.worker as string,
    task,
    decimals: reward.decimals,
    ...(typeof budget === 'object' ? { budgetDecimals: budget.decimals } : {}),
  })
  // An agent profile's "Hire this agent": a direct hire with that agent invited. A new agent is a new form.
  const invite = inviteFrom(window.location.search)
  const withInvite = invite === undefined ? prefill : { ...prefill, agentId: invite }
  return <PostFlow key={withInvite.agentId ?? ''} auth={auth} prefill={withInvite} onPublished={onPublished} />
}

/**
 * Who a Hire again prefill names, and the job it repeats; or, from an agent profile's "Hire this agent", the agent
 * invited while it is still in the Agent field. Shown on every step while the offer is still a hire.
 */
function HiringAgain({ prefill, invite }: { prefill: Record<string, string>; invite: string }) {
  const { agentId, again } = prefill
  if (agentId === undefined) return null
  if (again === undefined)
    return invite !== agentId ? null : (
      <div role="note" className="flex items-start gap-3 rounded-2xl bg-tint/10 px-4 py-3.5">
        <Monogram seed={`agent-${agentId}`} label={agentId.slice(-2)} size="md" />
        <p className="min-w-0 leading-relaxed">
          <span className="block font-semibold">Hiring Agent ID {agentId}</span>
          <span className="block text-sm text-label-2">It is invited: you can select it as soon as the job is published. It starts when it activates.</span>
        </p>
      </div>
    )
  return (
    <div role="note" className="flex items-start gap-3 rounded-2xl bg-tint/10 px-4 py-3.5">
      <Monogram seed={`agent-${agentId}`} label={agentId.slice(-2)} size="md" />
      <p className="min-w-0 leading-relaxed">
        <span className="block font-semibold">Hiring Agent #{agentId} again</span>
        <span className="block text-sm text-label-2">
          The same token, reward and terms as{' '}
          <BoardLink target={boardRoutes().job(again)} className="text-tint">
            job #{again}
          </BoardLink>
          . Agent #{agentId} is invited: you can select it as soon as the job is published. It starts when it activates.
        </span>
      </p>
    </div>
  )
}

function PostFlow({ auth, prefill, onPublished }: { auth: Auth; prefill: Record<string, string>; onPublished?: ((p: Published) => void) | undefined }) {
  const navigate = useBoardNavigate()
  const toast = useToast()
  const now = useNow()
  const boardId = currentBoardId()

  // A tenant board allows only its own tokens (the board refuses others). The public board lists the known tokens and
  // takes any other ERC-20 by address (ADR-0010).
  const boards = useQuery({ queryKey: ['data-boards'], queryFn: () => data<{ boards: BoardInfo[] }>('boards'), staleTime: 300_000 })
  const isPublic = boardId === 'public'
  const board = isPublic ? undefined : boards.data?.boards.find((b) => b.id === boardId)
  const all = rewardTokenList()
  const known = isPublic ? all.filter(([, t]) => t.unverified !== true) : all
  const restricted = board === undefined ? known : known.filter(([a]) => board.rewardTokens.some((t) => t.toLowerCase() === a))
  const tokens = restricted.length > 0 ? restricted : known

  const pk = prefillKey(prefill)
  const key = draftKey(boardId, auth.address)
  const defaults = () => initialForm(prefill, rewardTokenList(), isMainnet)
  const restore = (k: string): Draft | null => {
    const d = loadDraft(k, defaults())
    return d !== null && (d.prefill === pk || d.frozen?.started === true) ? d : null
  }
  const [draft, setDraft] = useState<Draft>(() => restore(key) ?? { v: 1, step: 1, form: defaults(), prefill: pk, frozen: null })
  const [saved, setSaved] = useState(false)
  const [runningOffer, setRunningOffer] = useState<{ frozen: Frozen; owner: string; reward: string } | null>(() => draft.frozen !== null ? { frozen: draft.frozen, owner: draft.frozen.owner, reward: rewardText(draft.frozen.form) } : null)
  const [safeToRestart, setSafeToRestart] = useState(false)
  const dirty = useRef(false)
  const finished = useRef(false)
  const loadedKey = useRef(key)
  const lastPrefill = useRef(pk)
  const tokenTouched = useRef(false)

  const terms = useHireTerms()
  // A prepared offer keeps its signed windows even if the deployment's bounds are unavailable on reload.
  const f = runningOffer === null ? windowForm(draft.form, terms.bounds) : runningOffer.frozen.form
  const step = draft.step
  /** A field the person changed. */
  const set = (patch: Partial<PostForm>) => {
    dirty.current = true
    setDraft((d) => ({ ...d, form: { ...d.form, ...patch } }))
  }
  /** A correction the page makes itself (a token the board does not offer): not a reason to save. */
  const fix = (patch: Partial<PostForm>) => setDraft((d) => ({ ...d, form: { ...d.form, ...patch } }))
  const go = (s: Step) => {
    dirty.current = true
    setDraft((d) => ({ ...d, step: s }))
    window.scrollTo({ top: 0 })
  }

  // Signing in (or switching wallets) mid-way keeps what was typed, now saved for that address; an untouched form
  // picks up that address's own draft.
  useEffect(() => {
    const before = loadedKey.current
    if (key === before) return
    if (draft.frozen !== null || runningOffer !== null) return
    loadedKey.current = key
    const target = restore(key)
    if (target !== null && target.frozen !== null) {
      dirty.current = false
      setDraft(target)
      setRunningOffer({ frozen: target.frozen, owner: target.frozen.owner, reward: rewardText(target.frozen.form) })
      return
    }
    if (dirty.current) {
      clearDraft(before)
      return
    }
    if (target !== null) setDraft(target)
  }, [key])

  useEffect(() => {
    if (!dirty.current || finished.current) return
    setSaved(saveDraft(loadedKey.current, draft))
  }, [draft, key])

  // The embed's host may send a prefill after the widget loaded (postMessage): it sets the fields it names.
  useEffect(() => {
    if (runningOffer !== null || draft.frozen !== null) return
    if (pk === lastPrefill.current) return
    lastPrefill.current = pk
    const p = defaults()
    const patch: Partial<PostForm> = {}
    if (prefill.title !== undefined) patch.title = p.title
    if (prefill.brief !== undefined) patch.brief = p.brief
    if (prefill.reward !== undefined) patch.reward = p.reward
    if (prefill.mode !== undefined) patch.mode = p.mode
    const t = prefillToken(prefill, rewardTokenList())
    if (t !== undefined) patch.token = t
    setDraft((d) => ({ ...d, prefill: pk, form: { ...d.form, ...patch } }))
  }, [pk])

  // A board token (e.g. $CHOMP) the prefill named is known only once /data/boards answers.
  useEffect(() => {
    if (runningOffer !== null || draft.frozen !== null) return
    if (tokenTouched.current) return
    const t = prefillToken(prefill, rewardTokenList())
    if (t !== undefined && t !== f.token) fix({ token: t })
  }, [known.length])

  // "Other": a token the public board does not list, typed as an address and read from the chain.
  const [otherPicked, setOtherPicked] = useState(false)
  const other = isPublic && (otherPicked || (f.token !== '' && !tokens.some(([a]) => a === f.token)))
  const lookup = useToken(other ? f.token : null)

  const tokenIds = tokens.map(([a]) => a).join()
  useEffect(() => {
    if (runningOffer !== null || draft.frozen !== null) return
    const ids = tokens.map(([a]) => a)
    const first = ids[0]
    if (first === undefined) return
    const patch: Partial<PostForm> = {}
    if (!ids.includes(f.token) && !other) patch.token = first
    if (board !== undefined && f.quoteTokens.some((a) => !ids.includes(a))) {
      const kept = f.quoteTokens.filter((a) => ids.includes(a))
      patch.quoteTokens = kept.length > 0 ? kept : ids
    }
    if (Object.keys(patch).length > 0) fix(patch)
  }, [tokenIds, f.token, board !== undefined, other])

  // The frozen offer, while the form still describes it; an edit afterwards means freezing again.
  const fp = fingerprint(f)
  const matching = runningOffer?.frozen ?? (draft.frozen !== null && draft.frozen.fp === fp && f.mode !== 'quotes' ? draft.frozen : null)
  // A kept draft whose offer reached the chain after all (the page closed mid-publish) must not be published twice:
  // the board is asked once whether it became a job.
  const frozenTask = draft.frozen?.created.taskId
  const onChain = useQuery({
    queryKey: ['post-frozen', boardId, frozenTask, auth.address, auth.signedIn],
    queryFn: () => tool<{ jobId: string | null; creator: string }>('get_task', { taskId: frozenTask }),
    enabled: frozenTask !== undefined,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })
  const publishedAs = onChain.data?.jobId ?? null
  // Deadlines count from the moment the offer was frozen: one prepared too long ago is prepared again.
  const expired = matching !== null && matching.deliveryDeadline <= now + 60
  const frozen = matching !== null && !expired && publishedAs === null ? matching : null
  const [freezing, setFreezing] = useState(false)
  const [freezeError, setFreezeError] = useState<string | null>(null)
  const freeze = async () => {
    const owner = auth.address
    if (owner === undefined || runningOffer !== null) return
    if (hireTermsProblem(f, terms.bounds, owner) !== null) return
    const form = structuredClone(f)
    const at = Math.floor(Date.now() / 1000)
    const args = createTaskArgs(form, at)
    setFreezing(true)
    setFreezeError(null)
    try {
      const created = await tool<Created>('create_task', args)
      dirty.current = true
      loadedKey.current = draftKey(boardId, owner)
      const prepared = { owner, form, fp: fingerprint(form), at, deliveryDeadline: args.deliveryDeadline, created }
      setDraft((d) => ({ ...d, frozen: prepared }))
      setRunningOffer({ frozen: prepared, owner, reward: rewardText(form) })
    } catch (e) {
      setFreezeError((e as Error).message)
    } finally {
      setFreezing(false)
    }
  }

  const [asking, setAsking] = useState(false)
  const [walletBusy, setWalletBusy] = useState(false)
  const [askError, setAskError] = useState<string | null>(null)
  const finish = () => {
    finished.current = true
    clearDraft(loadedKey.current)
  }
  const startOver = () => {
    clearDraft(loadedKey.current)
    dirty.current = false
    setSaved(false)
    setRunningOffer(null)
    loadedKey.current = key
    setDraft({ v: 1, step: 1, form: defaults(), prefill: pk, frozen: null })
  }
  const reward = rewardText(f)

  const askForQuotes = async () => {
    setAsking(true)
    setAskError(null)
    try {
      const r = await tool<{ requestId: string }>('request_quotes', requestQuotesArgs(f, Math.floor(Date.now() / 1000)))
      finish()
      toast('Asking for quotes')
      await navigate(boardRoutes().quoteRequest(r.requestId))
    } catch (e) {
      setAskError((e as Error).message)
    } finally {
      setAsking(false)
    }
  }

  const published = async (created: Created, hashes: string[]) => {
    const jobId = await tool<{ jobId: string | null }>('get_task', { taskId: created.taskId }).then(
      (t) => t.jobId,
      () => null,
    )
    finish()
    toast(`Published · ${reward} locked in escrow`)
    if (onPublished !== undefined) onPublished({ taskId: created.taskId, jobId, txHash: hashes.at(-1) ?? null })
    else await navigate(jobId !== null ? boardRoutes().job(jobId) : boardRoutes().jobs())
  }

  const problem = stepProblem(f, step) ?? (step === 3 && f.mode === 'hire' ? hireTermsProblem(f, terms.bounds, auth.address) : null)
  const status = saved && dirty.current ? 'Draft saved' : ''
  const quotes = f.mode === 'quotes'
  const hours = (h: string) => now + Math.round(Number(h) * 3600)
  const deliverBy = frozen?.deliveryDeadline ?? hours(f.deliveryHours)
  const symbol = tokenInfo(f.token).symbol
  const tokenOptions = [...tokens.map(([a, t]) => [a, t.symbol] as const), ...(isPublic ? [[OTHER, 'Other'] as const] : [])]
  const pickToken = (token: string) => {
    tokenTouched.current = true
    setOtherPicked(token === OTHER)
    set({ token: token === OTHER ? '' : token })
  }
  const tokenHint =
    lookup === 'reading'
      ? 'Reading the token from the chain…'
      : typeof lookup === 'object'
        ? `${lookup.symbol}, ${lookup.decimals} decimals. Unverified: anyone can deploy a token under any name, so check the address.`
        : f.token === ''
          ? 'Any ERC-20 on Monad. Its symbol and decimals are read from the chain.'
          : !isAddress(f.token, { strict: false })
            ? 'A contract address: 0x and 40 hex digits.'
            : `Not an ERC-20 on ${chain.name}: it must answer symbol() and decimals().`
  const criteria = criteriaList(f.criteria)
  const kinds = f.accepts.map((k) => KIND_LABEL[k]).join(', ')

  const next = (to: Step) => (
    <Button size="lg" type="submit" disabled={problem !== null} className="shrink-0">
      {to === 4 ? 'Review' : 'Continue'}
    </Button>
  )

  return (
    <>
      <PageTitle>{prefill.again !== undefined && f.mode === 'hire' ? 'Hire again' : 'Post a job'}</PageTitle>
      {f.mode === 'hire' && <HiringAgain prefill={prefill} invite={f.invite} />}
      {publishedAs !== null && (
        <div role="status" className="grid gap-2 rounded-xl bg-ok-bg px-4 py-3 text-sm text-ok">
          <span>This draft was already published, as job #{publishedAs}.</span>
          <span className="flex flex-wrap gap-4 font-semibold">
            <BoardLink target={boardRoutes().job(publishedAs)} className="underline">
              Open the job
            </BoardLink>
            <button type="button" className="underline" onClick={startOver}>
              Post another job
            </button>
          </span>
        </div>
      )}
      <form
        className="grid gap-6"
        onSubmit={(e) => {
          e.preventDefault()
          if (problem !== null || step === 4) return
          if (step === 3) {
            go(4)
            if (!quotes && auth.signedIn && frozen === null && !freezing && publishedAs === null) void freeze()
          } else go((step + 1) as Step)
        }}
      >
        <fieldset disabled={runningOffer !== null} className="contents">
        <div className="grid gap-2">
          <Progress step={step} of={4} />
          <p className="px-1 text-ui text-label-2">
            Step {step} of 4 · {step === 3 && quotes ? 'Quotes and deadline' : STEP_TITLE[step]}
          </p>
        </div>

        <div key={step} className="grid animate-[view-in_0.32s_var(--ease-spring)] gap-6">
          {step === 1 && (
            <Section title="What needs doing" note="Agents read all of this before they take the job. The work is judged against exactly these criteria.">
              <Group>
                <FieldRow label="Title" htmlFor="post-title">
                  <Input id="post-title" value={f.title} onChange={(e) => set({ title: e.target.value })} placeholder="A short name for the job" autoComplete="off" enterKeyHint="next" />
                </FieldRow>
                <FieldRow label="Brief · what done looks like, with the repository link" htmlFor="post-brief">
                  <TextArea id="post-brief" value={f.brief} onChange={(e) => set({ brief: e.target.value })} rows={5} placeholder="What needs doing, where, and anything the agent must not touch." />
                </FieldRow>
                <FieldRow label="Accepted when · one per line" htmlFor="post-criteria">
                  <TextArea id="post-criteria" value={f.criteria} onChange={(e) => set({ criteria: e.target.value })} rows={3} />
                </FieldRow>
              </Group>
            </Section>
          )}

          {step === 2 && (
            <>
              <Section title="How agents compete">
                <Choices label="How agents compete" value={f.mode} onChange={(mode) => set({ mode })} options={MODES} />
              </Section>
              {f.mode === 'hire' && (
                <Section note="A named agent is invited: you can select it as soon as the job is published. Leave it empty and agents apply.">
                  <Group>
                    <FieldRow label="Agent to hire · optional" htmlFor="post-invite">
                      <Input id="post-invite" value={f.invite} onChange={(e) => set({ invite: e.target.value.trim() })} inputMode="numeric" placeholder="Agent number, like 1942" autoComplete="off" />
                    </FieldRow>
                  </Group>
                </Section>
              )}
            </>
          )}

          {step === 3 && (
            <>
              {quotes ? (
                <Section title="Quotes" note="Agents quote an exact amount in one of these tokens. Nothing is locked until you pick a quote; then the job is published at that price.">
                  <Group>
                    <LineRow label="Accepted tokens" stack>
                      <span className="flex flex-wrap gap-2">
                        {tokens.map(([address, t]) => (
                          <Chip
                            key={address}
                            on={f.quoteTokens.includes(address)}
                            onClick={() => set({ quoteTokens: f.quoteTokens.includes(address) ? f.quoteTokens.filter((x) => x !== address) : [...f.quoteTokens, address] })}
                          >
                            {t.symbol}
                          </Chip>
                        ))}
                      </span>
                    </LineRow>
                    <LineRow label="Quotes close in" note={<>Closes <When at={hours(f.quoteHours)} show="time" /></>} stack>
                      <HoursPicker id="post-quote-hours" value={f.quoteHours} presets={QUOTING} onChange={(quoteHours) => set({ quoteHours })} />
                    </LineRow>
                    <LineRow label="Deliver within" note={<>Due <When at={hours(f.deliveryHours)} show="time" /></>} stack>
                      <HoursPicker id="post-delivery-hours" value={f.deliveryHours} presets={DELIVERY} onChange={(deliveryHours) => set({ deliveryHours })} />
                    </LineRow>
                  </Group>
                </Section>
              ) : (
                <Section title="Reward and deadline" note="The reward is locked in escrow when you publish and paid only when the work is accepted.">
                  <Group>
                    <LineRow label="Token" stack={tokenOptions.length > 2} note={!other && tokenInfo(f.token).unverified === true ? `Unverified token ${short(f.token)}: check the address` : undefined}>
                      {tokenOptions.length <= 4 ? (
                        <Segmented label="Reward token" value={other ? OTHER : f.token} options={tokenOptions} onChange={pickToken} className="sm:min-w-[14rem]" />
                      ) : (
                        <Select aria-label="Reward token" value={other ? OTHER : f.token} onChange={(e) => pickToken(e.target.value)} className="w-auto">
                          {tokenOptions.map(([a, label]) => (
                            <option key={a} value={a}>
                              {label}
                            </option>
                          ))}
                        </Select>
                      )}
                    </LineRow>
                    {other && (
                      <FieldRow label="Token address" htmlFor="post-token" hint={tokenHint}>
                        <Input
                          id="post-token"
                          value={f.token}
                          onChange={(e) => set({ token: e.target.value.trim().toLowerCase() })}
                          placeholder="0x…"
                          autoComplete="off"
                          spellCheck={false}
                          className="font-mono text-ui"
                        />
                      </FieldRow>
                    )}
                    <LineRow label="Amount" htmlFor="post-reward">
                      <Input id="post-reward" value={f.reward} onChange={(e) => set({ reward: e.target.value })} inputMode="decimal" autoComplete="off" className="tabular w-28 text-right" />
                      <span className="w-12 shrink-0 text-label-2">{symbol}</span>
                    </LineRow>
                    <LineRow label="Deliver within" note={<>Due <When at={hours(f.deliveryHours)} show="time" /></>} stack>
                      <HoursPicker id="post-delivery-hours" value={f.deliveryHours} presets={DELIVERY} onChange={(deliveryHours) => set({ deliveryHours })} />
                    </LineRow>
                  </Group>
                </Section>
              )}
              {f.mode === 'hire' && <HireTerms f={f} set={set} bounds={terms.bounds} defaultArbitrator={terms.defaultArbitrator} />}
              <Advanced f={f} set={set} />
            </>
          )}

          {step === 4 && (
            <>
              <Section title="What agents will see">
                <Group>
                  <ListRow>
                    <span className="grid min-w-0 gap-1 py-1">
                      <span className="font-semibold [overflow-wrap:anywhere]">{f.title}</span>
                      <span className="text-sm leading-relaxed whitespace-pre-wrap text-label-2 [overflow-wrap:anywhere]">{f.brief}</span>
                    </span>
                  </ListRow>
                  {criteria.length > 0 && (
                    <ListRow>
                      <span className="grid min-w-0 gap-1 py-1">
                        <span className="text-ui text-label-2">Accepted when</span>
                        <ul className="grid list-disc gap-0.5 pl-5 text-sm [overflow-wrap:anywhere]">
                          {criteria.map((c, i) => (
                            <li key={`${i}-${c}`}>{c}</li>
                          ))}
                        </ul>
                      </span>
                    </ListRow>
                  )}
                  <KV label="How agents compete">{MODE_TITLE[f.mode]}</KV>
                  {f.mode === 'hire' && f.invite !== '' && <KV label="Agent">Agent #{f.invite} · invited</KV>}
                  {quotes ? (
                    <>
                      <KV label="Accepted tokens">{f.quoteTokens.map((a) => tokenInfo(a).symbol).join(', ')}</KV>
                      <KV label="Quotes close">
                        <When at={hours(f.quoteHours)} />
                      </KV>
                    </>
                  ) : (
                    <KV label="Reward" note={tokenInfo(f.token).unverified === true ? `Unverified token ${short(f.token)}` : undefined}>
                      <span className="tabular font-semibold text-label">{reward}</span>
                    </KV>
                  )}
                  <KV label="Deliver by">
                    <When at={deliverBy} />
                  </KV>
                  <KV label="Deliver as">{kinds}</KV>
                  {f.accepts.includes('git') && f.check.trim() !== '' && (
                    <KV label="Required GitHub check">
                      <code className="font-mono text-ui">{f.check.trim()}</code>
                    </KV>
                  )}
                  {f.mode === 'hire' ? (
                    <>
                      <KV label="Windows">{windowsText(f)}</KV>
                      <KV label="Arbitrator">{f.arbitrator.trim() === '' ? "Hireling's arbiter" : <span className="font-mono text-ui [overflow-wrap:anywhere]">{f.arbitrator.trim()} · yours</span>}</KV>
                      <KV label="Bonds">{`${f.creatorBond} FACTORY reserved from your stake · at least ${f.workerBond} from the agent's`}</KV>
                    </>
                  ) : (
                    <KV label="Bonds">{`${f.creatorBond} FACTORY from you · ${f.workerBond} from the agent`}</KV>
                  )}
                  {f.mode === 'hire' && f.budgetOn && (
                    <KV label="Running-cost budget">{f.budgetKind === 'call' ? `Up to ${f.callCap} MON for one contract call` : `Up to ${f.budgetCap} ${tokenInfo(f.budgetToken).symbol}`}</KV>
                  )}
                </Group>
              </Section>

              {!quotes && (
                <ScreeningCard
                  screening={frozen?.created.screening}
                  pending={
                    frozen !== null ? undefined : !auth.signedIn ? (
                      <ListRow>
                        <Mark tone="none" />
                        <span className="flex-1 text-label-2">Screened once you sign in and prepare the offer</span>
                      </ListRow>
                    ) : freezing ? (
                      <ListRow>
                        <Mark tone="wait" />
                        <span className="min-w-0 flex-1">
                          <span className="block">Screening your brief…</span>
                          <span className="block text-ui text-label-2">This can take up to a minute.</span>
                        </span>
                      </ListRow>
                    ) : (
                      <ListRow>
                        <Mark tone={freezeError !== null ? 'bad' : 'none'} />
                        <span className="grid min-w-0 flex-1 gap-1">
                          {freezeError !== null ? (
                            <ErrorText>The board could not prepare this offer: {freezeError}</ErrorText>
                          ) : expired ? (
                            <span className="text-label-2">Prepared too long ago: its deadlines have passed. Prepare it again.</span>
                          ) : (
                            <span className="text-label-2">Not screened yet</span>
                          )}
                        </span>
                        <Button size="sm" variant="tinted" disabled={publishedAs !== null} onClick={() => void freeze()}>
                          {freezeError !== null ? 'Try again' : expired ? 'Prepare again' : 'Screen it'}
                        </Button>
                      </ListRow>
                    )
                  }
                />
              )}

              <Preflight
                address={auth.signedIn ? auth.address : undefined}
                token={quotes ? undefined : f.token}
                reward={quotes ? undefined : toBase(f.reward, f.token)}
                bond={toBase(f.creatorBond, deployment.factory)}
                later={quotes}
              />

              {!quotes && (
                <div className="flex items-center gap-3.5 rounded-xl bg-surface p-4">
                  <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-tint/14 text-tint">
                    <Lock aria-hidden className="size-5" />
                  </span>
                  <span className="min-w-0">
                    <span className="tabular block text-2xl leading-tight font-bold tracking-[-0.02em] [overflow-wrap:anywhere]">{reward}</span>
                    <span className="block text-sm text-label-2">
                      Locked in escrow when you publish · due <When at={deliverBy} show="relative" />
                    </span>
                  </span>
                </div>
              )}

              {frozen !== null && (
                <Disclosure title="Details">
                  <div className={rowClass()}>
                    <span className="flex-1">Offer ID</span>
                    <span className="font-mono text-ui text-label-2">{frozen.created.taskId}</span>
                    <CopyButton value={frozen.created.taskId} label="Copy offer ID" />
                  </div>
                  <KV label="Prepared">
                    <When at={frozen.at} />
                  </KV>
                  <a href={frozen.created.manifestUrl} target="_blank" rel="noreferrer" className={cn(rowClass({ interactive: true }), 'text-tint')}>
                    The full terms, as agents read them
                  </a>
                </Disclosure>
              )}
              {askError !== null && <ErrorText>{askError}</ErrorText>}
            </>
          )}
        </div>

        {problem !== null && step !== 4 && (dirty.current || step > 1) && <p className="px-4 text-sm text-label-2">{problem}</p>}
        <StepNav onBack={step === 1 || walletBusy ? undefined : () => go((step - 1) as Step)} status={status} stack={step === 4}>
          {step < 3 ? (
            next((step + 1) as Step)
          ) : step === 3 ? (
            next(4)
          ) : !auth.signedIn ? (
            <SignInToPublish auth={auth} label={quotes ? 'Sign in to ask for quotes' : 'Sign in to publish'} />
          ) : quotes ? (
            <Button size="lg" busy={asking} onClick={() => void askForQuotes()}>
              Ask for quotes
            </Button>
          ) : frozen !== null ? (
            <p className="min-w-0 text-center text-sm text-label-2">Complete the wallet steps below to publish {reward}.</p>
          ) : (
            <Button size="lg" busy={freezing} disabled={publishedAs !== null} onClick={() => void freeze()}>
              Prepare to publish
            </Button>
          )}
        </StepNav>
        </fieldset>
      </form>

      {(step === 4 || runningOffer !== null) && matching !== null && (auth.signedIn || runningOffer !== null || matching.owner !== undefined) && publishedAs === null && (
        <Section
          title="Publish"
          note="Your wallet sends the reward approval and the publish transaction in order; your bond is reserved from your stake. Only the wallet confirmation is an overlay."
        >
          {onChain.isError && <ErrorText>The saved offer could not be checked. Retry before publishing. <Button variant="plain" onClick={() => void onChain.refetch()}>Retry</Button></ErrorText>}
          {expired && <ErrorText>This offer has expired. Prepare a new offer before confirming any new steps.</ErrorText>}
          {matching.owner?.toLowerCase() !== auth.address?.toLowerCase() && <ErrorText>Return to the wallet that prepared this offer before confirming more steps.</ErrorText>}
          {expired && safeToRestart && <Button variant="tinted" onClick={startOver}>Start a new offer</Button>}
          <TxSteps
            key={matching.created.taskId}
            taskId={matching.created.taskId}
            txs={matching.created.transactions}
            owner={matching.owner ?? onChain.data?.creator}
            canSend={!expired && onChain.isSuccess && matching.owner?.toLowerCase() === auth.address?.toLowerCase() && onChain.data?.creator.toLowerCase() === matching.owner.toLowerCase()}
            onSafeToRestartChange={setSafeToRestart}
            onBusyChange={(busy) => {
              setWalletBusy(busy)
              if (busy && matching.owner !== undefined) {
                dirty.current = true
                const snapshot = { ...matching, started: true }
                setRunningOffer((current) => current ?? { frozen: snapshot, owner: matching.owner, reward })
                setDraft((current) => current.frozen?.started === true ? current : { ...current, frozen: snapshot, form: snapshot.form })
              }
            }}
            onDone={(hashes) => void published(matching.created, hashes)}
          />
        </Section>
      )}
    </>
  )
}

/** The Holding's window bounds and its default arbitrator (Hireling's arbiter), read once from the chain. */
function useHireTerms(): { bounds: WindowBounds | null; defaultArbitrator: Address | null } {
  const reads = useReadContracts({
    contracts: (['MIN_REVIEW_WINDOW', 'MAX_REVIEW_WINDOW', 'MIN_DISPUTE_WINDOW', 'MAX_DISPUTE_WINDOW', 'MIN_ARBITRATION_WINDOW', 'MAX_ARBITRATION_WINDOW', 'defaultArbitrator'] as const).map(
      (functionName) => ({ address: hireling.holding, abi: sdk.hirelingHoldingAbi, functionName, chainId: chain.id }) as const,
    ),
    query: { staleTime: 300_000 },
  })
  const r = reads.data
  if (r === undefined || r.some((x) => x.status !== 'success')) return { bounds: null, defaultArbitrator: null }
  const n = (i: number) => Number(r[i]?.result)
  for (const i of [0, 2, 4]) {
    if (!Number.isSafeInteger(n(i)) || !Number.isSafeInteger(n(i + 1)) || n(i) <= 0 || n(i) > n(i + 1)) return { bounds: null, defaultArbitrator: null }
  }
  return { bounds: { review: [n(0), n(1)], dispute: [n(2), n(3)], arbitration: [n(4), n(5)] }, defaultArbitrator: r[6]?.result as Address }
}

const WINDOW_LABEL: Record<WindowPreset, string> = { fast: 'Fast', standard: 'Standard', long: 'Long', custom: 'Custom' }
const windowsText = (f: PostForm) => {
  const w = windowsOf(f)
  return `review ${span(w.reviewSeconds)} · dispute ${span(w.disputeSeconds)} · arbitration ${span(w.arbitrationSeconds)}`
}

/**
 * A hire's terms (ADR-0011): how long the approver has to review, the agent to dispute and the arbitrator to rule;
 * who arbitrates (Hireling's arbiter by default, by name); and the bonds, reserved from stake.
 */
function HireTerms({ f, set, bounds, defaultArbitrator }: { f: PostForm; set: (p: Partial<PostForm>) => void; bounds: WindowBounds | null; defaultArbitrator: Address | null }) {
  const [customArbiter, setCustomArbiter] = useState(f.arbitrator !== '')
  return (
    <>
      <Section title="Windows" note="Silence when the review window closes counts as acceptance. A rejection can be disputed within the dispute window; the arbitrator then has the arbitration window to rule.">
        <Group>
          <LineRow label="Preset" note={bounds === null ? 'Window limits are unavailable until the chain answers.' : windowsText(f)} stack>
            <Segmented
              label="Windows"
              value={f.windowPreset}
              options={(['fast', 'standard', 'long', 'custom'] as const).map((p) => [p, WINDOW_LABEL[p]] as const)}
              onChange={(windowPreset) => set({ ...f, windowPreset })}
              className="sm:min-w-[19rem]"
            />
          </LineRow>
          {f.windowPreset === 'custom' && (
            <>
              {([['reviewHours', 'Review', 'review'], ['disputeHours', 'Dispute', 'dispute'], ['arbitrationHours', 'Arbitration', 'arbitration']] as const).map(([field, label, name]) => (
                <LineRow key={field} label={label} note={bounds === null ? 'Window limits unavailable' : `${duration(bounds[name][0])} to ${duration(bounds[name][1])}`} htmlFor={`post-${field}`}>
                  <Input id={`post-${field}`} value={f[field]} onChange={(e) => set({ [field]: e.target.value })} inputMode="decimal" className="tabular w-20 text-right" />
                  <span className="w-12 shrink-0 text-label-2">hours</span>
                </LineRow>
              ))}
            </>
          )}
        </Group>
      </Section>

      <Section title="Arbitrator">
        <Group>
          <LineRow label="Who rules on a dispute" stack>
            <Segmented
              label="Arbitrator"
              value={customArbiter ? 'custom' : 'hireling'}
              options={[['hireling', "Hireling's arbiter"], ['custom', 'Someone else']] as const}
              onChange={(v) => {
                setCustomArbiter(v === 'custom')
                if (v === 'hireling') set({ arbitrator: '' })
              }}
              className="sm:min-w-[19rem]"
            />
          </LineRow>
          {customArbiter ? (
            <FieldRow label="Arbitrator's address" htmlFor="post-arbitrator">
              <Input id="post-arbitrator" value={f.arbitrator} onChange={(e) => set({ arbitrator: e.target.value.trim() })} placeholder="0x…" autoComplete="off" spellCheck={false} className="font-mono text-ui" />
            </FieldRow>
          ) : (
            <div className={cn(rowClass(), 'flex-col items-start gap-0.5')}>
              <span>Hireling's arbiter</span>
              {defaultArbitrator === null ? <span className="text-label-3">Reading…</span> : <span className="font-mono text-xs text-label-2 [overflow-wrap:anywhere]">{defaultArbitrator}</span>}
            </div>
          )}
        </Group>
        {customArbiter && (
          <p role="alert" className="mx-1 mt-2 rounded-xl bg-warn-bg px-4 py-3 text-sm leading-snug text-warn">
            A custom arbitrator rules on disputes instead of Hireling's arbiter: their ruling decides who is paid and can burn a bond. Choose someone you and the agent both trust. It cannot be you.
          </p>
        )}
      </Section>

      <Section title="Bonds" note="Bonds are reserved from stake, not sent: yours when you publish, the agent's when it activates. A reserved bond is returned unless a ruling, or a missed deadline, burns it.">
        <Group>
          <LineRow label="Your bond" note="Reserved from your stake when you publish." htmlFor="post-creator-bond">
            <Input id="post-creator-bond" value={f.creatorBond} onChange={(e) => set({ creatorBond: e.target.value })} inputMode="decimal" className="tabular w-20 text-right" />
            <span className="w-16 shrink-0 text-label-2">FACTORY</span>
          </LineRow>
          <LineRow label="Agent's bond, at least" note="The agent must have this much stake free to activate the job." htmlFor="post-worker-bond">
            <Input id="post-worker-bond" value={f.workerBond} onChange={(e) => set({ workerBond: e.target.value })} inputMode="decimal" className="tabular w-20 text-right" />
            <span className="w-16 shrink-0 text-label-2">FACTORY</span>
          </LineRow>
        </Group>
      </Section>
    </>
  )
}

/** Presets for a span of hours, plus any number of hours. */
function HoursPicker({ id, value, presets, onChange }: { id: string; value: string; presets: ReadonlyArray<readonly [string, string]>; onChange: (hours: string) => void }) {
  const [custom, setCustom] = useState(() => !presets.some(([v]) => v === value))
  return (
    <span className="grid gap-2 sm:min-w-[19rem]">
      <Segmented
        label="Presets"
        value={custom ? 'custom' : value}
        options={[...presets, ['custom', 'Custom'] as const]}
        onChange={(v) => {
          if (v === 'custom') setCustom(true)
          else {
            setCustom(false)
            onChange(v)
          }
        }}
      />
      {custom && (
        <span className="flex items-center gap-2">
          <Input id={id} aria-label="Hours" value={value} onChange={(e) => onChange(e.target.value)} inputMode="decimal" className="tabular text-right" />
          <span className="shrink-0 text-label-2">hours · {hoursText(value)}</span>
        </span>
      )}
    </span>
  )
}

/** What a hire sets in its own terms (windows, arbitrator, bonds) a request for quotes sets here, with the rest. */
function Advanced({ f, set }: { f: PostForm; set: (p: Partial<PostForm>) => void }) {
  const hire = f.mode === 'hire'
  const summary: ReactNode = hire ? `Delivery${f.budgetOn ? ', budget' : ''}` : 'Bonds, delivery'
  return (
    <Section note={hire ? undefined : 'Bonds are in FACTORY. Both are held by the contracts, never by Hireling.'}>
      <Disclosure title="Advanced" summary={summary}>
        {!hire && (
          <>
            <LineRow label="Your bond" note="Returned unless a ruling finds you acted in bad faith." htmlFor="post-creator-bond">
              <Input id="post-creator-bond" value={f.creatorBond} onChange={(e) => set({ creatorBond: e.target.value })} inputMode="decimal" className="tabular w-20 text-right" />
              <span className="w-16 shrink-0 text-label-2">FACTORY</span>
            </LineRow>
            <LineRow label="Agent's bond" note="Burned if the agent misses the deadline or cheats; returned otherwise." htmlFor="post-worker-bond">
              <Input id="post-worker-bond" value={f.workerBond} onChange={(e) => set({ workerBond: e.target.value })} inputMode="decimal" className="tabular w-20 text-right" />
              <span className="w-16 shrink-0 text-label-2">FACTORY</span>
            </LineRow>
          </>
        )}
        <LineRow label="Deliver as" note="Agents host the work themselves (a fork on any git host, IPFS, a server, the chain); Hireling records where it is and checks it once." stack>
          <span className="flex flex-wrap gap-2 sm:max-w-[19rem] sm:justify-end">
            {DELIVERABLE_KINDS.map(({ kind }) => (
              <Chip
                key={kind}
                on={f.accepts.includes(kind)}
                onClick={() => set({ accepts: DELIVERABLE_KINDS.map((k) => k.kind).filter((k) => (k === kind ? !f.accepts.includes(kind) : f.accepts.includes(k))) })}
              >
                {KIND_LABEL[kind]}
              </Chip>
            ))}
          </span>
        </LineRow>
        <FieldRow label="Where you want it (optional)" htmlFor="post-target" hint='For example "PR-able against github.com/o/r at main" or "an mp4 on IPFS".'>
          <Input id="post-target" value={f.target} onChange={(e) => set({ target: e.target.value })} autoComplete="off" />
        </FieldRow>
        {f.accepts.includes('git') && (
          <LineRow label="Required GitHub check" note="The evidence must show this check passing on the submitted commit. Leave empty for none." htmlFor="post-check">
            <Input id="post-check" value={f.check} onChange={(e) => set({ check: e.target.value })} autoComplete="off" className="w-32 font-mono text-sm" />
          </LineRow>
        )}
        {hire && <BudgetRows f={f} set={set} />}
      </Disclosure>
    </Section>
  )
}

/** The execution budget (ADR-0009): an advance of a token, or one contract call from the creator's wallet. */
function BudgetRows({ f, set }: { f: PostForm; set: (p: Partial<PostForm>) => void }) {
  const call = f.budgetKind === 'call'
  return (
    <>
      <LineRow label="Running-cost budget" note="Optional. Apart from the reward, the agent may spend up to a cap from your wallet (model calls, compute) until the delivery deadline.">
        <Switch checked={f.budgetOn} onChange={(budgetOn) => set({ budgetOn })} label="Running-cost budget" />
      </LineRow>
      {f.budgetOn && (
        <>
          <LineRow
            label="Kind"
            stack
            note={
              call
                ? 'The agent calls one contract function from your wallet, once, so you are the sender and own what it makes (e.g. a nad.fun token). The cap bounds the MON the call may send; the agent pays the gas.'
                : 'An advance: the agent draws it into its own wallet, up to the cap, and pays its running costs from there.'
            }
          >
            <Segmented
              label="Budget kind"
              value={f.budgetKind}
              options={[
                ['advance', 'Advance'],
                ['call', isMainnet ? 'Contract call' : 'Launch on nad.fun'],
              ]}
              onChange={(budgetKind) => set({ budgetKind })}
              className="sm:min-w-[19rem]"
            />
          </LineRow>
          {call ? (
            <>
              <FieldRow label="Contract" htmlFor="post-call-target">
                <Input id="post-call-target" value={f.callTarget} onChange={(e) => set({ callTarget: e.target.value })} autoComplete="off" spellCheck={false} className="font-mono text-ui" />
              </FieldRow>
              <FieldRow label="Allowed function" htmlFor="post-call-function" hint="Exactly one function, in human-readable ABI form.">
                <Input id="post-call-function" value={f.callFunction} onChange={(e) => set({ callFunction: e.target.value })} autoComplete="off" spellCheck={false} className="font-mono text-xs" />
              </FieldRow>
              <LineRow label="Cap" note={isMainnet ? 'The total MON the call may send.' : 'nad.fun charges a 10 MON deploy fee on testnet.'} htmlFor="post-call-cap">
                <Input id="post-call-cap" value={f.callCap} onChange={(e) => set({ callCap: e.target.value })} inputMode="decimal" className="tabular w-20 text-right" />
                <span className="w-16 shrink-0 text-label-2">MON</span>
              </LineRow>
            </>
          ) : (
            <>
              <FieldRow label="Token" htmlFor="post-budget-token" hint="Any ERC-20 you hold; the reward tokens are suggested.">
                <Input id="post-budget-token" value={f.budgetToken} onChange={(e) => set({ budgetToken: e.target.value })} list="post-advance-tokens" autoComplete="off" spellCheck={false} className="font-mono text-ui" />
                <datalist id="post-advance-tokens">
                  {rewardTokenList().map(([address, t]) => (
                    <option key={address} value={address}>
                      {t.symbol}
                    </option>
                  ))}
                </datalist>
              </FieldRow>
              <LineRow label="Cap" htmlFor="post-budget-cap">
                <Input id="post-budget-cap" value={f.budgetCap} onChange={(e) => set({ budgetCap: e.target.value })} inputMode="decimal" className="tabular w-20 text-right" />
                <span className="w-16 shrink-0 truncate text-label-2">{tokenInfo(f.budgetToken).symbol}</span>
              </LineRow>
            </>
          )}
          <div className={cn(rowClass(), 'text-ui leading-snug text-label-2')}>
            Nothing is locked for it: once the agent has started, you grant it on the job page as an on-chain permission from your wallet, and can revoke it any time.
          </div>
        </>
      )}
    </>
  )
}

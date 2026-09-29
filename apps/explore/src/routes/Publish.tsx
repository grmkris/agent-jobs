import { useQuery } from '@tanstack/react-query'
import { useLocation } from '@tanstack/react-router'
import { Lock } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { type BoardInfo, DELIVERABLE_KINDS, type DeliverableKind, currentBoardId, data, tool } from '../api.ts'
import { BoardLink, boardRoutes, useBoardNavigate } from '../components/BoardLink.tsx'
import { Preflight } from '../components/post/Preflight.tsx'
import { ResumeOffer } from '../components/post/Resume.tsx'
import { ScreeningCard } from '../components/post/Screening.tsx'
import { SignInToPublish } from '../components/post/SignInToPublish.tsx'
import {
  type Created,
  type Draft,
  type Mode,
  type PostForm,
  type StackName,
  type Step,
  clearDraft,
  createTaskArgs,
  criteriaList,
  draftKey,
  fingerprint,
  hoursText,
  initialForm,
  loadDraft,
  prefillKey,
  prefillToken,
  requestQuotesArgs,
  rewardText,
  saveDraft,
  stepProblem,
  toBase,
} from '../components/post/form.ts'
import { Chip, Choices, Disclosure, FieldRow, KV, LineRow, Mark, Progress, StepNav, Switch } from '../components/post/parts.tsx'
import { Sheet, useToast } from '../components/Sheet.tsx'
import { When, useNow } from '../components/Time.tsx'
import { TxSteps } from '../components/TxSteps.tsx'
import { Button, CopyButton, ErrorText, Group, Input, ListRow, PageTitle, Section, Segmented, Select, TextArea, cn, rowClass } from '../components/ui.tsx'
import type { useSignedIn } from '../components/Wallet.tsx'
import { rewardTokenList, tokenInfo } from '../format.ts'
import { deployment, isMainnet } from '../wallet.ts'

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
    title: 'Hire one agent',
    body: 'Agents apply and you pick one. The reward is locked in escrow when you publish; the agent starts once it posts its bond, and is paid when you accept the work.',
  },
  {
    value: 'quotes',
    title: 'Get quotes first',
    body: 'Agents bid a price. Nothing is locked until you pick a quote; then the job is published at that price and the reward is locked.',
  },
  {
    value: 'contest',
    title: 'Run a contest',
    body: 'Agents hand in finished work. You pay the entry you like best, in one transaction; the others get nothing. The prize is locked when you publish.',
  },
]
const MODE_TITLE: Record<Mode, string> = { hire: 'Hire one agent', quotes: 'Get quotes first', contest: 'Run a contest' }

const STACK_LABEL: Record<StackName, string> = { main: 'Standard', demo: 'Demo · minutes', fast: 'Fast' }
const STACK_NOTE: Record<StackName, string> = {
  main: 'Three days to review the work and to dispute a rejection.',
  demo: 'Review and dispute windows of minutes, for trying things out.',
  fast: 'Two hours to review the work and to dispute a rejection.',
}

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
 * screening and a live wallet check before anything is signed. A hire or contest is frozen by the board
 * (`create_task`) on the way to the review and published from a sheet of wallet steps; the reward is escrowed only
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
  return <PostFlow auth={auth} prefill={prefill} onPublished={onPublished} />
}

function PostFlow({ auth, prefill, onPublished }: { auth: Auth; prefill: Record<string, string>; onPublished?: ((p: Published) => void) | undefined }) {
  const navigate = useBoardNavigate()
  const toast = useToast()
  const now = useNow()
  const boardId = currentBoardId()

  // A tenant board allows only its own tokens and stacks (the board refuses others); the public board takes every
  // known reward token and every deployed stack, as before.
  const boards = useQuery({ queryKey: ['data-boards'], queryFn: () => data<{ boards: BoardInfo[] }>('boards'), staleTime: 300_000 })
  const board = boardId === 'public' ? undefined : boards.data?.boards.find((b) => b.id === boardId)
  const known = rewardTokenList()
  const restricted = board === undefined ? known : known.filter(([a]) => board.rewardTokens.some((t) => t.toLowerCase() === a))
  const tokens = restricted.length > 0 ? restricted : known
  const deployed = Object.keys(deployment.stacks) as StackName[]
  const stacks = board === undefined ? deployed : deployed.filter((s) => board.stacks.includes(s))

  const pk = prefillKey(prefill)
  const key = draftKey(boardId, auth.address)
  const defaults = () => initialForm(prefill, rewardTokenList(), isMainnet)
  const restore = (k: string): Draft | null => {
    const d = loadDraft(k, defaults())
    return d !== null && d.prefill === pk ? d : null
  }
  const [draft, setDraft] = useState<Draft>(() => restore(key) ?? { v: 1, step: 1, form: defaults(), prefill: pk, frozen: null })
  const [saved, setSaved] = useState(false)
  const dirty = useRef(false)
  const finished = useRef(false)
  const loadedKey = useRef(key)
  const lastPrefill = useRef(pk)
  const tokenTouched = useRef(false)

  const f = draft.form
  const step = draft.step
  /** A field the person changed. */
  const set = (patch: Partial<PostForm>) => {
    dirty.current = true
    setDraft((d) => ({ ...d, form: { ...d.form, ...patch } }))
  }
  /** A correction the page makes itself (a token or stack the board does not offer): not a reason to save. */
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
    loadedKey.current = key
    if (dirty.current) {
      clearDraft(before)
      return
    }
    const d = restore(key)
    if (d !== null) setDraft(d)
  }, [key])

  useEffect(() => {
    if (!dirty.current || finished.current) return
    setSaved(saveDraft(key, draft))
  }, [draft, key])

  // The embed's host may send a prefill after the widget loaded (postMessage): it sets the fields it names.
  useEffect(() => {
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
    if (tokenTouched.current) return
    const t = prefillToken(prefill, rewardTokenList())
    if (t !== undefined && t !== f.token) fix({ token: t })
  }, [known.length])

  const tokenIds = tokens.map(([a]) => a).join()
  useEffect(() => {
    const ids = tokens.map(([a]) => a)
    const first = ids[0]
    if (first === undefined) return
    const patch: Partial<PostForm> = {}
    if (!ids.includes(f.token)) patch.token = first
    if (board !== undefined && f.quoteTokens.some((a) => !ids.includes(a))) {
      const kept = f.quoteTokens.filter((a) => ids.includes(a))
      patch.quoteTokens = kept.length > 0 ? kept : ids
    }
    if (Object.keys(patch).length > 0) fix(patch)
  }, [tokenIds, f.token, board !== undefined])
  useEffect(() => {
    if (stacks.length > 0 && !stacks.includes(f.stack)) fix({ stack: board !== undefined && stacks.includes(board.defaultStack as StackName) ? (board.defaultStack as StackName) : (stacks[0] as StackName) })
  }, [stacks.join(), f.stack])

  // The frozen offer, while the form still describes it; an edit afterwards means freezing again.
  const fp = fingerprint(f)
  const matching = draft.frozen !== null && draft.frozen.fp === fp && f.mode !== 'quotes' ? draft.frozen : null
  // A kept draft whose offer reached the chain after all (the page closed mid-publish) must not be published twice:
  // the board is asked once whether it became a job.
  const frozenTask = draft.frozen?.created.taskId
  const onChain = useQuery({
    queryKey: ['post-frozen', boardId, frozenTask],
    queryFn: () => tool<{ jobId: string | null }>('get_task', { taskId: frozenTask }),
    enabled: frozenTask !== undefined,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })
  const publishedAs = onChain.data?.jobId ?? null
  // Deadlines count from the moment the offer was frozen: one prepared too long ago is prepared again.
  const expired = matching !== null && (matching.deliveryDeadline <= now + 60 || (matching.selectionDeadline !== null && matching.selectionDeadline <= now + 60))
  const frozen = matching !== null && !expired && publishedAs === null ? matching : null
  const [freezing, setFreezing] = useState(false)
  const [freezeError, setFreezeError] = useState<string | null>(null)
  const freeze = async () => {
    const form = draft.form
    const at = Math.floor(Date.now() / 1000)
    const args = createTaskArgs(form, at)
    setFreezing(true)
    setFreezeError(null)
    try {
      const created = await tool<Created>('create_task', args)
      dirty.current = true
      const selection = (args as { selectionDeadline?: number }).selectionDeadline ?? null
      setDraft((d) => ({ ...d, frozen: { fp: fingerprint(form), at, deliveryDeadline: args.deliveryDeadline, selectionDeadline: selection, created } }))
    } catch (e) {
      setFreezeError((e as Error).message)
    } finally {
      setFreezing(false)
    }
  }

  const [asking, setAsking] = useState(false)
  const [askError, setAskError] = useState<string | null>(null)
  const [sheet, setSheet] = useState(false)
  const finish = () => {
    finished.current = true
    clearDraft(key)
  }
  const startOver = () => {
    clearDraft(key)
    dirty.current = false
    setSaved(false)
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
    setSheet(false)
    toast(`Published · ${reward} locked in escrow`)
    if (onPublished !== undefined) onPublished({ taskId: created.taskId, jobId, txHash: hashes.at(-1) ?? null })
    else await navigate(jobId !== null ? boardRoutes().job(jobId) : boardRoutes().jobs())
  }

  const problem = stepProblem(f, step)
  const status = saved && dirty.current ? 'Draft saved' : ''
  const contest = f.mode === 'contest'
  const quotes = f.mode === 'quotes'
  const hours = (h: string) => now + Math.round(Number(h) * 3600)
  const deliverBy = frozen?.deliveryDeadline ?? hours(f.deliveryHours)
  const awardBy = frozen?.selectionDeadline ?? hours(f.selectionHours)
  const symbol = tokenInfo(f.token).symbol
  const criteria = criteriaList(f.criteria)
  const kinds = f.accepts.map((k) => KIND_LABEL[k]).join(', ')

  const next = (to: Step) => (
    <Button size="lg" type="submit" disabled={problem !== null} className="shrink-0">
      {to === 4 ? 'Review' : 'Continue'}
    </Button>
  )

  return (
    <>
      <PageTitle>Post a job</PageTitle>
      {publishedAs !== null && (
        <div role="status" className="grid gap-2 rounded-xl bg-ok-bg px-4 py-3 text-[0.92rem] text-ok">
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
        <div className="grid gap-2">
          <Progress step={step} of={4} />
          <p className="px-1 text-[0.8rem] text-label-2">
            Step {step} of 4 · {step === 3 && quotes ? 'Quotes and deadline' : step === 3 && contest ? 'Prize and deadlines' : STEP_TITLE[step]}
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
            <Section title="How agents compete">
              <Choices label="How agents compete" value={f.mode} onChange={(mode) => set({ mode })} options={MODES} />
            </Section>
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
                <Section
                  title={contest ? 'Prize and deadlines' : 'Reward and deadline'}
                  note={contest ? 'The prize is locked in escrow when you publish and paid to the entry you award.' : 'The reward is locked in escrow when you publish and paid only when the work is accepted.'}
                >
                  <Group>
                    <LineRow label="Token" stack={tokens.length > 2}>
                      {tokens.length <= 4 ? (
                        <Segmented
                          label="Reward token"
                          value={f.token}
                          options={tokens.map(([a, t]) => [a, t.symbol] as const)}
                          onChange={(token) => {
                            tokenTouched.current = true
                            set({ token })
                          }}
                          className="sm:min-w-[14rem]"
                        />
                      ) : (
                        <Select
                          aria-label="Reward token"
                          value={f.token}
                          onChange={(e) => {
                            tokenTouched.current = true
                            set({ token: e.target.value })
                          }}
                          className="w-auto"
                        >
                          {tokens.map(([a, t]) => (
                            <option key={a} value={a}>
                              {t.symbol}
                            </option>
                          ))}
                        </Select>
                      )}
                    </LineRow>
                    <LineRow label={contest ? 'Prize' : 'Amount'} htmlFor="post-reward">
                      <Input id="post-reward" value={f.reward} onChange={(e) => set({ reward: e.target.value })} inputMode="decimal" autoComplete="off" className="tabular w-28 text-right" />
                      <span className="w-12 shrink-0 text-label-2">{symbol}</span>
                    </LineRow>
                    <LineRow label="Deliver within" note={<>Due <When at={hours(f.deliveryHours)} show="time" /></>} stack>
                      <HoursPicker id="post-delivery-hours" value={f.deliveryHours} presets={DELIVERY} onChange={(deliveryHours) => set({ deliveryHours })} />
                    </LineRow>
                    {contest && (
                      <LineRow
                        label="Award within"
                        htmlFor="post-selection-hours"
                        note={<>You pick the winning entry by <When at={hours(f.selectionHours)} show="time" />, before the delivery deadline. If you award none, the prize and your bond come back.</>}
                      >
                        <Input id="post-selection-hours" value={f.selectionHours} onChange={(e) => set({ selectionHours: e.target.value })} inputMode="decimal" className="tabular w-20 text-right" />
                        <span className="w-12 shrink-0 text-label-2">hours</span>
                      </LineRow>
                    )}
                  </Group>
                </Section>
              )}
              <Advanced f={f} set={set} stacks={stacks} />
            </>
          )}

          {step === 4 && (
            <>
              <Section title="What agents will see">
                <Group>
                  <ListRow>
                    <span className="grid min-w-0 gap-1 py-1">
                      <span className="font-semibold [overflow-wrap:anywhere]">{f.title}</span>
                      <span className="text-[0.92rem] leading-relaxed whitespace-pre-wrap text-label-2 [overflow-wrap:anywhere]">{f.brief}</span>
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
                  <KV label="How agents compete">{MODE_TITLE[f.mode]}</KV>
                  {quotes ? (
                    <>
                      <KV label="Accepted tokens">{f.quoteTokens.map((a) => tokenInfo(a).symbol).join(', ')}</KV>
                      <KV label="Quotes close">
                        <When at={hours(f.quoteHours)} />
                      </KV>
                    </>
                  ) : (
                    <KV label={contest ? 'Prize' : 'Reward'}>
                      <span className="tabular font-semibold text-label">{reward}</span>
                    </KV>
                  )}
                  <KV label="Deliver by">
                    <When at={deliverBy} />
                  </KV>
                  {contest && (
                    <KV label="Award by">
                      <When at={awardBy} />
                    </KV>
                  )}
                  <KV label="Deliver as">{kinds}</KV>
                  {f.accepts.includes('git') && f.check.trim() !== '' && (
                    <KV label="Required GitHub check">
                      <code className="font-mono text-[0.85rem]">{f.check.trim()}</code>
                    </KV>
                  )}
                  <KV label="Bonds">{contest ? `${f.creatorBond} FACTORY from you` : `${f.creatorBond} FACTORY from you · ${f.workerBond} from the agent`}</KV>
                  {f.mode === 'hire' && f.budgetOn && (
                    <KV label="Running-cost budget">{f.budgetKind === 'call' ? `Up to ${f.callCap} MON for one contract call` : `Up to ${f.budgetCap} ${tokenInfo(f.budgetToken).symbol}`}</KV>
                  )}
                  {f.stack !== 'main' && <KV label="Review speed">{STACK_LABEL[f.stack]}</KV>}
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
                          <span className="block text-[0.84rem] text-label-2">This can take up to a minute.</span>
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
                stack={f.stack}
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
                    <span className="tabular block font-display text-[1.6rem] leading-tight font-bold tracking-[-0.02em] [overflow-wrap:anywhere]">{reward}</span>
                    <span className="block text-[0.86rem] text-label-2">
                      Locked in escrow when you publish · due <When at={deliverBy} show="relative" />
                    </span>
                  </span>
                </div>
              )}

              {frozen !== null && (
                <Disclosure title="Details">
                  <div className={rowClass()}>
                    <span className="flex-1">Offer ID</span>
                    <span className="font-mono text-[0.82rem] text-label-2">{frozen.created.taskId}</span>
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

        {problem !== null && step !== 4 && (dirty.current || step > 1) && <p className="px-4 text-[0.86rem] text-label-2">{problem}</p>}
        <StepNav onBack={step === 1 ? undefined : () => go((step - 1) as Step)} status={status} stack={step === 4}>
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
            <Button size="lg" onClick={() => setSheet(true)} className="min-w-0">
              Publish and lock {reward}
            </Button>
          ) : (
            <Button size="lg" busy={freezing} disabled={publishedAs !== null} onClick={() => void freeze()}>
              Prepare to publish
            </Button>
          )}
        </StepNav>
      </form>

      <Sheet open={sheet} onClose={() => setSheet(false)} title={`Publish and lock ${reward}`}>
        <p className="-mt-2 leading-snug text-label-2">
          Your wallet sends these in order. The {contest ? 'prize' : 'reward'} and your bond are locked in escrow when the publish step confirms; nothing moves before that.
        </p>
        {/* Mounted for the offer the form describes, so a run in progress is never cut off by a later read. */}
        {matching !== null && <TxSteps key={matching.created.taskId} taskId={matching.created.taskId} txs={matching.created.transactions} onDone={(hashes) => void published(matching.created, hashes)} />}
      </Sheet>
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

function Advanced({ f, set, stacks }: { f: PostForm; set: (p: Partial<PostForm>) => void; stacks: StackName[] }) {
  const hire = f.mode === 'hire'
  const summary: ReactNode = `${f.stack === 'main' ? '' : `${STACK_LABEL[f.stack]} · `}Bonds, delivery${hire && f.budgetOn ? ', budget' : ''}`
  return (
    <Section note="Bonds are in FACTORY. Both are held by the contracts, never by Hireling.">
      <Disclosure title="Advanced" summary={summary}>
        {stacks.length > 1 && (
          <LineRow label="Review speed" note={STACK_NOTE[f.stack]} stack>
            <Segmented label="Review speed" value={f.stack} options={stacks.map((s) => [s, STACK_LABEL[s]] as const)} onChange={(stack) => set({ stack })} className="sm:min-w-[19rem]" />
          </LineRow>
        )}
        <LineRow label="Your bond" note="Returned unless a ruling finds you acted in bad faith." htmlFor="post-creator-bond">
          <Input id="post-creator-bond" value={f.creatorBond} onChange={(e) => set({ creatorBond: e.target.value })} inputMode="decimal" className="tabular w-20 text-right" />
          <span className="w-16 shrink-0 text-label-2">FACTORY</span>
        </LineRow>
        {f.mode === 'contest' ? (
          <KV label="Agent's bond" note="Contest entrants post no bond: they risk only their work.">
            None
          </KV>
        ) : (
          <LineRow label="Agent's bond" note="Burned if the agent misses the deadline or cheats; returned otherwise." htmlFor="post-worker-bond">
            <Input id="post-worker-bond" value={f.workerBond} onChange={(e) => set({ workerBond: e.target.value })} inputMode="decimal" className="tabular w-20 text-right" />
            <span className="w-16 shrink-0 text-label-2">FACTORY</span>
          </LineRow>
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
            <Input id="post-check" value={f.check} onChange={(e) => set({ check: e.target.value })} autoComplete="off" className="w-32 font-mono text-[0.88rem]" />
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
                <Input id="post-call-target" value={f.callTarget} onChange={(e) => set({ callTarget: e.target.value })} autoComplete="off" spellCheck={false} className="font-mono text-[0.85rem]" />
              </FieldRow>
              <FieldRow label="Allowed function" htmlFor="post-call-function" hint="Exactly one function, in human-readable ABI form.">
                <Input id="post-call-function" value={f.callFunction} onChange={(e) => set({ callFunction: e.target.value })} autoComplete="off" spellCheck={false} className="font-mono text-[0.78rem]" />
              </FieldRow>
              <LineRow label="Cap" note={isMainnet ? 'The total MON the call may send.' : 'nad.fun charges a 10 MON deploy fee on testnet.'} htmlFor="post-call-cap">
                <Input id="post-call-cap" value={f.callCap} onChange={(e) => set({ callCap: e.target.value })} inputMode="decimal" className="tabular w-20 text-right" />
                <span className="w-16 shrink-0 text-label-2">MON</span>
              </LineRow>
            </>
          ) : (
            <>
              <FieldRow label="Token" htmlFor="post-budget-token" hint="Any ERC-20 you hold; the reward tokens are suggested.">
                <Input id="post-budget-token" value={f.budgetToken} onChange={(e) => set({ budgetToken: e.target.value })} list="post-advance-tokens" autoComplete="off" spellCheck={false} className="font-mono text-[0.85rem]" />
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
          <div className={cn(rowClass(), 'text-[0.84rem] leading-snug text-label-2')}>
            Nothing is locked for it: once the agent has started, you grant it on the job page as an on-chain permission from your wallet, and can revoke it any time.
          </div>
        </>
      )}
    </>
  )
}

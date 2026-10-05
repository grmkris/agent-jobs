import { OAuthConsent } from '../components/OAuthConsent.tsx'
import { ConnectionCard } from '../components/ConnectionCard.tsx'
import { AgentStartLink } from '../components/AgentStartLink.tsx'
import * as sdk from '@agent-jobs/sdk'
import { useQuery } from '@tanstack/react-query'
import { Link, useSearch } from '@tanstack/react-router'
import { Check, ChevronRight, Loader2, Minus, TriangleAlert } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { isAddress } from 'viem'
import { useBalance, useReadContract, useReadContracts } from 'wagmi'
import { type BoardInfo, type ChainJob, boardApi, data } from '../api.ts'
import { Address, CopyButton, Field, Group, Input, ListRow, PageTitle, Section, Segmented, Select, cn, rowClass, shortAddress } from '../components/ui.tsx'
import { useAuth } from '../components/Wallet.tsx'
import { formatNumber } from '../format.ts'
import { chain, deployment, isMainnet } from '../wallet.ts'
import { agentNumber, useAgentIdentity, useAgentRecord } from './Agent.tsx'

type Harness = 'claude' | 'codex' | 'grok' | 'other'
const HARNESSES = [
  [
    'claude',
    <>
      Claude<span className="max-sm:hidden"> Code</span>
    </>,
  ],
  ['codex', 'Codex'],
  ['grok', 'Grok'],
  ['other', 'Other'],
] as const

/** How each harness adds Hireling's MCP server and the worker skill (packages/sdk/scripts/harness/run-agent.sh). */
function harnessSetup(harness: Harness, mcp: string, skill: string): string {
  switch (harness) {
    case 'claude':
      return [
        `claude mcp add --transport http hireling ${mcp}`,
        'mkdir -p ~/.claude/skills/hireling-worker',
        `curl -fsSL ${skill} \\`,
        '  -o ~/.claude/skills/hireling-worker/SKILL.md',
      ].join('\n')
    case 'codex':
      return [
        '# ~/.codex/config.toml',
        '[mcp_servers.hireling]',
        `url = "${mcp}"`,
        '',
        '# the worker skill, for Codex to read',
        `curl -fsSL ${skill} -o AGENTS.hireling.md`,
      ].join('\n')
    case 'grok':
      return [`grok mcp add -s project -t http hireling ${mcp}`, `curl -fsSL ${skill} -o HIRELING.md`].join('\n')
    case 'other':
      return [
        `MCP endpoint (streamable HTTP): ${mcp}`,
        `Worker skill: ${skill}`,
        'Authenticate through the MCP client’s OAuth browser flow. Select the agents and scopes to connect.',
      ].join('\n')
  }
}

/** A shell argument in single quotes (a `'` inside becomes `'\''`). */
const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`

/**
 * The `register(string)` call with a `data:application/json` profile Hireling (and any ERC-8004 reader) can show.
 * The JSON stays readable; only `%` and `#` are escaped, so a URL decoder gives back exactly this JSON.
 */
export function registerCommand(name: string, description: string, rpc: string): string {
  const profile: Record<string, string> = { name: name.trim() || 'My agent' }
  if (description.trim() !== '') profile.description = description.trim()
  const uri = `data:application/json,${JSON.stringify(profile).replaceAll('%', '%25').replaceAll('#', '%23')}`
  return [
    `cast send ${deployment.identity} "register(string)" \\`,
    `  ${shellQuote(uri)} \\`,
    `  --private-key $WORKER_PRIVATE_KEY --rpc-url ${rpc} --json \\`,
    // The registry mints the agent as an ERC-721: the Transfer event's third topic is its number.
    `  | jq -r --arg t $(cast keccak 'Transfer(address,address,uint256)') \\`,
    `      '.logs[] | select(.topics[0] == $t) | .topics[3]' | cast to-dec`,
  ].join('\n')
}

/** A copyable block of commands. */
function Code({ text, label = 'Copy' }: { text: string; label?: string }) {
  return (
    <div className="relative min-w-0">
      <pre className="rounded-xl bg-code py-3 pr-12 pl-3.5 font-mono text-[0.8rem] leading-[1.55] whitespace-pre-wrap text-label [overflow-wrap:anywhere]">
        {text}
      </pre>
      <CopyButton value={text} label={label} className="absolute top-2 right-2 bg-surface" />
    </div>
  )
}

// Agents this browser checked before, most recent first, so the checklist opens on the one you run.
const WATCHED = 'hireling.watched-agents'
type Watched = { agent: string; wallet: string }
function readWatched(): Watched[] {
  try {
    const v = JSON.parse(localStorage.getItem(WATCHED) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((w): w is Watched => typeof w?.agent === 'string' && typeof w?.wallet === 'string').slice(0, 6) : []
  } catch {
    return []
  }
}
function writeWatched(list: Watched[]) {
  try {
    localStorage.setItem(WATCHED, JSON.stringify(list.slice(0, 6)))
  } catch {
    // storage blocked: remembered for this page view only
  }
}

type State = 'ok' | 'warn' | 'bad' | 'none' | 'loading'
interface CheckRow {
  key: string
  state: State
  title: ReactNode
  detail: ReactNode
}

function StateIcon({ state }: { state: State }) {
  if (state === 'loading') return <Loader2 aria-label="Checking" className="size-6 shrink-0 animate-spin p-0.5 text-label-3" />
  return (
    <span
      aria-label={state === 'ok' ? 'Done' : state === 'none' ? 'Not yet' : 'Needs a fix'}
      className={cn(
        'grid size-6 shrink-0 place-items-center rounded-full',
        state === 'ok' && 'bg-ok text-background',
        state === 'warn' && 'bg-warn text-background',
        state === 'bad' && 'bg-bad text-background',
        state === 'none' && 'bg-fill-strong text-label-2',
      )}
    >
      {state === 'ok' ? (
        <Check className="size-3.5" strokeWidth={3} />
      ) : state === 'none' ? (
        <Minus className="size-3.5" strokeWidth={3} />
      ) : (
        <TriangleAlert className="size-3.5" strokeWidth={2.6} />
      )}
    </span>
  )
}

const MIN_GAS = 500_000_000_000_000_000n // 0.5 MON
const fac = (x: bigint) => `${formatNumber(x, 18)} FACTORY`
const faucetLink = (
  <a className="text-tint" href="https://faucet.monad.xyz" target="_blank" rel="noreferrer">
    faucet.monad.xyz
  </a>
)

/** The primary connector path is one shared skill and standards-based hosted MCP OAuth. */
export function ConnectPage() {
  const request = new URLSearchParams(window.location.search).get('oauth_request')
  return <>
    <PageTitle>Connect your coding agent</PageTitle>
    {request === null ? <><AgentStartLink /><ConnectionCard /><Link to="/agents/new" className="action-link">Create an agent</Link><Link to="/agents" className="min-h-11 content-center text-tint">Open your agents</Link></> : <OAuthConsent requestId={request} />}
  </>
}

/** "Run your agent": connect a harness to the board's MCP server, check the agent can work, register one. */
export function ProtocolConnectPage() {
  const search = useSearch({ strict: false }) as {
    agent?: unknown
    wallet?: unknown
    board?: unknown
  }
  const { address } = useAuth()
  const [harness, setHarness] = useState<Harness>('claude')
  const [watched, setWatched] = useState(readWatched)
  const [agentInput, setAgentInput] = useState(() => agentNumber(search.agent) ?? watched[0]?.agent ?? '')
  const [walletInput, setWalletInput] = useState(() =>
    typeof search.wallet === 'string' ? search.wallet : agentNumber(search.agent) === null ? (watched[0]?.wallet ?? '') : '',
  )
  const [board, setBoard] = useState(typeof search.board === 'string' && /^[a-z0-9-]{3,32}$/.test(search.board) ? search.board : 'public')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  // The signed-in wallet's own agent, when it has worked here: a starting point when nothing else is given.
  const mine = useQuery({
    queryKey: ['data-agents-wallet', address],
    queryFn: () => data<{ agents: string[] }>(`agents?wallet=${address}`),
    enabled: address !== undefined,
    staleTime: 60_000,
  })
  useEffect(() => {
    const first = mine.data?.agents[0]
    if (first !== undefined && agentInput === '') {
      setAgentInput(first)
      if (walletInput === '' && address !== undefined) setWalletInput(address)
    }
  }, [mine.data])

  const boards = useQuery({
    queryKey: ['data-boards'],
    queryFn: () => data<{ boards: BoardInfo[] }>('boards'),
    staleTime: 300_000,
  })
  const tenants = (boards.data?.boards ?? []).filter((b) => !b.public)
  const origin = window.location.origin
  const mcp = board === 'public' ? `${origin}/mcp` : `${origin}/b/${board}/mcp`
  const skill = `${origin}/skills/worker/SKILL.md`
  const rpc = chain.rpcUrls.default.http[0] ?? ''

  const id = agentNumber(agentInput)
  const wallet = walletInput.trim()

  return (
    <>
      <PageTitle>Direct protocol access</PageTitle>
      <p className="-mt-2 leading-relaxed text-label-2">
        Independent agents can use the open contracts and discovery board with their existing wallets. These advanced instructions are for agents whose
        operators already manage their own signing keys.
      </p>

      <Section
        title="1 · Connect your harness"
        note={
          <>
            Hosted MCP authenticates through your client’s OAuth browser flow. Import the existing agent in your workspace, then grant it access. Independent
            REST clients can use auth_challenge and auth_login with their wallet; direct contract clients do not need board sign-in.
          </>
        }
      >
        <div className="grid gap-2.5">
          <Segmented label="Harness" value={harness} options={HARNESSES} onChange={setHarness} />
          {tenants.length > 0 && (
            <Group className="px-4 py-2">
              <label className="flex items-center justify-between gap-3">
                <span className="text-[0.95rem]">Board</span>
                <Select value={board} onChange={(e) => setBoard(e.target.value)} className="w-auto max-w-[60%]">
                  <option value="public">Public board</option>
                  {tenants.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              </label>
            </Group>
          )}
          <Group className="grid gap-2.5 p-2.5">
            <Code text={harnessSetup(harness, mcp, skill)} label="Copy the setup commands" />
            <Code text={`export WORKER_PRIVATE_KEY=…   # the agent wallet's key: only in your shell\nexport RPC=${rpc}`} label="Copy the environment lines" />
          </Group>
        </div>
      </Section>

      <Section
        title={id === null ? '2 · Check it can work' : `2 · Check it can work · Agent #${id}`}
        note="Read from Monad every 10 seconds, so you can watch a top-up land."
      >
        <div className="grid gap-2.5">
          <Group>
            <label className={rowClass()}>
              <span className="flex-1">Agent number</span>
              <Input
                value={agentInput}
                onChange={(e) => setAgentInput(e.target.value.trim())}
                inputMode="numeric"
                placeholder="1942"
                aria-invalid={agentInput !== '' && id === null}
                className="w-32 text-right tabular"
              />
            </label>
            <label className={rowClass()}>
              <span className="min-w-0 flex-1">
                Wallet
                <span className="block text-[0.78rem] text-label-3">Optional: the one your harness signs with</span>
              </span>
              <Input
                value={walletInput}
                onChange={(e) => setWalletInput(e.target.value.trim())}
                placeholder="0x…"
                spellCheck={false}
                autoComplete="off"
                aria-invalid={wallet !== '' && !isAddress(wallet)}
                className="w-40 font-mono text-[0.82rem] sm:w-80"
              />
            </label>
          </Group>
          {watched.length > 1 && (
            <div className="flex flex-wrap items-center gap-2 px-4 text-[0.82rem]">
              <span className="text-label-2">Checked before:</span>
              {watched.map((w) => (
                <button
                  key={w.agent}
                  type="button"
                  onClick={() => {
                    setAgentInput(w.agent)
                    setWalletInput(w.wallet)
                  }}
                  className={cn('press rounded-full px-2.5 py-1 font-medium', w.agent === id ? 'bg-tint/14 text-tint' : 'bg-fill text-label')}
                >
                  #{w.agent}
                </button>
              ))}
            </div>
          )}
          {agentInput !== '' && id === null ? (
            <p className="px-4 text-[0.88rem] text-bad">Agent numbers are whole numbers, like 1942.</p>
          ) : id === null ? (
            <p className="px-4 text-[0.88rem] text-label-2">Enter your agent&apos;s number to check it.</p>
          ) : (
            <Checklist
              key={id}
              id={id}
              wallet={wallet}
              onChecked={() => {
                const next = [{ agent: id, wallet: isAddress(wallet) ? wallet : '' }, ...watched.filter((w) => w.agent !== id)]
                if (watched[0]?.agent === id && watched[0]?.wallet === next[0]?.wallet) return
                writeWatched(next)
                setWatched(next.slice(0, 6))
              }}
            />
          )}
        </div>
      </Section>

      <Section
        title="3 · Not registered yet?"
        note={
          <>
            register() mints the agent to the wallet that sends it, which becomes its agent wallet; the command prints the new agent&apos;s number. A JSON
            profile gives it a name and description here (a web link gives none).
          </>
        }
      >
        <Group className="grid gap-3 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My agent" maxLength={80} />
            </Field>
            <Field label="What it does">
              <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Builds and ships small web apps" maxLength={600} />
            </Field>
          </div>
          <Code text={registerCommand(name, description, rpc)} label="Copy the register command" />
          {!isMainnet && (
            <>
              <p className="text-[0.88rem] leading-snug text-label-2">
                On testnet, get MON for gas from {faucetLink}. FACTORY v2 has no faucet: the ecosystem/coordinator transfers it to the agent wallet. mUSD and
                mEUR are mock payment tokens with their own on-chain <code>faucet()</code> method. Never paste a private key into Hireling.
              </p>
            </>
          )}
        </Group>
      </Section>
    </>
  )
}

/** The live checks for one agent: identity, wallet, gas, the FACTORY hires need, and its record. */
function Checklist({ id, wallet, onChecked }: { id: string; wallet: string; onChecked: () => void }) {
  const identity = useAgentIdentity(id, true)
  const record = useAgentRecord(id, 30_000)
  const agentWallet = identity.wallet
  const enabled = agentWallet !== undefined
  const mon = useBalance({
    address: agentWallet,
    chainId: chain.id,
    query: { enabled, refetchInterval: 10_000 },
  })
  const factory = useReadContract({
    address: deployment.factory,
    abi: sdk.factoryTokenAbi,
    functionName: 'balanceOf',
    args: [agentWallet ?? '0x0000000000000000000000000000000000000000'],
    chainId: chain.id,
    query: { enabled, refetchInterval: 10_000 },
  })
  // What activating a hire needs held: every stack's minHoldToClaim (checked before the bond is pulled, even at 0).
  const holdings = Object.values(deployment.stacks).map((s) => s.holding)
  const holds = useReadContracts({
    contracts: holdings.map(
      (h) =>
        ({
          address: h,
          abi: sdk.jobHoldingAbi,
          functionName: 'minHoldToClaim',
          chainId: chain.id,
        }) as const,
    ),
    query: { staleTime: 600_000 },
  })
  const minHold =
    holds.data?.every((r) => r.status === 'success') === true
      ? holds.data.reduce((m, r) => ((r.result as bigint) > m ? (r.result as bigint) : m), 0n)
      : undefined
  // …and the job's bond: the largest one any open hire asks for.
  const jobs = useQuery({
    queryKey: ['chain-jobs', 'public'],
    queryFn: () => boardApi('public').jobs<{ jobs: ChainJob[] }>(),
    refetchInterval: 60_000,
  })
  const largestBond = useMemo(
    () =>
      (jobs.data?.jobs ?? [])
        .filter((j) => j.status === 'open' && j.mode !== 'contest')
        .reduce((m, j) => (BigInt(j.worker_bond ?? '0') > m ? BigInt(j.worker_bond ?? '0') : m), 0n),
    [jobs.data],
  )

  useEffect(() => {
    // Remembered once it is known to exist, with the wallet entered for it.
    if (identity.exists === true) onChecked()
  }, [identity.exists, wallet])

  const rows: CheckRow[] = []
  if (identity.loading)
    rows.push({
      key: 'exists',
      state: 'loading',
      title: `Looking up agent #${id}`,
      detail: 'On the ERC-8004 identity registry',
    })
  else if (identity.exists === null)
    rows.push({
      key: 'exists',
      state: 'warn',
      title: "Couldn't read the identity registry",
      detail: 'Monad did not answer; this retries every 10 seconds.',
    })
  else if (identity.exists === false)
    rows.push({
      key: 'exists',
      state: 'bad',
      title: `No agent #${id} yet`,
      detail: 'Nothing is registered under this number. Register an agent below, then check its number here.',
    })
  else {
    rows.push({
      key: 'exists',
      state: 'ok',
      title: `Agent #${id} exists`,
      detail: (
        <>
          On the ERC-8004 identity registry, owned by <Address value={identity.owner} />
        </>
      ),
    })

    // The wallet its harness must sign with.
    const entered = isAddress(wallet) ? wallet : null
    if (agentWallet === undefined)
      rows.push({
        key: 'wallet',
        state: 'bad',
        title: 'No agent wallet',
        detail: 'The registry names no agent wallet for this agent, so no job can admit it.',
      })
    else if (entered !== null && entered.toLowerCase() !== agentWallet.toLowerCase())
      rows.push({
        key: 'wallet',
        state: 'warn',
        title: `Agent wallet is ${shortAddress(agentWallet)}, not ${shortAddress(entered)}`,
        detail: 'Jobs admit only the agent wallet: give your harness that wallet’s key, or change the agent wallet on the registry.',
      })
    else
      rows.push({
        key: 'wallet',
        state: 'ok',
        title: (
          <>
            Agent wallet <Address value={agentWallet} />
          </>
        ),
        detail:
          entered !== null
            ? 'Matches the wallet you entered. Your harness signs with it.'
            : 'Your harness must sign in and send transactions with this wallet.',
      })

    // Gas.
    if (agentWallet !== undefined) {
      if (mon.data === undefined)
        rows.push({
          key: 'gas',
          state: mon.isError ? 'warn' : 'loading',
          title: mon.isError ? "Couldn't read its MON balance" : 'Reading its MON balance',
          detail: 'Gas for applying, activating and delivering',
        })
      else {
        const v = mon.data.value
        rows.push({
          key: 'gas',
          state: v >= MIN_GAS ? 'ok' : v === 0n ? 'bad' : 'warn',
          title: `Gas: ${formatNumber(v, 18)} MON`,
          detail:
            v >= MIN_GAS ? (
              'Enough for a few hires; one hire can use 0.1–0.2 MON of gas.'
            ) : isMainnet ? (
              'Low: one hire can use 0.1–0.2 MON of gas. Send MON to the agent wallet.'
            ) : (
              <>Low: one hire can use 0.1–0.2 MON of gas. Top up from {faucetLink}.</>
            ),
        })
      }

      // FACTORY for hires.
      const held = factory.data
      if (held === undefined || minHold === undefined) {
        const failed = factory.isError || holds.isError
        rows.push({
          key: 'factory',
          state: failed ? 'warn' : 'loading',
          title: failed ? "Couldn't read its FACTORY" : 'Reading its FACTORY',
          detail: 'Held to take hires',
        })
      } else {
        const need = largestBond > minHold ? largestBond : minHold
        if (held >= need)
          rows.push({
            key: 'factory',
            state: 'ok',
            title: `Can take hires: ${fac(held)}`,
            detail: `Activating a hire needs ${fac(minHold)} held, even with no bond, and the job's bond${largestBond > 0n ? ` (largest open: ${fac(largestBond)})` : ''}.`,
          })
        else if (held >= minHold)
          rows.push({
            key: 'factory',
            state: 'warn',
            title: `Can take hires with a bond up to ${fac(held)}`,
            detail: `The largest open bond is ${fac(largestBond)}; activating pulls the bond from the agent wallet.`,
          })
        else
          rows.push({
            key: 'factory',
            state: 'bad',
            title: `Can't take hires yet: ${fac(held)}`,
            detail: `Activating a hire needs ${fac(minHold)} held in the agent wallet, even with no bond${largestBond > 0n ? `, and the job's bond (largest open: ${fac(largestBond)})` : ''}. Contests and quotes don't.${isMainnet ? '' : ' FACTORY v2 is transferred by the ecosystem/coordinator (step 3).'}`,
          })
      }
    }
  }

  // Its record, whether or not the identity read worked.
  if (identity.exists !== false) {
    if (record.isLoading)
      rows.push({
        key: 'record',
        state: 'loading',
        title: 'Reading its track record',
        detail: 'From chain records',
      })
    else if (record.error !== null)
      rows.push({
        key: 'record',
        state: 'warn',
        title: 'Track record unavailable right now',
        detail: 'The board did not answer; this retries.',
      })
    else if (record.data === null || record.data === undefined)
      rows.push({
        key: 'record',
        state: 'none',
        title: 'No jobs yet',
        detail: 'Its record starts with its first job; creators see it when it applies or quotes.',
      })
    else {
      const a = record.data.agent
      rows.push({
        key: 'record',
        state: 'ok',
        title: `Track record: ${a.completed} of ${a.jobs} jobs paid`,
        detail: 'Creators see it when it applies or quotes.',
      })
    }
  }

  return (
    <Group>
      {rows.map((r) => (
        <ListRow key={r.key} inset className="items-start py-3">
          <StateIcon state={r.state} />
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="font-medium [overflow-wrap:anywhere]">{r.title}</span>
            <span className="text-[0.86rem] leading-snug text-label-2">{r.detail}</span>
          </span>
        </ListRow>
      ))}
      {record.data !== null && record.data !== undefined && (
        <Link to="/agent/$agentId" params={{ agentId: id }} className={rowClass({ inset: true, interactive: true })}>
          <span className="w-6 shrink-0" />
          <span className="flex-1 text-tint">Open its profile</span>
          <ChevronRight aria-hidden className="size-4 text-label-3" />
        </Link>
      )}
    </Group>
  )
}

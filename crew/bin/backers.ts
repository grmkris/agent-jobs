#!/usr/bin/env bun
/**
 * Overnight activity, the backer side: wallets that claim the testnet faucet, buy a little SIDE in the pool, and
 * stake behind the crew's agents, favouring the ones with a recent record; about one in four later asks to unstake
 * part of a position, and some change their mind and cancel it. Only crew agents (crew/crew.json, by name in the
 * directory) are ever backed. Every send is journaled (FlowJournal), so a restart resumes exactly.
 *
 *   bun crew/bin/backers.ts run      the loop (container sq-backers)
 *   bun crew/bin/backers.ts status   each backer's MON and cycles
 *
 * Env: BACKER_<n>_PRIVATE_KEY, MONAD_RPC_URL, ACTIVITY_BACKERS (8), ACTIVITY_CYCLES (4 per backer), ACTIVITY_STATE.
 */
import { Option, Schema } from 'effect'
import { type Address, erc20Abi, formatEther, formatUnits, maxUint256, parseEther, parseUnits } from 'viem'
import crewJson from '../crew.json' with { type: 'json' }
import { between, ctx, log, mon, now, origin, pick, sdk, signerFor, sleep, store, v1 } from './activity.ts'

interface Position {
  agentId: string
  name: string
  account: Address
  amount: string
}
interface BackerData {
  cycles: number
  nextAt: number
  positions: Position[]
  unstaker: boolean
  queued: Address | null
  paused?: boolean
}

const BACKERS = Number(process.env.ACTIVITY_BACKERS ?? 8)
const CYCLES = Number(process.env.ACTIVITY_CYCLES ?? 4)
const MIN_MON = 0.12
const CREW = new Set(Object.values(crewJson.members).map((m) => m.name))
const DirectorySchema = Schema.Struct({
  agents: Schema.Array(
    Schema.Struct({
      agentId: Schema.String,
      wallet: Schema.String,
      profile: Schema.Struct({ name: Schema.String }),
      activity: Schema.optional(Schema.Unknown),
    }),
  ),
})

/** Crew agents in the directory, each once: the only accounts a backer stakes behind. */
async function crewAgents(): Promise<Array<{ agentId: string; name: string; account: Address }>> {
  const body: unknown = await fetch(`${origin}/data/directory`)
    .then((r) => r.json())
    .catch(() => ({}))
  const directory = Schema.decodeUnknownOption(DirectorySchema)(body)
  const agents = Option.isSome(directory) ? directory.value.agents : []
  const seen = new Set<string>()
  const out: Array<{ agentId: string; name: string; account: Address }> = []
  for (const a of agents) {
    if (!CREW.has(a.profile.name) || seen.has(a.profile.name) || !/^0x[0-9a-fA-F]{40}$/.test(a.wallet)) continue
    seen.add(a.profile.name)
    // SAFETY: the pattern above admits only a 20-byte hex address.
    out.push({ agentId: a.agentId, name: a.profile.name, account: a.wallet as Address })
  }
  return out
}

class Backer {
  readonly wallet: sdk.Wallet
  readonly state: ReturnType<typeof store<BackerData>>
  readonly id: string
  constructor(n: number) {
    this.id = `backer-${n}`
    this.wallet = signerFor(`backer_${n}`).wallet
    this.state = store<BackerData>(this.id, {
      cycles: 0,
      nextAt: now() + Math.round(between(0, 40) * 60),
      positions: [],
      unstaker: Math.random() < 0.25,
      queued: null,
    })
  }
  get data() {
    return this.state.saved.data
  }
  get address() {
    return this.wallet.account.address
  }
  log(event: string, detail: Record<string, unknown> = {}) {
    log(this.id, event, detail)
  }
}

/** Claims the faucet when it may; buys 1 to 5 mUSD of SIDE in the pool on about half the cycles. */
async function topUp(b: Backer, key: string) {
  const j = b.state.journal
  if ((await sdk.nextDripAt(ctx, b.address)) <= now())
    await j.send(`${key}/drip`, b.wallet, { ...sdk.dripCall(ctx, b.address), value: '0' })
  const market = ctx.deployment.market
  if (market === null || Math.random() < 0.5) return
  const decimals = await ctx.publicClient.readContract({
    address: market.quote,
    abi: erc20Abi,
    functionName: 'decimals',
  })
  const amountIn = parseUnits(between(1, 5).toFixed(2), decimals)
  const quoted = await sdk.quoteExactIn(ctx, market, market.quote, amountIn)
  const txs = await j.once(`${key}/swap-txs`, () =>
    sdk.swapTransactions(ctx, market, {
      owner: b.address,
      tokenIn: market.quote,
      amountIn,
      minOut: sdk.minOutFor(quoted.amountOut),
      deadline: now() + 600,
    }),
  )
  await j.transactions(`${key}/swap`, b.wallet, txs)
  b.log('bought', { mUSD: formatUnits(amountIn, decimals), SIDE: Number(formatEther(quoted.amountOut)).toFixed(0) })
}

/**
 * Stakes 100 to 600 SIDE (never more than it holds) behind one to three crew agents, some behind ones it already
 * backs. Each stake's plan is journaled, so a retried cycle sends and records the same stake once.
 */
async function stake(b: Backer, key: string) {
  const j = b.state.journal
  const agents = await crewAgents()
  if (agents.length === 0) return
  await j.contract('approve-vault', b.wallet, ctx.deployment.factory, erc20Abi, 'approve', [v1.vault, maxUint256])
  const count = await j.once(`${key}/count`, async () => 1 + Math.floor(Math.random() * 3))
  for (let i = 0; i < count; i++) {
    const plan = await j.once(`${key}/plan-${i}`, async () => {
      const held = Math.floor(Number(formatEther(await sdk.balanceOf(ctx, ctx.deployment.factory, b.address))))
      const favourite = b.data.positions.length > 0 && Math.random() < 0.3 ? pick(b.data.positions) : undefined
      const agent = favourite ?? pick(agents)
      const amount = Math.min(Math.round(between(100, 600)), held - 1)
      return agent === undefined || amount < 50
        ? null
        : { agentId: agent.agentId, name: agent.name, account: agent.account, amount: String(amount) }
    })
    if (plan === null) return
    await j.contract(`${key}/delegate-${i}`, b.wallet, v1.vault, sdk.stakeVaultAbi, 'delegate', [
      plan.account,
      parseEther(plan.amount),
    ])
    if (j.state.values[`${key}/recorded-${i}`] === true) continue
    b.data.positions.push(plan)
    j.state.values[`${key}/recorded-${i}`] = true
    b.state.save()
    b.log('staked', { agentId: plan.agentId, name: plan.name, SIDE: Number(plan.amount) })
  }
}

/** An unstaker asks to withdraw part of one position (a 3-day queue); later it may cancel the request. */
async function unstake(b: Backer, key: string) {
  const j = b.state.journal
  if (b.data.queued !== null) {
    if (Math.random() < 0.5) return
    const account = b.data.queued
    await j.contract(`${key}/cancel-undelegate`, b.wallet, v1.vault, sdk.stakeVaultAbi, 'cancelUndelegate', [account])
    b.data.queued = null
    b.log('unstake-cancelled', { account })
    return
  }
  const position = pick(b.data.positions)
  if (position === undefined) return
  const amount = parseEther(String(Math.round(Number(position.amount) * between(0.2, 0.6))))
  const shares = await sdk.undelegationShares(ctx, position.account, b.address, amount)
  await j.contract(`${key}/undelegate`, b.wallet, v1.vault, sdk.stakeVaultAbi, 'requestUndelegate', [
    position.account,
    shares,
  ])
  b.data.queued = position.account
  b.log('unstake-requested', { agentId: position.agentId, name: position.name, SIDE: formatEther(amount) })
}

async function cycle(b: Backer) {
  const key = `cycle-${b.data.cycles + 1}`
  await topUp(b, key)
  if (b.data.unstaker && b.data.cycles >= 2) await unstake(b, key)
  else await stake(b, key)
  b.data.cycles += 1
  b.data.nextAt = now() + Math.round(between(45, 120) * 60)
  b.state.save()
}

async function tick(b: Backer) {
  if (b.data.cycles >= CYCLES || now() < b.data.nextAt) return
  const balance = await mon(b.address)
  const paused = balance < MIN_MON
  if (paused !== (b.data.paused === true)) b.log(paused ? 'paused' : 'resumed', { mon: balance.toFixed(3) })
  b.data.paused = paused
  if (paused) return
  try {
    await cycle(b)
  } catch (error) {
    b.log('error', { cycle: b.data.cycles + 1, message: String(error).slice(0, 300) })
    b.data.nextAt = now() + 15 * 60
  }
  b.state.save()
}

const backers = Array.from({ length: BACKERS }, (_, i) => new Backer(i + 1))
const command = process.argv[2]
if (command === 'run')
  for (;;) {
    for (const b of backers) await tick(b)
    await sleep(60_000)
  }
else if (command === 'status')
  for (const b of backers)
    console.log(
      `${b.id} ${b.address} ${(await mon(b.address)).toFixed(3)} MON, ${b.data.cycles}/${CYCLES} cycles,`,
      b.data.positions.map((p) => `${p.name} ${p.amount}`).join(', '),
    )
else console.log('usage: bun crew/bin/backers.ts run|status')

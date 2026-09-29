/**
 * Proof (a) of the embed (ADR-0008): a $CHOMP skin contest published from the agent-jobs widget embedded in the
 * Monad Pet site (monad-pet-embed), entered by a crew agent, and awarded from the same widget; plus the testnet MON
 * drip for a fresh wallet that signs in through the board. Playwright drives Chromium with a key-backed EIP-1193
 * wallet injected into the page (nothing on the page is mocked); the entry comes from a headless Codex agent through
 * the board's MCP server, or, if it does not show up in time, from a scripted worker (logged as such).
 *
 *   bun --env-file=.env.local apps/explore/e2e/monadpet-commission.ts       (from the repo root)
 *
 * Env: PET_URL, EXPLORE_URL, BOARD_URL (staging defaults), MONAD_TESTNET_RPC_URL, TESTNET_CREATOR_PRIVATE_KEY (the
 * creator in the browser), CAMPAIGN_CODEX_PRIVATE_KEY + CAMPAIGN_CODEX_AGENT_ID (the entrant), TESTNET_WORKER_* and
 * WORKER_AGENT_ID (fallback entrant), LAUNCH_TOKEN_PRIVATE_KEY (tops up CHOMP), STACK (fast, else demo), RAW_DIR
 * (video), WORKER_TIMEOUT_MIN (default 25), CHROME_PATH (optional).
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type Browser, type BrowserContext, type FrameLocator, type Page, chromium } from 'playwright-core'
import { type Hex, createWalletClient, formatEther, formatUnits, http, parseUnits } from 'viem'
import { type PrivateKeyAccount, generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import * as sdk from '../../../packages/sdk/src/index.ts'
import { Cursor } from './cursor.ts'

import { readFileSync } from 'node:fs'
const localEnv: Record<string, string> = {}
try {
  for (const line of readFileSync(join(import.meta.dirname, '../../../.env.local'), 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line)
    if (m !== null) localEnv[m[1] as string] = m[2] as string
  }
} catch {}
/** `.env.local` first: the interactive shell exports another project's value for a few key names. */
const env = (n: string, fallback?: string) => {
  const v = localEnv[n] ?? process.env[n] ?? fallback
  if (v === undefined || v === '') throw new Error(`${n} is not set`)
  return v
}
const PET = env('PET_URL', 'https://monad-pet-embed.kristjan-grm11775.workers.dev').replace(/\/$/, '')
const _EXPLORE = env('EXPLORE_URL', 'https://agentjobs-explore-staging-67xgxuclftbgtgxn.kristjan-grm11775.workers.dev').replace(/\/$/, '')
const API = env('BOARD_URL', 'https://agentjobs-api-staging-ba2zqmaom6el4lws.kristjan-grm11775.workers.dev').replace(/\/$/, '')
const RPC = env('MONAD_TESTNET_RPC_URL').split(' ')[0] as string
const BOARD = 'monad-pet'
const RAW = env('RAW_DIR', join(homedir(), 'code/aj-launch-video/raw'))
const SHOTS = env('SHOTS', '/tmp/monadpet-proof')
const CHOMP = '0x130556848511554b181e645309754F265522F3c2' as const
const REWARD = env('REWARD', '500')
const WORKER_TIMEOUT_MIN = Number(env('WORKER_TIMEOUT_MIN', '25'))
const deployment = sdk.deployment('monad-testnet')
const STACK = (deployment.stacks[env('STACK', 'fast') as sdk.StackName] === undefined ? 'demo' : env('STACK', 'fast')) as sdk.StackName
const stack = sdk.stack(deployment, STACK)
const ctx = sdk.contextFor('monad-testnet', stack, RPC)
const creator = privateKeyToAccount(env('TESTNET_CREATOR_PRIVATE_KEY') as Hex)
const fallback = privateKeyToAccount(env('TESTNET_WORKER_PRIVATE_KEY') as Hex)
const FALLBACK_AGENT = env('WORKER_AGENT_ID', '1939')
const codexAgent = env('CAMPAIGN_CODEX_AGENT_ID', '1943')
const codexAddress = env('CAMPAIGN_CODEX_ADDRESS')
const log = (m: string) => console.log(`[proof-a ${new Date().toISOString().slice(11, 19)}] ${m}`)
const summary: string[] = []
let shot = 0
mkdirSync(SHOTS, { recursive: true })
mkdirSync(RAW, { recursive: true })

/** Converts the JSON typed data a dapp sends to what viem signs (uint strings → bigint, recursively by type). */
function typedFromJson(json: string) {
  const p = JSON.parse(json) as { types: Record<string, Array<{ name: string; type: string }>>; primaryType: string; domain: Record<string, unknown>; message: Record<string, unknown> }
  const { EIP712Domain: _d, ...types } = p.types
  const fix = (type: string, v: unknown): unknown => {
    if (type.endsWith('[]')) return (v as unknown[]).map((x) => fix(type.slice(0, -2), x))
    if (/^u?int\d*$/.test(type)) return BigInt(v as string)
    const fields = types[type]
    if (fields === undefined) return v
    return Object.fromEntries(fields.map((f) => [f.name, fix(f.type, (v as Record<string, unknown>)[f.name])]))
  }
  const domain = { ...p.domain, ...(p.domain.chainId === undefined ? {} : { chainId: Number(p.domain.chainId) }) }
  return { domain, types, primaryType: p.primaryType, message: fix(p.primaryType, p.message) as Record<string, unknown> }
}

async function walletContext(browser: Browser, account: PrivateKeyAccount): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, recordVideo: { dir: join(SHOTS, 'video'), size: { width: 1280, height: 900 } } })
  const wallet = createWalletClient({ account, chain: sdk.chains['monad-testnet'], transport: http(RPC) })
  await context.exposeBinding('__ajWallet', async (_src, method: string, params: unknown[]) => {
    switch (method) {
      case 'eth_requestAccounts':
      case 'eth_accounts':
        return [account.address]
      case 'eth_chainId':
        return `0x${deployment.chainId.toString(16)}`
      case 'net_version':
        return String(deployment.chainId)
      case 'wallet_switchEthereumChain':
      case 'wallet_addEthereumChain':
        return null
      case 'personal_sign':
        return account.signMessage({ message: { raw: params[0] as Hex } })
      case 'eth_signTypedData_v4':
        return account.signTypedData(typedFromJson(params[1] as string) as never)
      case 'eth_sendTransaction': {
        const t = params[0] as { to: Hex; data?: Hex; value?: string }
        const hash = await wallet.sendTransaction({ to: t.to, data: t.data, value: BigInt(t.value ?? '0x0'), chain: null })
        log(`wallet sent ${hash}`)
        return hash
      }
      default:
        return ctx.publicClient.request({ method, params } as never)
    }
  })
  await context.addInitScript(() => {
    const w = window as unknown as { ethereum: unknown; __ajWallet: (m: string, p: unknown[]) => Promise<unknown>; __ajEvents: unknown[] }
    w.ethereum = {
      isMetaMask: true,
      request: ({ method, params }: { method: string; params?: unknown[] }) => w.__ajWallet(method, params ?? []),
      on: () => {},
      removeListener: () => {},
    }
    w.__ajEvents = []
    window.addEventListener('message', (e) => {
      const m = e.data as { source?: string }
      if (m !== null && typeof m === 'object' && m.source === 'agent-jobs') w.__ajEvents.push(m)
    })
  })
  await Cursor.install(context)
  return context
}

async function snap(page: Page, name: string) {
  shot++
  const file = join(SHOTS, `${String(shot).padStart(2, '0')}-${name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  log(`screenshot ${file}`)
}

async function waitEvent(page: Page, type: string, timeout = 240_000) {
  await page.waitForFunction((t) => ((window as unknown as { __ajEvents: Array<{ type: string }> }).__ajEvents ?? []).some((e) => e.type === t), type, { timeout })
  const events = (await page.evaluate(() => (window as unknown as { __ajEvents: unknown[] }).__ajEvents)) as Array<{ type: string; payload: Record<string, unknown> }>
  return events.filter((e) => e.type === type).at(-1)?.payload ?? {}
}

/** Clicks each wallet step of the widget's TxSteps list in order until every step shows ✓. */
async function clickSteps(frame: FrameLocator, cur: Cursor) {
  const list = frame.locator('ol').last()
  await list.waitFor({ timeout: 60_000 })
  const n = await list.locator('li').count()
  for (let i = 0; i < n; i++) {
    const next = list.locator('button:not([disabled])').first()
    if ((await next.count()) === 0) return
    const label = (await next.innerText()).trim()
    log(`click step: ${label}`)
    await cur.click(next)
    await list.locator('li').nth(i).getByText('✓').waitFor({ timeout: 180_000 })
    const err = frame.locator('ol .text-red-600')
    if ((await err.count()) > 0) throw new Error(`step failed: ${await err.innerText()}`)
  }
}

async function ensureFunds() {
  const chomp = await sdk.balanceOf(ctx, CHOMP, creator.address)
  const need = parseUnits(REWARD, 18) + parseUnits('10', 18)
  if (chomp < need) {
    const funder = sdk.wallet('monad-testnet', privateKeyToAccount(env('LAUNCH_TOKEN_PRIVATE_KEY') as Hex), RPC)
    const hash = await funder.writeContract({ address: CHOMP, abi: sdk.factoryTokenAbi, functionName: 'transfer', args: [creator.address, need] })
    await ctx.publicClient.waitForTransactionReceipt({ hash })
    log(`topped the creator up with ${formatUnits(need, 18)} CHOMP: ${hash}`)
  }
  const factory = await sdk.balanceOf(ctx, deployment.factory, creator.address)
  if (factory < 2n * 10n ** 18n) {
    const w = sdk.wallet('monad-testnet', creator, RPC)
    const r = await sdk.faucet(ctx, w, deployment.factory)
    log(`creator FACTORY faucet: ${r.transactionHash}`)
  }
  log(`creator ${creator.address}: ${formatEther(await ctx.publicClient.getBalance({ address: creator.address }))} MON, ${formatUnits(await sdk.balanceOf(ctx, CHOMP, creator.address), 18)} CHOMP`)
}

/** The crew's Codex agent, headless through the board's MCP server, told to enter this contest. */
function startCodexWorker(taskId: string) {
  const root = join(import.meta.dirname, '../../..')
  const prompt = join(SHOTS, 'skin-prompt.txt')
  const instruction = `Enter the CONTEST task ${taskId} on the agent-jobs board (the MCP server you have is that board: sign in with your wallet first). Do the work first: draw an SVG skin for the Monad Pet mascot (a friendly round pet, 256x256 viewBox, under 20 KB, a new colour scheme and one accessory), save it as skins/codex-skin.svg, commit it on a NEW branch named skin/codex-${taskId.slice(0, 6)} of github.com/grmkris/monad-pet (clone with gh, push the branch; never touch main). Then register your entry with prepare_entry using deliverable {kind: "git", url: "https://github.com/grmkris/monad-pet", ref: "<your branch>", sha: "<full 40-char commit sha>"} and your agent id ${codexAgent}, sign BOTH typed-data messages it returns with cast wallet sign --data, and call submit_entry with both signatures. A contest needs no activation and no bond. Report the candidateId and stop.`
  const mk = spawn('bash', [join(root, 'packages/sdk/scripts/harness/worker-prompt.sh'), prompt, codexAgent, 'monad-pet', instruction], { stdio: 'ignore' })
  return new Promise<void>((resolve, reject) => {
    mk.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`worker-prompt.sh exited ${code}`))
      const child = spawn('bash', [join(root, 'packages/sdk/scripts/harness/run-agent.sh'), 'codex', 'skin-codex', 'CAMPAIGN_CODEX_PRIVATE_KEY', prompt], {
        stdio: 'ignore',
        detached: true,
        env: { ...process.env, MCP_URL: `${API}/b/${BOARD}/mcp`, RUNS: join(SHOTS, 'runs') },
      })
      child.unref()
      log(`codex worker started (pid ${child.pid}); transcript in ${join(SHOTS, 'runs')}/skin-codex.jsonl`)
      resolve()
    })
  })
}

/** A scripted entrant: hosts an SVG in a public gist (the operator's gh login) and enters as an `artifact`. */
async function scriptedEntry(taskId: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256"><rect width="256" height="256" rx="48" fill="#836EF9"/><circle cx="128" cy="140" r="78" fill="#FFD166" stroke="#200052" stroke-width="8"/><circle cx="100" cy="128" r="14" fill="#200052"/><circle cx="156" cy="128" r="14" fill="#200052"/><path d="M96 168 Q128 196 160 168" stroke="#200052" stroke-width="8" fill="none" stroke-linecap="round"/><path d="M128 62 L142 86 L114 86 Z" fill="#3DDC97" stroke="#200052" stroke-width="6" stroke-linejoin="round"/></svg>\n`
  const file = join(SHOTS, `pet-skin-${taskId.slice(0, 6)}.svg`)
  writeFileSync(file, svg)
  const sha256 = createHash('sha256').update(svg).digest('hex')
  const { execFileSync } = await import('node:child_process')
  const gistUrl = execFileSync('gh', ['gist', 'create', '--public', '--desc', `Monad Pet skin entry for task ${taskId}`, file], { encoding: 'utf8' }).trim().split('\n').at(-1) as string
  const m = /^https:\/\/gist\.github\.com\/([^/]+)\/([0-9a-f]+)$/.exec(gistUrl)
  if (m === null) throw new Error(`unexpected gist URL ${gistUrl}`)
  const url = `https://gist.githubusercontent.com/${m[1]}/${m[2]}/raw/${file.split('/').pop()}`
  log(`scripted entrant hosts the SVG at ${url}`)
  const board = sdk.boardClient(`${API}/b/${BOARD}`)
  await board.signIn(fallback)
  const w = sdk.wallet('monad-testnet', fallback, RPC)
  const prep = await board.call<{ candidateId: string; sign: Array<{ typedData: string }>; check: { ok: boolean | null; detail: string } }>('prepare_entry', {
    taskId,
    agentId: FALLBACK_AGENT,
    deliverable: { kind: 'artifact', url, sha256: `0x${sha256}`, mediaType: 'image/svg+xml', name: file.split('/').pop() },
  })
  log(`board check of the artifact: ${JSON.stringify(prep.check)}`)
  const [budget, submit] = prep.sign
  const budgetSignature = await sdk.signTypedDataJson(w, (budget as { typedData: string }).typedData)
  const submitSignature = await sdk.signTypedDataJson(w, (submit as { typedData: string }).typedData)
  await board.call('submit_entry', { taskId, candidateId: prep.candidateId, budgetSignature, submitSignature })
  summary.push(`entry by the scripted fallback worker ${fallback.address} (agent ${FALLBACK_AGENT}): artifact ${url}, sha256 0x${sha256}, candidate ${prep.candidateId}`)
  return { worker: fallback.address, candidateId: prep.candidateId }
}

async function main() {
  await ensureFunds()
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH === undefined ? {} : { executablePath: process.env.CHROME_PATH }) })
  const context = await walletContext(browser, creator)
  const page = await context.newPage()
  page.on('pageerror', (e) => log(`page error: ${e.message}`))
  const video = page.video()
  try {
    await page.goto(`${PET}/?wallet=injected&view=publish#commissions`, { waitUntil: 'domcontentloaded' })
    const cur = new Cursor(page)
    await cur.show()
    const frame = page.frameLocator('iframe[title="agent-jobs"]')
    await frame.locator('header').waitFor({ timeout: 60_000 })
    await page.waitForTimeout(1500)
    await snap(page, 'monad-pet-with-widget')
    // Sign in inside the widget (the injected wallet connects itself; a Connect button appears only if it did not).
    const connect = frame.getByRole('button', { name: 'Connect wallet' })
    if ((await connect.count()) > 0) await cur.click(connect)
    await cur.click(frame.getByRole('button', { name: 'Sign in' }))
    await frame.getByText('signed in').waitFor({ timeout: 60_000 })
    summary.push(`creator ${creator.address} signed in inside the widget on ${PET} (SIWE domain = the Monad Pet host)`)
    await snap(page, 'signed-in')
    // The form is prefilled by the page (title, brief, contest, CHOMP, reward); set the bonds, windows and deliverables.
    await frame.getByLabel('Your bond (FACTORY)').fill('1')
    await frame.getByLabel('Award within (hours)').fill('0.75')
    await frame.getByLabel('Delivery within (hours)').fill('1.5')
    const stackSelect = frame.getByLabel('Board')
    if ((await stackSelect.count()) > 0) await stackSelect.selectOption(STACK).catch(async () => stackSelect.selectOption('demo'))
    await frame.getByLabel('file', { exact: true }).check()
    await frame.getByLabel('Where you want it (optional)').fill('an SVG skin for the pet, 256×256, under 20 KB; a file or a branch of github.com/grmkris/monad-pet')
    await snap(page, 'form')
    await cur.click(frame.getByRole('button', { name: 'Freeze offer and screen' }))
    await frame.getByText('Review and publish').waitFor({ timeout: 120_000 })
    await snap(page, 'review')
    await clickSteps(frame, cur)
    const published = (await waitEvent(page, 'published')) as { taskId: string; jobId: string | null; txHash: string | null }
    log(`published: ${JSON.stringify(published)}`)
    summary.push(`contest published from the widget: task ${published.taskId}, job ${published.jobId}, tx ${published.txHash}, stack ${STACK}, ${REWARD} CHOMP`)
    await snap(page, 'published')
    const taskId = published.taskId

    // The entrant: the crew's Codex agent, then the scripted fallback.
    let entrant: { worker: string; candidateId: string } | null = null
    const board = sdk.boardClient(`${API}/b/${BOARD}`)
    await board.signIn(creator)
    try {
      await startCodexWorker(taskId)
      const deadline = Date.now() + WORKER_TIMEOUT_MIN * 60_000
      while (Date.now() < deadline) {
        const list = await board.call<Array<{ candidateId: string; worker: string }>>('list_candidates', { taskId })
        const mine = list.find((c) => c.worker.toLowerCase() === codexAddress.toLowerCase()) ?? list[0]
        if (mine !== undefined) {
          entrant = mine
          summary.push(`entry by the Codex crew agent ${mine.worker} (agent ${codexAgent}): candidate ${mine.candidateId}`)
          break
        }
        await new Promise((r) => setTimeout(r, 20_000))
      }
    } catch (e) {
      log(`codex worker could not be started: ${(e as Error).message}`)
    }
    if (entrant === null) {
      log('no crew entry in time; the scripted fallback enters (logged)')
      entrant = await scriptedEntry(taskId)
    }
    const before = await sdk.balanceOf(ctx, CHOMP, entrant.worker as Hex)

    // Award from the widget: reopen the page on the task view.
    await page.goto(`${PET}/?wallet=injected&view=task&taskId=${taskId}#commissions`, { waitUntil: 'domcontentloaded' })
    await cur.show()
    await frame.locator('header').waitFor({ timeout: 60_000 })
    const signIn = frame.getByRole('button', { name: 'Sign in' })
    if ((await signIn.count()) > 0) {
      await cur.click(signIn)
      await frame.getByText('signed in').waitFor({ timeout: 60_000 })
    }
    const award = frame.getByRole('button', { name: 'Award' }).first()
    await award.waitFor({ timeout: 120_000 })
    await snap(page, 'entries')
    await cur.click(award)
    await clickSteps(frame, cur)
    const awarded = (await waitEvent(page, 'awarded')) as { txHash: string | null }
    log(`awarded: ${JSON.stringify(awarded)}`)
    summary.push(`awarded from the widget: tx ${awarded.txHash}`)
    await snap(page, 'awarded')

    // Chain checks.
    let status = ''
    for (let i = 0; i < 12 && status !== 'completed'; i++) {
      status = ((await board.call<{ chain?: { status?: string } }>('get_task', { taskId })).chain?.status ?? '') as string
      if (status !== 'completed') await new Promise((r) => setTimeout(r, 5000))
    }
    const after = await sdk.balanceOf(ctx, CHOMP, entrant.worker as Hex)
    summary.push(`chain status ${status}; entrant CHOMP ${formatUnits(before, 18)} → ${formatUnits(after, 18)} (+${formatUnits(after - before, 18)})`)
    if (status !== 'completed') throw new Error(`job not completed: ${status}`)
    if (after - before !== parseUnits(REWARD, 18)) throw new Error('the entrant did not receive the prize')

    // The drip: a brand-new wallet signs in through the board and gets MON it never had.
    const fresh = privateKeyToAccount(generatePrivateKey())
    const r = (await sdk.boardClient(`${API}/b/${BOARD}`).signIn(fresh)) as { drip?: { status: string; txHash?: string; reason?: string } }
    const dripped = await ctx.publicClient.getBalance({ address: fresh.address })
    summary.push(`drip: fresh wallet ${fresh.address} signed in → ${JSON.stringify(r.drip)}; balance ${formatEther(dripped)} MON`)
    if (r.drip?.status !== 'sent' || dripped === 0n) throw new Error('the drip did not arrive')
  } finally {
    await context.close()
    await browser.close()
    if (video !== null) {
      const p = await video.path()
      const out = join(RAW, 'embed-commission.webm')
      if (existsSync(p)) {
        // A copy, not a rename: /tmp and the raw directory are different filesystems (EXDEV).
        copyFileSync(p, out)
        unlinkSync(p)
        summary.push(`video ${out}`)
      }
    }
    console.log('\n=== proof (a) summary ===')
    for (const l of summary) console.log(`- ${l}`)
  }
}

await main()

/**
 * Explore clicked through in a real browser against the staging site and Monad testnet (CP4).
 *
 * NOTE (28 Sep): the site's sign-in is Privy only since then, so this script's injected key-backed wallet no longer
 * has a "Connect wallet" button to press. It needs a Privy test account (email + fixed OTP from the Privy dashboard)
 * to log in before it runs again; the flows below are unchanged. Playwright drives
 * Chromium; the page's wallet is an EIP-1193 provider injected into the page and backed by a testnet key in this
 * process, so every signature and transaction is real (nothing on the page is mocked). The other party is scripted
 * through the board API.
 *
 *   EXPLORE_URL=https://… bun apps/explore/e2e/click-through.ts   (from the repo root; .env.local is loaded;
 *   needs `playwright-core` and a Playwright Chromium, e.g. `bunx playwright install chromium`)
 *
 * Scenario 1 (creator in the browser): connect, sign in, publish a hire on the demo board (Jev screening shown,
 * approval and publish as wallet steps), select the scripted worker's application, approve its submission.
 * Scenario 2 (both parties in browsers): the creator rejects a submission with a reason; the worker disputes it
 * with a statement from its own browser wallet. Screenshots go to SHOTS (default /tmp/explore-e2e).
 * Scenario 3 (SCENARIOS=contest): the creator publishes a contest in the browser (or resumes CONTEST_JOB/CONTEST_TASK),
 * waits for CONTEST_ENTRIES outside entries (harness workers, the MetaMask wallet), then awards AWARD_WORKER's entry
 * (default the first) early.
 * SCENARIOS picks which run: "hire,dispute" by default.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, type BrowserContext, type Page, chromium } from 'playwright-core'
import { type Hex, createWalletClient, http } from 'viem'
import { type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts'
import * as sdk from '../../../packages/sdk/src/index.ts'

const env = (n: string, fallback?: string) => {
  const v = process.env[n] ?? fallback
  if (v === undefined || v === '') throw new Error(`${n} is not set`)
  return v
}
const EXPLORE = env('EXPLORE_URL').replace(/\/$/, '')
const RPC = env('MONAD_TESTNET_RPC_URL')
const SHOTS = env('SHOTS', '/tmp/explore-e2e')
const CHROME = process.env.CHROME_PATH
const ctx = sdk.context('monad-testnet', 'demo', RPC)
const creatorKey = privateKeyToAccount(env('TESTNET_CREATOR_PRIVATE_KEY') as Hex)
const workerKey = privateKeyToAccount(env('TESTNET_WORKER_PRIVATE_KEY') as Hex)
const WORKER_AGENT = env('WORKER_AGENT_ID', '1939')
const board = sdk.boardClient(EXPLORE)
const log = (m: string) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}] ${m}`)
let shot = 0

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

/** A browser context whose page wallet is `account` (EIP-1193 over a Playwright binding). */
async function walletContext(browser: Browser, account: PrivateKeyAccount): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const wallet = createWalletClient({ account, chain: { id: ctx.deployment.chainId, name: 'Monad testnet', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } }, transport: http(RPC) })
  await context.exposeBinding('__ajWallet', async (_src, method: string, params: unknown[]) => {
    switch (method) {
      case 'eth_requestAccounts':
      case 'eth_accounts':
        return [account.address]
      case 'eth_chainId':
        return `0x${ctx.deployment.chainId.toString(16)}`
      case 'net_version':
        return String(ctx.deployment.chainId)
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
    const w = window as unknown as { ethereum: unknown; __ajWallet: (m: string, p: unknown[]) => Promise<unknown> }
    w.ethereum = {
      isMetaMask: true,
      request: ({ method, params }: { method: string; params?: unknown[] }) => w.__ajWallet(method, params ?? []),
      on: () => {},
      removeListener: () => {},
    }
  })
  return context
}

async function snap(page: Page, name: string) {
  shot++
  const file = join(SHOTS, `${String(shot).padStart(2, '0')}-${name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  log(`screenshot ${file}`)
}

async function signIn(page: Page) {
  await page.goto(`${EXPLORE}/`)
  await page.getByRole('button', { name: 'Connect wallet' }).click()
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.getByRole('button', { name: 'Sign out' }).waitFor({ timeout: 30_000 })
}

/** Clicks each wallet step of a TxSteps list in order until all are ✓. */
async function clickSteps(page: Page) {
  const list = page.locator('ol').last()
  await list.waitFor()
  for (let i = 0; i < 10; i++) {
    const next = list.locator('button:not([disabled])').first()
    if ((await next.count()) === 0) return
    const label = (await next.innerText()).trim()
    log(`click step: ${label}`)
    await next.click()
    await page.waitForFunction((l) => ![...document.querySelectorAll('ol button')].some((b) => b.textContent?.trim() === l && !(b as HTMLButtonElement).disabled), label, { timeout: 120_000 })
    const err = page.locator('ol .text-red-600')
    if ((await err.count()) > 0) throw new Error(`step failed: ${await err.innerText()}`)
  }
}

async function workerSend(taskId: string, txs: sdk.TxRequest[]) {
  const w = sdk.wallet('monad-testnet', workerKey, RPC)
  for (const h of await sdk.sendAll(w, ctx.publicClient, txs)) await board.call('report_transaction', { taskId, txHash: h })
}

/** The scripted worker takes the selected job and submits the fixture's passing commit. */
async function workerActivateAndSubmit(taskId: string) {
  for (let i = 0; i < 40; i++) {
    if ((await board.call('get_task', { taskId })).mine?.selected === true) break
    await new Promise((r) => setTimeout(r, 3000))
  }
  const prep = await board.call('prepare_activation', { taskId })
  await workerSend(taskId, prep.transactions)
  const act = await board.call('build_activation', { taskId, budgetSignature: await sdk.signTypedDataJson(sdk.wallet('monad-testnet', workerKey, RPC), prep.sign.typedData) })
  await workerSend(taskId, act.transactions)
  const sub = await board.call('submit_work', { taskId, repo: 'https://github.com/grmkris/runner-spike-fixture', branch: 'dispatch/cb0b4323adb67f08', sha: 'c850f7a58015bafe065257f263a2ecc01da56dfe' })
  await workerSend(taskId, sub.transactions)
  log('worker activated and submitted')
}

interface PublishForm {
  mode: 'hire' | 'contest'
  brief: string
  criteria?: string
  reward: string
  awardHours?: string
}
const CI_HIRE: PublishForm = {
  mode: 'hire',
  brief: 'Add CI to https://github.com/grmkris/runner-spike-fixture that runs its tests on push and pull_request (browser click-through).',
  reward: '3',
}

async function publishInBrowser(page: Page, title: string, form: PublishForm = CI_HIRE): Promise<{ jobId: string; taskId: string }> {
  await page.getByRole('link', { name: 'Publish' }).click()
  await page.getByLabel(/^Mode/).selectOption(form.mode)
  await page.getByLabel('Board').selectOption('demo')
  await page.getByLabel('Title').fill(title)
  await page.getByLabel('Brief').fill(form.brief)
  if (form.criteria !== undefined) await page.getByLabel('Acceptance criteria').fill(form.criteria)
  await page.getByLabel('Reward', { exact: true }).fill(form.reward)
  await page.getByLabel('Your bond (FACTORY)').fill('1')
  if (form.mode === 'hire') await page.getByLabel('Worker bond (FACTORY)').fill('1')
  await page.getByLabel('Delivery within (hours)').fill('1')
  if (form.awardHours !== undefined) await page.getByLabel('Award within (hours)').fill(form.awardHours)
  await snap(page, 'publish-form')
  await page.getByRole('button', { name: 'Freeze offer and screen' }).click()
  await page.getByText('Review and publish').waitFor({ timeout: 90_000 }).catch(async (e: Error) => {
    await snap(page, 'publish-failed')
    throw new Error(`publish form: ${(await page.locator('.text-red-600').allInnerTexts()).join('; ') || e.message}`)
  })
  await snap(page, 'publish-screened')
  await clickSteps(page)
  await page.waitForURL(/\/job\/\d+$/, { timeout: 60_000 })
  const jobId = page.url().split('/').at(-1) as string
  const index = await board.call<Array<{ taskId: string; jobId: string | null }>>('task_index', {})
  const taskId = index.find((t) => t.jobId === jobId)?.taskId as string
  log(`published job ${jobId} (task ${taskId}) from the browser`)
  await snap(page, 'published-job')
  return { jobId, taskId }
}

async function selectInBrowser(page: Page, jobId: string, taskId: string) {
  await board.call('apply', { taskId, agentId: WORKER_AGENT, note: 'Scripted worker for the browser click-through.' })
  await page.goto(`${EXPLORE}/job/${jobId}`)
  await page.getByRole('button', { name: 'Select' }).first().click({ timeout: 60_000 })
  await page.getByText('selected; waiting for activation').waitFor({ timeout: 60_000 })
  await snap(page, 'selected')
}

async function waitStatus(page: Page, jobId: string, status: string) {
  for (let i = 0; i < 40; i++) {
    await page.goto(`${EXPLORE}/job/${jobId}`)
    // The page loads its data after navigation: wait for the status badge rather than reading it at once.
    if (await page.getByText(status, { exact: true }).first().waitFor({ timeout: 15_000 }).then(() => true, () => false)) return
  }
  throw new Error(`job ${jobId} never showed ${status}`)
}

mkdirSync(SHOTS, { recursive: true })
const browser = await chromium.launch({ headless: true, ...(CHROME === undefined ? {} : { executablePath: CHROME }) })
try {
  await board.signIn(workerKey)
  const scenarios = env('SCENARIOS', 'hire,dispute').split(',')
  const creatorCtx = await walletContext(browser, creatorKey)
  const page = await creatorCtx.newPage()
  await signIn(page)
  await snap(page, 'signed-in')
  const done: Array<{ jobId: string; taskId: string }> = []

  if (scenarios.includes('hire')) {
    // Scenario 1: publish → select → approve, all by the creator in the browser.
    const one = await publishInBrowser(page, 'Browser click-through: approve path')
    await selectInBrowser(page, one.jobId, one.taskId)
    await workerActivateAndSubmit(one.taskId)
    await waitStatus(page, one.jobId, 'submitted')
    await page.getByRole('button', { name: 'Approve and pay' }).click()
    await clickSteps(page)
    await waitStatus(page, one.jobId, 'completed')
    await snap(page, 'approved-completed')
    done.push(one)
  }

  if (scenarios.includes('dispute')) {
    // Scenario 2: publish → select → reject by the creator; dispute by the worker in its own browser.
    const two = await publishInBrowser(page, 'Browser click-through: reject and dispute path')
    await selectInBrowser(page, two.jobId, two.taskId)
    await workerActivateAndSubmit(two.taskId)
    await waitStatus(page, two.jobId, 'submitted')
    await page.getByRole('combobox').first().selectOption('None')
    await page.getByPlaceholder('Reason (published; its hash goes on-chain)').fill('Browser click-through: rejected to exercise the dispute UI; no defect is claimed.')
    await page.getByRole('button', { name: 'Reject' }).click()
    await clickSteps(page)
    await waitStatus(page, two.jobId, 'rejected-pending')
    await snap(page, 'rejected')
    const workerCtx = await walletContext(browser, workerKey)
    const wpage = await workerCtx.newPage()
    await signIn(wpage)
    await wpage.goto(`${EXPLORE}/job/${two.jobId}`)
    await wpage.getByPlaceholder('Your case for the arbitrator').fill('The required check passes on the submitted SHA and the rejection names no defect.')
    await wpage.getByRole('button', { name: 'Dispute' }).click()
    await clickSteps(wpage)
    await waitStatus(wpage, two.jobId, 'disputed')
    await snap(wpage, 'disputed')
    done.push(two)
  }

  if (scenarios.includes('contest')) {
    // Scenario 3: a contest from the website; outside entrants deliver first; the approver awards one early.
    const repo = env('CONTEST_REPO', 'grmkris/aj-bounty-md-toc')
    const resume = process.env.CONTEST_TASK === undefined ? undefined : { jobId: env('CONTEST_JOB'), taskId: env('CONTEST_TASK') }
    const c = resume ?? await publishInBrowser(page, env('CONTEST_TITLE', 'Contest: Markdown table of contents'), {
      mode: 'contest',
      brief: `Implement the spec in the README of https://github.com/${repo} (TypeScript, Bun). Enter a finished commit on a new branch of that repository, never main. Only the awarded entry is paid; the approver may award early.`,
      criteria: 'A GitHub check run named "test" completes with conclusion "success" on the submitted SHA.\nThe implementation meets the spec in the repository README.\nThe existing tests under test/ are unchanged: none edited or deleted.',
      reward: env('CONTEST_REWARD', '8'),
      awardHours: env('CONTEST_AWARD_HOURS', '0.5'),
    })
    console.log(`CONTEST_JOB=${c.jobId} CONTEST_TASK=${c.taskId}`)
    // Only the creator or approver sees every entry.
    const creatorBoard = sdk.boardClient(EXPLORE)
    await creatorBoard.signIn(creatorKey)
    const want = Number(env('CONTEST_ENTRIES', '2'))
    type Entry = { candidateId: string; worker: string }
    let entries: Entry[] = []
    for (let i = 0; i < 240 && entries.length < want; i++) {
      entries = await creatorBoard.call<Entry[]>('list_candidates', { taskId: c.taskId })
      if (entries.length < want) await new Promise((r) => setTimeout(r, 15_000))
    }
    log(`${entries.length} entries: ${entries.map((e) => e.worker).join(', ')}`)
    const pick = process.env.AWARD_WORKER?.toLowerCase()
    const winner = entries.find((e) => e.worker.toLowerCase() === pick) ?? entries[0]
    if (winner === undefined) throw new Error('no entries to award')
    await page.goto(`${EXPLORE}/job/${c.jobId}`)
    await page.getByRole('button', { name: 'Award' }).first().waitFor({ timeout: 60_000 })
    await snap(page, 'contest-entries')
    const idx = entries.indexOf(winner)
    await page.getByRole('button', { name: 'Award' }).nth(idx).click()
    await clickSteps(page)
    await waitStatus(page, c.jobId, 'completed')
    await snap(page, 'contest-awarded')
    done.push(c)
  }
  console.log(`JOBS=${done.map((d) => d.jobId).join(',')} TASKS=${done.map((d) => d.taskId).join(',')}`)
} finally {
  await browser.close()
}

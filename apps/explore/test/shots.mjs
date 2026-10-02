import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { encodeFunctionData, parseAbi } from 'viem';
import { createServer } from 'vite';

// Screenshots of the v1 pages for a polish pass, each in a realistic state from the e2e fixtures, at phone and desktop
// width: `<page>-<width>.png` in the output directory. Not a test: it asserts nothing beyond the page rendering, and
// prints what it wrote. Mocked Chromium only: no live board, signing or sends.
//   heavy node test/shots.mjs ~/code/agent-jobs.wt/ui-shots [page…]
const directory = fileURLToPath(new URL('.', import.meta.url));
const output = process.argv[2] ?? '/tmp/hireling-shots';
const only = process.argv.slice(3);
const base = 'http://127.0.0.1:5202';
const me = '0x1111111111111111111111111111111111111111';
const agentWallet = '0x6666666666666666666666666666666666666666';
const config = JSON.parse(readFileSync(new URL('../../../contracts/config/monad-testnet.json', import.meta.url), 'utf8'));
const token = config.deployment.rewardTokens[0].toLowerCase();
const contracts = { factory: '0xf000000000000000000000000000000000000001', vault: '0xf000000000000000000000000000000000000002', feeSchedule: '0xf000000000000000000000000000000000000003', distributor: '0xf000000000000000000000000000000000000004', miningReserve: '0xf000000000000000000000000000000000000005', holding: '0xf000000000000000000000000000000000000006', evaluator: '0xf000000000000000000000000000000000000007', safe: '0xf000000000000000000000000000000000000008' };
const now = Math.floor(Date.now() / 1000);
const K = 10n ** 18n;
const widths = [390, 1440];

const reply = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const offer = (jobId, status) => ({ taskId: `task-${jobId}`, jobId, stack: 'main', title: 'Fix the checkout on mobile Safari', brief: 'The checkout button does nothing on iOS 18 Safari. Find out why and fix it; keep the change small.', acceptanceCriteria: ['Checkout completes on iOS 18 Safari', 'No change to desktop behaviour'], mode: 'hire', token, reward: '25000000', creatorBond: (5n * K).toString(), workerBond: (3n * K).toString(), creator: me, approver: me, deliveryDeadline: now + 2 * 86400, selectionDeadline: null, requiredChecks: [], quoted: false, executionBudget: null, termsHash: `0x${jobId.padStart(64, '0')}`, manifestUrl: `/offers/${jobId}.json`, screening: { verdict: 'clean', reasons: [] }, createdAt: now - 3600, status });
const chainJob = (id, status) => ({ job_id: id, status, mode: 'hire', stack: 'main', board_id: 'public', token, reward: '25000000', creator: me, approver: me, worker: status === 'open' ? null : agentWallet, agent_id: status === 'open' ? null : '1942', delivery_deadline: now + 2 * 86400, creator_bond: (5n * K).toString(), worker_bond: (3n * K).toString(), violation: null, rejection_reason_hash: null });

/** Board and chain-data replies shared by every page; `api` answers the page's own tools first. */
function routes(api = {}, jobs = {}) {
  return async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort('blockedbyclient');
    if (url.pathname === '/__test/token') return reply(route, { symbol: 'mUSD', decimals: 6 });
    if (url.pathname === '/__test/receipt') return reply(route, { status: 'success' });
    if (url.pathname === '/data/jobs') return reply(route, { ok: true, jobs: Object.entries(jobs).map(([id, s]) => chainJob(id, s)), index: { next_block: 100, updated_at: now } });
    const detail = /^\/data\/jobs\/(\d+)$/.exec(url.pathname)?.[1];
    if (detail !== undefined && jobs[detail] !== undefined) return reply(route, { ok: true, job: chainJob(detail, jobs[detail]), board: { boardId: 'public', taskId: `task-${detail}` }, rewards: [], bonds: [], evidence: [], timeline: [], ruling: null, feedback: null });
    if (url.pathname.startsWith('/data/')) return reply(route, { ok: true, agents: [], jobs: [], boards: [] });
    if (!url.pathname.includes('/api/')) return route.continue();
    const name = url.pathname.replace(/^.*\/api\//, '');
    if (api[name] !== undefined) return reply(route, { ok: true, result: api[name](route.request().postDataJSON()) });
    if (name === 'task_index') return reply(route, { ok: true, result: Object.entries(jobs).map(([id, s]) => offer(id, s)) });
    if (name === 'get_task') {
      const id = /^task-(\d+)$/.exec(route.request().postDataJSON().taskId)?.[1];
      if (id === undefined || jobs[id] === undefined) return reply(route, { ok: true, result: { taskId: 'x', jobId: null, creator: me } });
      return reply(route, { ok: true, result: { ...offer(id, jobs[id]), you: [], selection: [], terms: { brief: offer(id).brief, acceptanceCriteria: offer(id).acceptanceCriteria, windows: { reviewSeconds: 86400, disputeSeconds: 86400, arbitrationSeconds: 172800 } }, chain: { status: jobs[id], provider: jobs[id] === 'open' ? null : agentWallet, timely: true, submittedAt: null, reviewEndsAt: null, disputeEndsAt: null, arbitrationEndsAt: null, violation: null, listingMatchesOffer: true, paused: false } } });
    }
    return reply(route, { ok: false, message: 'Fixture denies this operation' }, 400);
  };
}

const settle = encodeFunctionData({ abi: parseAbi(['function settle(uint256 jobId)']), functionName: 'settle', args: [72n] });
const miningClaim = encodeFunctionData({ abi: parseAbi(['function claim(uint256 epoch, address account, uint256 amount, bytes32[] proof)']), functionName: 'claim', args: [0n, me, 1234n * K, []] });
const PAGES = [
  {
    name: 'stake', wagmi: 'stake-wagmi.mjs', path: '/stake',
    init: () => { window.__stake = { wallet: 18_400n * 10n ** 18n, staked: 25_000n * 10n ** 18n, reserved: 1500n * 10n ** 18n, unstaking: 2000n * 10n ** 18n, unlockAt: Math.floor(Date.now() / 1000) + 3 * 86400, nonce: 0n, calls: [], open: true, denied: {}, proposal: { holding: '0xf000000000000000000000000000000000000009', eta: Math.floor(Date.now() / 1000) + 5 * 86400 } }; },
  },
  {
    name: 'collect', wagmi: 'wagmi.mjs', path: '/collect',
    api: { collect_actions: () => [
      { kind: 'settle', jobId: '72', description: 'The rejection is final: this releases the escrow and the bonds.', transactions: [{ description: 'Settle job #72', chainId: 10143, to: contracts.holding, data: settle, value: '0' }] },
      { kind: 'claimTopUpRefund', jobId: '71', token, amount: '2000000', description: 'The creator was refunded, so your top-up comes back to you.', transactions: [{ description: 'Claim', chainId: 10143, to: contracts.holding, data: settle, value: '0' }] },
      { kind: 'miningClaim', epoch: '0', token: config.deployment.factory, amount: (1234n * K).toString(), description: 'Claim work mining into your FACTORY stake.', transactions: [{ description: 'Claim', chainId: 10143, to: contracts.distributor, data: miningClaim, value: '0', gas: '500000' }] },
    ] },
  },
  {
    name: 'admin', wagmi: 'admin-wagmi.mjs', path: '/admin',
    init: (c) => {
      const tiers = { thresholds: [0n, 10_000n * 10n ** 18n, 100_000n * 10n ** 18n, 1_000_000n * 10n ** 18n], bps: [3000, 1000, 300, 100], treasury: c.safe };
      const t = Math.floor(Date.now() / 1000);
      window.__bytecode = { '0x9641d764fc13c8b624c04430c7356c1c7c8102e2': '0x6080' };
      window.__admin = {
        safe: c.safe, owners: ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222'], threshold: 1n,
        owner: Object.fromEntries([c.feeSchedule, c.vault, c.holding, c.evaluator, c.miningReserve, c.distributor].map((a) => [a.toLowerCase(), c.safe])), pendingOwner: {},
        paused: false, pauses: [], safeIsAdmin: true, schedule: tiers,
        pending: { schedule: { ...tiers, bps: [3000, 800, 300, 100] }, eta: t + 2 * 86400 }, bootstrapped: true,
        pendingHolding: { holding: '0xf000000000000000000000000000000000000009', eta: t + 6 * 86400 }, holdings: [c.holding],
        // Epoch 1's 5,000 funded and posted, 1,200 claimed: 3,800 owed and nothing spare, as the contracts keep it.
        currentEpoch: 2n, totalFunded: 5000n * 10n ** 18n, available: 0n, outstanding: 3800n * 10n ** 18n, genesis: t - (3 * 86400 + 604800 + 302400), nonce: 7n, signWith: 'owner',
        decimals: { '0xabd60a1e40519e3609c4f9ebb551fcf242a8ad8f': 6, '0xdeef53f34fa71c46e7bb6e34d42d4cf36987c44e': 6, '0x130556848511554b181e645309754f265522f3c2': 18 },
        roots: { 1: { root: `0x${'ab'.repeat(32)}`, total: 5000n * 10n ** 18n, claimed: 1200n * 10n ** 18n, dataHash: `0x${'cd'.repeat(32)}` } }, calls: [], down: false,
      };
    },
  },
  {
    name: 'telegram', wagmi: 'onboarding-wagmi.mjs', privy: 'onboarding-privy.mjs', path: '/telegram',
    api: { telegram_status: () => ({ linked: false, username: null, linkedAt: null }) },
  },
  {
    name: 'publish', wagmi: 'v1-wagmi.mjs', path: '/publish', v1: true,
    prepare: async (page) => {
      await page.locator('#post-title').fill('Fix the checkout on mobile Safari');
      await page.locator('#post-brief').fill('The checkout button does nothing on iOS 18 Safari. Find out why and fix it.');
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page.locator('#post-invite').fill('1942');
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page.locator('#post-reward').fill('25');
      await page.locator('#post-creator-bond').fill('5');
      await page.locator('#post-worker-bond').fill('3');
    },
  },
  { name: 'job-quote', wagmi: 'v1-wagmi.mjs', path: '/job/70', v1: true, account: '0x5555555555555555555555555555555555555555', jobs: { 70: 'open' } },
  { name: 'job-topup', wagmi: 'v1-wagmi.mjs', path: '/job/71', v1: true, account: '0x5555555555555555555555555555555555555555', jobs: { 71: 'active' }, v1State: { bonus: 2_000_000n, topUp: 0n } },
];

mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/home/kristjan/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome' });
process.env.PRIVY_APP_ID = 'fixture-privy-app-id';
try {
  for (const p of PAGES.filter((x) => only.length === 0 || only.includes(x.name))) {
    const server = await createServer({ envFile: false, logLevel: 'silent', server: { host: '127.0.0.1', port: 5202, strictPort: true }, plugins: [{ name: 'shots-fixtures', enforce: 'pre', resolveId(source) {
      if (source === 'wagmi') return `${directory}${p.wagmi}`;
      if (source === 'wagmi/actions') return `${directory}wagmi-actions.mjs`;
      if (source.endsWith('/Privy.tsx')) return `${directory}${p.privy ?? 'privy.mjs'}`;
      if (source === '@privy-io/react-auth') return `${directory}privy-react-auth.mjs`;
    }, transform(source, id) {
      if (id.endsWith('/src/hireling.ts')) return source.replace(/export const hireling: HirelingContracts \| null =[\s\S]*?(\n\n|\n?$)/, 'export const hireling: HirelingContracts | null = (window as { __hireling?: HirelingContracts | null }).__hireling ?? null$1');
    } }] });
    await server.listen();
    try {
      for (const width of widths) {
        const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, hasTouch: width === 390, isMobile: width === 390 });
        await context.addInitScript(({ account, c, v1State }) => {
          window.__hireling = c;
          window.__wallet = { address: account, connected: true, signatures: [], messages: [], sends: [], upgrades: 0 };
          const extra = Object.fromEntries(Object.entries(v1State ?? {}).map(([k, v]) => [k, BigInt(v)]));
          window.__v1 = { arbiter: '0xa000000000000000000000000000000000000001', free: 2n * 10n ** 18n, quote: [1000, 2500000n, 22500000n], topUp: 0n, bonus: 0n, ...extra };
          localStorage.setItem('agent-jobs.session', 'fixture-only-not-a-real-session');
          localStorage.setItem('agent-jobs.session-owner', JSON.stringify({ address: account, expiresAt: Math.floor(Date.now() / 1000) + 86400 }));
        }, { account: p.account ?? me, c: contracts, v1State: p.v1State === undefined ? null : Object.fromEntries(Object.entries(p.v1State).map(([k, v]) => [k, String(v)])) });
        if (p.init !== undefined) await context.addInitScript(p.init, contracts);
        await context.route('**/*', routes(p.api, p.jobs));
        const page = await context.newPage();
        await page.goto(`${base}${p.path}`);
        if (p.prepare !== undefined) await p.prepare(page);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(400);
        const file = `${output}/${p.name}-${width}.png`;
        await page.screenshot({ path: file, fullPage: true });
        console.log(file);
        await context.close();
      }
    } finally {
      await server.close();
    }
  }
} finally {
  await browser.close();
}

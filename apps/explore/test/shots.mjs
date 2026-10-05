import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { concat, encodeAbiParameters, encodeFunctionData, encodePacked, parseAbi } from 'viem';
import { build, createServer, preview } from 'vite';
import { overflow, shifts, smallTargets, trackShifts, unnamed } from './audit-checks.mjs';
import { sponsorshipGrantTerms } from './grant-fixture.mjs';

// Screenshots of the v1 pages for a polish pass, each in a realistic state from the e2e fixtures, at two phone widths and
// desktop: `<page>-<width>.png` in the output directory. Promoted testnet contract addresses; fixture states,
// board and wallet. These captures are illustrations, not live transactions. Writes capture.json with provenance.
//   --prod   serve the production build (vite build with the fixtures, then vite preview) instead of the dev server;
//   --audit  at 375 and 390 px, with chain reads answering 1.2 s late: touch targets under 44 px, interactive elements
//            without an accessible name, horizontal scroll and layout shifts (audit-checks.mjs). Writes audit.json and
//            exits 1 on any finding (U-PERF-A11Y).
//   --widths=390,1440  only these widths.
//   heavy node test/shots.mjs ~/code/agent-jobs.wt/ui-shots [--prod] [--audit] [--widths=…] [page…]
const directory = fileURLToPath(new URL('.', import.meta.url));
const args = process.argv.slice(2);
const prod = args.includes('--prod');
const auditing = args.includes('--audit');
const widthsFlag = args.find((a) => a.startsWith('--widths='))?.slice('--widths='.length);
const [output = '/tmp/hireling-shots', ...only] = args.filter((a) => !a.startsWith('--'));
const base = 'http://127.0.0.1:5202';
const me = '0x1111111111111111111111111111111111111111';
const agentWallet = '0x6666666666666666666666666666666666666666';
const configSource = readFileSync(new URL('../../../contracts/config/monad-testnet.json', import.meta.url), 'utf8');
const config = JSON.parse(configSource);
const token = config.deployment.rewardTokens[0].toLowerCase();
assert.equal(config.deployment.main.kind, 'hireling-v1', 'Submission captures require a promoted v1 testnet deployment');
const { factory, vault, feeSchedule, distributor, miningReserve, safe } = config.deployment.hireling;
const contracts = { factory, vault, feeSchedule, distributor, miningReserve, safe, holding: config.deployment.main.holding, evaluator: config.deployment.main.evaluator };
const grantTerms = sponsorshipGrantTerms(contracts);
const now = Math.floor(Date.now() / 1000);
const K = 10n ** 18n;
const widths = widthsFlag !== undefined ? widthsFlag.split(',').map(Number) : auditing ? [375, 390] : [375, 390, 1440];
const LATENCY = 1200;

const reply = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
// Job 74 is the one the lifecycle shots follow; the others fill the home page with the kind of work agents did on testnet.
const TITLES = { 74: 'Fix the checkout on mobile Safari', 75: 'Add a CI badge and a test job to the README', 76: 'Roman numeral converter with property tests', 77: 'Summarise 40 support tickets into a FAQ', 78: 'Port the CSV stats script to TypeScript' };
const offer = (jobId, status) => ({ taskId: `task-${jobId}`, jobId, stack: 'main', title: TITLES[jobId] ?? TITLES[74], brief: 'The checkout button does nothing on iOS 18 Safari. Find out why and fix it; keep the change small.', acceptanceCriteria: ['Checkout completes on iOS 18 Safari', 'No change to desktop behaviour'], mode: 'hire', token, reward: '25000000', creatorBond: (5n * K).toString(), workerBond: (3n * K).toString(), creator: me, approver: me, deliveryDeadline: now + 2 * 86400, selectionDeadline: null, requiredChecks: [], quoted: false, executionBudget: null, termsHash: `0x${jobId.padStart(64, '0')}`, manifestUrl: `/offers/${jobId}.json`, screening: { verdict: 'clean', reasons: [] }, createdAt: now - 3600, status });
const chainJob = (id, status) => ({ job_id: id, status, mode: 'hire', stack: 'main', board_id: 'public', token, reward: '25000000', creator: me, approver: me, worker: status === 'open' ? null : agentWallet, agent_id: status === 'open' ? null : '1942', delivery_deadline: now + 2 * 86400, creator_bond: (5n * K).toString(), worker_bond: (3n * K).toString(), violation: null, rejection_reason_hash: null });
const DELIVERED = ['submitted', 'completed', 'rejected-pending', 'disputed'];
// Job history (/data/agents) as the staging indexer read it on 3 Oct, for the agents the shots name.
const AGENTS = [
  { agentId: '1942', jobs: 14, completed: 11, inProgress: 3, lost: 0, earned: { [token]: '45000000' }, feedback: { completed: 11 }, lastBlock: 100 },
  { agentId: '1939', jobs: 21, completed: 13, inProgress: 1, lost: 7, earned: { [token]: '47000000' }, feedback: { completed: 13, 'rejected-quality': 2 }, lastBlock: 100 },
  { agentId: '1944', jobs: 5, completed: 4, inProgress: 1, lost: 0, earned: { [token]: '21000000' }, feedback: { completed: 4 }, lastBlock: 100 },
  { agentId: '1943', jobs: 4, completed: 3, inProgress: 1, lost: 0, earned: { [token]: '20000000' }, feedback: { completed: 3 }, lastBlock: 100 },
];
// Opted-in directory entries: fixtures (the testnet directory itself is still empty).
const listing = (agentId, name, description, service, seconds, fresh = true) => ({
  agentId, chainId: config.chainId, identityRegistry: config.erc8004.identity, wallet: agentWallet, profile: { name, description, services: [service] }, profileSource: 'operator-supplied', agentURI: '', enrolled: true, ownership: 'verified',
  presence: { freshness: fresh ? 'fresh' : 'stale', state: 'available', accepting: fresh, lastSeenBucket: now - (now % 60) },
  ads: [{ serviceId: service.toLowerCase().replaceAll(' ', '-'), name: service, description, inputs: 'A repository and acceptance criteria', outputs: 'A commit with CI green', turnaroundSeconds: seconds, price: { model: 'quote', amountBaseUnits: '0', token }, adHash: `0x${'00'.repeat(32)}`, expiresAt: now + 86400 }],
  observedAt: now, projectionAt: now, revision: 1,
});
const DIRECTORY = [
  listing('1942', 'Claude Code worker', 'Small fixes and features in TypeScript repositories, delivered as a branch with CI green.', 'Bug fixes', 3600),
  listing('1943', 'Codex worker', 'Ports, refactors and test suites; quotes before it starts.', 'Refactors', 7200),
  listing('1944', 'Grok worker', 'Scripts, data clean-up and CSV tooling.', 'Data scripts', 3600, false),
];
const DATA = {
  '/data/stats': () => ({ ok: true, jobs: 61, completed: 36, agents: 9, paidOut: { [token]: '649000000' }, inEscrow: { [token]: '10000000' } }),
  '/data/agents': () => ({ ok: true, agents: AGENTS }),
  '/data/directory': () => ({ ok: true, agents: DIRECTORY, nextCursor: null, observedAt: now, chainId: config.chainId, identityRegistry: config.erc8004.identity, scope: 'opted-in Hireling directory' }),
};

/**
 * Board and chain-data replies shared by every page. The page's `api` answers its own tools first; `jobs` maps job IDs
 * to chain statuses; `detail(id)` and `task(id)` add to that job's indexer record and board task; `data` replaces
 * /data answers; `account` is the viewer.
 */
function routes(p) {
  const { api = {}, jobs = {} } = p;
  const account = p.account ?? me;
  const data = { ...DATA, ...p.data };
  return async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort('blockedbyclient');
    if (url.pathname === '/__test/token') return reply(route, { symbol: 'mUSD', decimals: 6 });
    if (url.pathname === '/__test/receipt') return reply(route, { status: 'success' });
    if (url.pathname === '/data/jobs') return reply(route, { ok: true, jobs: Object.entries(jobs).map(([id, s]) => chainJob(id, s)), index: { next_block: 100, updated_at: now } });
    const detail = /^\/data\/jobs\/(\d+)$/.exec(url.pathname)?.[1];
    if (detail !== undefined && jobs[detail] !== undefined) return reply(route, { ok: true, job: chainJob(detail, jobs[detail]), board: { boardId: 'public', taskId: `task-${detail}` }, submission: null, rewards: [], bonds: [], evidence: [], timeline: [], ruling: null, feedback: null, ...p.detail?.(detail) });
    const agent = /^\/data\/(agents|directory)\/(\d+)$/.exec(url.pathname);
    if (agent !== null) {
      const summary = AGENTS.find((a) => a.agentId === agent[2]);
      if (agent[1] === 'directory') return reply(route, { ok: true, agent: DIRECTORY.find((a) => a.agentId === agent[2]) ?? listing(agent[2], `Agent #${agent[2]}`, '', 'Code review', 3600) });
      return summary === undefined ? reply(route, { ok: false, code: 'not-found', message: 'No jobs yet' }, 404) : reply(route, { ok: true, agent: summary, wallets: [agentWallet], bonds: { returned: summary.completed }, jobs: [], feedback: [] });
    }
    if (data[url.pathname] !== undefined) return reply(route, data[url.pathname]());
    if (url.pathname.startsWith('/data/')) return reply(route, { ok: true, agents: [], jobs: [], boards: [] });
    if (!url.pathname.includes('/api/')) return route.continue();
    const name = url.pathname.replace(/^.*\/api\//, '');
    if (api[name] !== undefined) return reply(route, { ok: true, result: api[name](route.request().postDataJSON()) });
    if (name === 'task_index') return reply(route, { ok: true, result: Object.entries(jobs).map(([id, s]) => offer(id, s)) });
    if (name === 'get_task') {
      const id = /^task-(\d+)$/.exec(route.request().postDataJSON().taskId)?.[1];
      const status = jobs[id];
      if (id === undefined || status === undefined) return reply(route, { ok: true, result: { taskId: 'x', jobId: null, creator: me } });
      const delivered = DELIVERED.includes(status);
      const you = account === me ? ['creator', 'approver'] : account === agentWallet && status !== 'open' ? ['worker'] : [];
      const { chain: chainExtra, ...extra } = p.task?.(id) ?? {};
      const chain = { status, provider: status === 'open' ? null : agentWallet, timely: true, submittedAt: delivered ? now - 5400 : null, reviewEndsAt: status === 'submitted' ? now + 22 * 3600 : null, disputeEndsAt: null, arbitrationEndsAt: null, violation: null, listingMatchesOffer: true, paused: false, ...chainExtra };
      return reply(route, { ok: true, result: { ...offer(id, status), you, selection: [], terms: { brief: offer(id).brief, acceptanceCriteria: offer(id).acceptanceCriteria, windows: { reviewSeconds: 86400, disputeSeconds: 86400, arbitrationSeconds: 172800 } }, chain, ...extra } });
    }
    return reply(route, { ok: false, message: 'Fixture denies this operation' }, 400);
  };
}

const settle = encodeFunctionData({ abi: parseAbi(['function settle(uint256 jobId)']), functionName: 'settle', args: [72n] });
const miningClaim = encodeFunctionData({ abi: parseAbi(['function claim(uint256 epoch, address account, uint256 amount, bytes32[] proof)']), functionName: 'claim', args: [0n, me, 1234n * K, []] });
// The sponsorship sheet's permission, as sponsor_prepare hands it out (onboarding.e2e.mjs): Hireling's contracts only.
const delegation = JSON.stringify({
  types: { EIP712Domain: [], Delegation: [{ name: 'delegate', type: 'address' }, { name: 'delegator', type: 'address' }, { name: 'authority', type: 'bytes32' }, { name: 'caveats', type: 'Caveat[]' }, { name: 'salt', type: 'uint256' }], Caveat: [{ name: 'enforcer', type: 'address' }, { name: 'terms', type: 'bytes' }] },
  primaryType: 'Delegation',
  domain: { name: 'DelegationManager', version: '1', chainId: 10143, verifyingContract: config.delegation.manager },
  message: {
    delegate: config.roles.relay, delegator: me, authority: `0x${'f'.repeat(64)}`, salt: '7',
    caveats: [
      { enforcer: config.delegation.enforcers.allowedTargets, terms: concat(grantTerms.targets) },
      { enforcer: config.delegation.enforcers.allowedMethods, terms: grantTerms.methods },
      { enforcer: config.delegation.enforcers.limitedCalls, terms: encodeAbiParameters([{ type: 'uint256' }], [100n]) },
      { enforcer: config.delegation.enforcers.timestamp, terms: encodePacked(['uint128', 'uint128'], [0n, BigInt(now + 30 * 86400)]) },
    ],
  },
});
const onboarding = { wagmi: 'onboarding-wagmi.mjs', privy: 'onboarding-privy.mjs' };
// Job 74's story for the lifecycle shots, as the indexer reports it: what happened and in which transaction.
const hash = (n) => `0x${n.toString(16).padStart(4, '0').repeat(16)}`;
const event = (name, values, ago, n) => ({ name, block: 1000 + n, logIndex: 0, txHash: hash(n), args: values, at: now - ago });
const NET = '22500000'; // 25 mUSD less the 10 % tier fee (quoteActivation)
const story = {
  published: [event('Published', { reward: '25000000' }, 26 * 3600, 1)],
  active: [event('Activated', { agentId: '1942' }, 25 * 3600, 2)],
  delivered: [event('JobSubmitted', {}, 5400, 3), event('EvidenceAttached', { conclusion: 1 }, 5000, 4)],
  deliveredEarlier: [event('JobSubmitted', {}, 6 * 3600, 3), event('EvidenceAttached', { conclusion: 1 }, 6 * 3600 - 400, 4)],
  paid: [event('Accepted', {}, 1800, 5), event('PaymentReleased', { amount: NET }, 1800, 6), event('FeedbackRecorded', { tag: 'completed' }, 1800, 7)],
  ruled: [event('Rejected', { violation: 1 }, 4 * 3600, 8), event('Disputed', {}, 3 * 3600, 9), event('Ruled', { forWorker: true, slashLoser: true }, 1800, 10), event('BondBurned', { side: 0, amount: (5n * K).toString() }, 1800, 11), event('PaymentReleased', { amount: NET }, 1800, 12), event('FeedbackRecorded', { tag: 'completed' }, 1800, 13)],
};
const commit = '4f1c2a9e7b3d51c08e6a2f94d7c1b3e5a8f60d21';
const delivery = { deliverables: [{ repo: 'https://github.com/example-shop/storefront', branch: 'fix/safari-checkout', sha: commit, deliverable_hash: `0x${'5e'.repeat(32)}`, check: { ok: true, detail: `${commit.slice(0, 7)} is on fix/safari-checkout`, checkedAt: now - 5400 } }] };
const evidence = [{ verifier: config.roles.attester, submission_hash: `0x${'5e'.repeat(32)}`, tested_sha: commit, conclusion: 'success', expired: false, onchainMatch: true, tx_hash: hash(4) }];
const lifecycle = (name, status, timeline, ruled = null) => ({
  name, wagmi: 'v1-wagmi.mjs', path: '/job/74', v1: true, jobs: { 74: status, 75: 'completed', 76: 'completed' },
  task: () => ({ ...(DELIVERED.includes(status) || ruled !== null ? delivery : {}), chain: { violation: ruled === null ? null : 'Quality' } }),
  detail: () => ({
    timeline, evidence: DELIVERED.includes(status) || ruled !== null ? evidence : [],
    job: { ...chainJob('74', status), published_tx: hash(1), violation: ruled === null ? null : 'Quality', rejection_reason_hash: ruled === null ? null : `0x${'9a'.repeat(32)}`, ...(status === 'open' ? {} : { fee_bps: 1000, fee: '2500000', net: NET }) },
    rewards: status === 'completed' ? [{ kind: 'reward', recipient: agentWallet, amount: NET, tx_hash: hash(6) }] : [],
    ruling: ruled,
  }),
  api: { list_applications: () => [{ id: 'app-1942', worker: agentWallet, agent_id: '1942', note: 'Invited. I can start now.' }], get_dispute_bundle: () => ({ bundle: { rejection: { reasonText: 'Does not fix the bug on my phone.' }, statements: [{ role: 'worker', text: 'CI is green on 4f1c2a9 and the fix is in checkout.ts; the rejection names no failing case.' }] } }) },
  ...(status === 'active' ? { v1State: { bonus: 2_000_000n } } : {}),
});
const PAGES = [
  {
    name: 'stake', wagmi: 'stake-wagmi.mjs', path: '/stake',
    init: () => { window.__stake = { wallet: 18_400n * 10n ** 18n, staked: 25_000n * 10n ** 18n, reserved: 1500n * 10n ** 18n, unstaking: 2000n * 10n ** 18n, unlockAt: Math.floor(Date.now() / 1000) + 3 * 86400, nonce: 0n, calls: [], open: true, denied: {}, proposal: { holding: '0x000000000000000000000000000000000000dEaD', eta: Math.floor(Date.now() / 1000) + 5 * 86400 } }; },
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
        pendingHolding: { holding: '0x000000000000000000000000000000000000dEaD', eta: t + 6 * 86400 }, holdings: [c.holding],
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
  {
    name: 'me', ...onboarding, path: '/me',
    api: { sponsor_status: () => ({ status: 'none', typedData: null, callsUsed: 0 }), telegram_status: () => ({ linked: false, username: null, linkedAt: null }) },
  },
  {
    name: 'sponsorship', ...onboarding, path: '/sponsorship',
    api: { sponsor_status: () => ({ status: 'none', typedData: null, callsUsed: 0 }), sponsor_prepare: () => ({ sign: { typedData: delegation }, upgrade: { delegator: config.delegation.delegator } }) },
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Turn on' }).click();
      await page.getByRole('dialog', { name: 'Let Hireling pay your gas?' }).getByText('Call Holding', { exact: true }).waitFor();
    },
  },
  { name: 'job-quote', wagmi: 'v1-wagmi.mjs', path: '/job/70', v1: true, account: '0x5555555555555555555555555555555555555555', jobs: { 70: 'open' } },
  { name: 'job-topup', wagmi: 'v1-wagmi.mjs', path: '/job/71', v1: true, account: '0x5555555555555555555555555555555555555555', jobs: { 71: 'active' }, v1State: { bonus: 2_000_000n, topUp: 0n } },
  // One direct hire through its lifecycle, seen by its creator; then the same job had it been rejected, disputed and ruled.
  lifecycle('job-published', 'open', story.published),
  lifecycle('job-active', 'active', [...story.published, ...story.active]),
  lifecycle('job-review', 'submitted', [...story.published, ...story.active, ...story.delivered]),
  lifecycle('job-paid', 'completed', [...story.published, ...story.active, ...story.delivered, ...story.paid]),
  lifecycle('job-ruled', 'completed', [...story.published, ...story.active, ...story.deliveredEarlier, ...story.ruled], { for_worker: 1, slash_loser: 1, reason_hash: `0x${'7b'.repeat(32)}`, tx_hash: hash(10) }),
  { name: 'home', wagmi: 'v1-wagmi.mjs', path: '/', visitor: true, jobs: { 74: 'open', 75: 'active', 76: 'submitted', 77: 'completed', 78: 'completed' } },
  { name: 'directory', wagmi: 'directory-wagmi.mjs', path: '/workers', visitor: true },
  {
    name: 'publish-review', wagmi: 'v1-wagmi.mjs', path: '/publish', v1: true, v1State: { free: 20_000n * K },
    init: () => { window.__balances = { native: 3n * 10n ** 18n, balanceOf: 120_000_000n }; },
    api: { create_task: () => ({ taskId: 'task-74', termsHash: `0x${'74'.repeat(32)}`, manifestUrl: '/offers/74.json', screening: { verdict: 'clean', reasons: [] }, transactions: [{ description: 'Approve reward token', chainId: 10143, to: token, data: '0x01', value: '0' }, { description: 'Publish job', chainId: 10143, to: contracts.holding, data: '0x02', value: '0' }] }) },
    prepare: async (page) => {
      await page.locator('#post-title').fill('Fix the checkout on mobile Safari');
      await page.locator('#post-brief').fill('The checkout button does nothing on iOS 18 Safari. Find out why and fix it.');
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page.locator('#post-invite').fill('1942');
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page.locator('#post-reward').fill('25');
      await page.getByRole('radio', { name: 'Fast', exact: true }).click();
      await page.locator('#post-creator-bond').fill('5');
      await page.locator('#post-worker-bond').fill('3');
      await page.getByRole('button', { name: 'Review', exact: true }).click();
      await page.getByRole('button', { name: /Confirm step 1 of 2/ }).waitFor();
    },
  },
  // The production mainnet build as it is before launch day (no deployment in the config, MAINNET_LIVE false): Explore's
  // own wagmi and Privy, no fixture modules, nothing indexed yet.
  ...['/', '/stake'].map((path) => ({ name: `launch${path === '/' ? '-home' : path.replace('/', '-')}`, network: 'monad-mainnet', path, visitor: true, data: { '/data/stats': () => ({ ok: true, jobs: 0, completed: 0, agents: 0, paidOut: {}, inEscrow: {} }), '/data/agents': () => ({ ok: true, agents: [] }), '/data/directory': () => ({ ok: true, agents: [], nextCursor: null, observedAt: now, chainId: 143, identityRegistry: config.erc8004.identity, scope: 'opted-in Hireling directory' }) } })),
];

mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/home/kristjan/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome' });
process.env.PRIVY_APP_ID = 'fixture-privy-app-id';

/** The page's fixture modules in place of wagmi and Privy. */
const fixtures = (p) => ({ name: 'shots-fixtures', enforce: 'pre', resolveId(source) {
  if (source === 'wagmi') return `${directory}${p.wagmi}`;
  if (source === 'wagmi/actions') return `${directory}${p.wagmi === 'admin-wagmi.mjs' ? 'admin-wagmi-actions.mjs' : 'wagmi-actions.mjs'}`;
  if (source.endsWith('/Privy.tsx')) return `${directory}${p.privy ?? 'privy.mjs'}`;
  if (source === '@privy-io/react-auth') return `${directory}privy-react-auth.mjs`;
} });
const built = new Map();
/**
 * The dev server, or (--prod) the production build for this page's fixtures, built once per set and previewed. A page
 * with a `network` is that network's build with no fixture modules (vite.config reads AGENT_JOBS_NETWORK when it loads).
 */
async function serve(p) {
  const env = { network: process.env.AGENT_JOBS_NETWORK, privy: process.env.HIRELING_PROD_PRIVY_APP_ID };
  if (p.network !== undefined) {
    process.env.AGENT_JOBS_NETWORK = p.network;
    delete process.env.HIRELING_PROD_PRIVY_APP_ID;
  }
  try {
    const plugins = p.network === undefined ? [fixtures(p)] : [];
    if (!prod) {
      const server = await createServer({ envFile: false, logLevel: 'silent', server: { host: '127.0.0.1', port: 5202, strictPort: true }, plugins });
      await server.listen();
      return server;
    }
    const key = (p.network ?? `${p.wagmi}-${p.privy ?? 'privy.mjs'}`).replace(/[^a-z0-9]+/gi, '-');
    const outDir = `/tmp/hireling-prod-build/${key}`;
    if (!built.has(key)) {
      await build({ envFile: false, logLevel: 'error', plugins, build: { outDir, emptyOutDir: true } });
      built.set(key, outDir);
    }
    return await preview({ envFile: false, logLevel: 'silent', preview: { host: '127.0.0.1', port: 5202, strictPort: true }, build: { outDir } });
  } finally {
    if (env.network === undefined) delete process.env.AGENT_JOBS_NETWORK;
    else process.env.AGENT_JOBS_NETWORK = env.network;
    if (env.privy !== undefined) process.env.HIRELING_PROD_PRIVY_APP_ID = env.privy;
  }
}

const report = [];
const captures = [];
const pageErrors = [];
try {
  for (const p of PAGES.filter((x) => only.length === 0 || only.includes(x.name))) {
    const server = await serve(p);
    try {
      for (const width of widths) {
        const phone = width < 600;
        const context = await browser.newContext({ viewport: { width, height: width === 375 ? 667 : width === 390 ? 844 : 900 }, hasTouch: phone, isMobile: phone });
        // A visitor has no wallet connected and no board session.
        await context.addInitScript(({ account, c, arbiter, v1State, latency, visitor }) => {
          window.__hireling = c;
          window.__chainLatency = latency;
          window.__wallet = { address: account, connected: !visitor, signatures: [], messages: [], sends: [], upgrades: 0 };
          const extra = Object.fromEntries(Object.entries(v1State ?? {}).map(([k, v]) => [k, BigInt(v)]));
          window.__v1 = { arbiter, free: 2n * 10n ** 18n, quote: [1000, 2500000n, 22500000n], topUp: 0n, bonus: 0n, ...extra };
          if (visitor) return;
          localStorage.setItem('agent-jobs.session', 'fixture-only-not-a-real-session');
          localStorage.setItem('agent-jobs.session-owner', JSON.stringify({ address: account, expiresAt: Math.floor(Date.now() / 1000) + 86400 }));
        }, { account: p.account ?? me, c: contracts, arbiter: config.hireling.defaultArbitrator, latency: auditing ? LATENCY : 0, visitor: p.visitor === true, v1State: p.v1State === undefined ? null : Object.fromEntries(Object.entries(p.v1State).map(([k, v]) => [k, String(v)])) });
        if (p.init !== undefined) await context.addInitScript(p.init, contracts);
        if (auditing) await context.addInitScript(trackShifts);
        await context.route('**/*', routes(p));
        const page = await context.newPage();
        page.on('pageerror', (error) => { pageErrors.push({ page: p.name, width, message: error.message }); });
        page.on('console', (message) => { if (message.type() === 'error') console.log(`  console error on ${p.name}@${width}: ${message.text().slice(0, 200)}`); });
        await page.goto(`${base}${p.path}`);
        if (p.prepare !== undefined) await p.prepare(page);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(auditing ? LATENCY * 2 + 600 : 400);
        const file = `${output}/${p.name}-${width}.png`;
        if (auditing) await page.screenshot({ path: file, fullPage: true });
        else {
          // The whole page in one viewport, so the fixed tab bar and sidebar sit where a person sees them, not mid-page.
          await page.setViewportSize({ width, height: Math.max(page.viewportSize().height, await page.evaluate(() => document.documentElement.scrollHeight)) });
          await page.waitForTimeout(300);
          await page.screenshot({ path: file });
        }
        console.log(file);
        captures.push({ page: p.name, width, file: `${p.name}-${width}.png`, network: p.network ?? 'monad-testnet',
          addresses: p.network === undefined ? 'promoted testnet config' : 'current mainnet config',
          state: p.network === undefined ? 'fixture board, indexer, wallet and contract read results; no live transactions' : 'mainnet launch gate; no fixture modules' });
        if (auditing) {
          const found = { page: p.name, width, small: await smallTargets(page), unnamed: await unnamed(page), overflow: await overflow(page), shifts: await shifts(page) };
          report.push(found);
          const shifted = found.shifts.total > 0.01;
          console.log(`  ${found.small.length} small, ${found.unnamed.length} unnamed, ${found.overflow === null ? 'no' : 'HORIZONTAL'} scroll, layout shift ${found.shifts.total}${shifted ? ' (over 0.01)' : ''}`);
          for (const t of found.small) console.log(`    small ${t.size} ${t.target}`);
          for (const u of found.unnamed) console.log(`    unnamed ${u.role} ${u.html}`);
          if (found.overflow !== null) console.log(`    overflow ${JSON.stringify(found.overflow)}`);
          if (shifted) for (const sh of found.shifts.list) console.log(`    shift ${sh.value} at ${sh.at} ms: ${sh.sources.join(', ')}`);
        }
        await context.close();
      }
    } finally {
      await server.close();
    }
  }
} finally {
  await browser.close();
}
writeFileSync(`${output}/capture.json`, JSON.stringify({ build: prod ? 'production' : 'dev', capturedAt: new Date().toISOString(),
  configSha256: createHash('sha256').update(configSource).digest('hex'), deploymentBlock: config.deployment.hireling.block,
  contracts, defaultArbitrator: config.hireling.defaultArbitrator, captures, pageErrors }, null, 2));
assert.deepEqual(pageErrors, [], 'Submission capture contains a page error');
if (auditing) {
  writeFileSync(`${output}/audit.json`, JSON.stringify({ build: prod ? 'production' : 'dev', latency: LATENCY, report }, null, 2));
  const failing = report.filter((r) => r.small.length > 0 || r.unnamed.length > 0 || r.overflow !== null || r.shifts.total > 0.01);
  console.log(failing.length === 0 ? `AUDIT PASS: ${report.length} page-widths` : `AUDIT FINDINGS on ${failing.map((r) => `${r.page}@${r.width}`).join(', ')}`);
  if (failing.length > 0) process.exitCode = 1;
}

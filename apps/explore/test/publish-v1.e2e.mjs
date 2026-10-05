import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { encodeFunctionData, parseAbi } from 'viem';
import { createServer } from 'vite';

// Publishing on Hireling v1 (U1): a direct hire with a named agent, window presets and custom windows within the
// Holding's bounds, Hireling's arbiter by name or a custom one with a warning, bonds reserved from stake, and the
// exact create_task arguments. Mocked Chromium only: no live board, signing or sends.
const directory = fileURLToPath(new URL('.', import.meta.url));
const output = process.argv[2] ?? '/tmp/hireling-publish-v1-evidence';
const base = 'http://127.0.0.1:5197';
const creator = '0x1111111111111111111111111111111111111111';
const arbiter = '0xa000000000000000000000000000000000000001';
const custom = '0xa000000000000000000000000000000000000002';
const config = JSON.parse(readFileSync(new URL('../../../contracts/config/monad-testnet.json', import.meta.url), 'utf8'));
const token = config.deployment.rewardTokens[0].toLowerCase();
const contracts = { factory: '0xf000000000000000000000000000000000000001', vault: '0xf000000000000000000000000000000000000002', feeSchedule: '0xf000000000000000000000000000000000000003', distributor: '0xf000000000000000000000000000000000000004', miningReserve: '0xf000000000000000000000000000000000000005', holding: '0xf000000000000000000000000000000000000006', evaluator: '0xf000000000000000000000000000000000000007', safe: '0xf000000000000000000000000000000000000008' };
const results = [];
const errors = [];

process.env.PRIVY_APP_ID = 'fixture-privy-app-id';
const server = await createServer({ envFile: false, server: { host: '127.0.0.1', port: 5197, strictPort: true }, plugins: [{ name: 'publish-v1-fixtures', enforce: 'pre', resolveId(source) {
  if (source === 'wagmi') return `${directory}v1-wagmi.mjs`;
  if (source === 'wagmi/actions') return `${directory}wagmi-actions.mjs`;
  if (source.endsWith('/Privy.tsx')) return `${directory}privy.mjs`;
  if (source === '@privy-io/react-auth') return `${directory}privy-react-auth.mjs`;
}, transform(source, id) {
  if (id.endsWith('/src/hireling.ts')) return source.replace(/export const hireling: HirelingContracts \| null =[\s\S]*?(\n\n|\n?$)/, 'export const hireling: HirelingContracts | null = (window as { __hireling?: HirelingContracts | null }).__hireling ?? null$1');
} }] });
await server.listen();
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/home/kristjan/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome' });
mkdirSync(output, { recursive: true });

const now = Math.floor(Date.now() / 1000);
const worker = '0x5555555555555555555555555555555555555555';
const agentWallet = '0x6666666666666666666666666666666666666666';
const offer = (jobId, status) => ({ taskId: `task-${jobId}`, jobId, stack: 'main', title: `v1 job ${jobId}`, brief: 'A v1 hire.', acceptanceCriteria: ['Done'], mode: 'hire', token, reward: '5000000', creatorBond: '0', workerBond: '0', creator, approver: creator, deliveryDeadline: now + 86400, selectionDeadline: null, requiredChecks: [], quoted: false, executionBudget: null, termsHash: `0x${jobId.padStart(64, '0')}`, manifestUrl: `/offers/${jobId}.json`, screening: { verdict: 'clean', reasons: [] }, createdAt: now - 3600, status });
const v1Jobs = { 70: 'open', 71: 'active', 72: 'submitted' };
const silence = encodeFunctionData({ abi: parseAbi(['function completeAfterSilence(uint256 jobId)']), functionName: 'completeAfterSilence', args: [72n] });

async function fixture(viewport, account = creator, options = {}) {
  const context = await browser.newContext({ viewport, hasTouch: viewport.width === 390, isMobile: viewport.width === 390 });
  await context.addInitScript(({ viewer, hireling, defaultArbiter, bounds }) => {
    window.__hireling = hireling;
    window.__v1 = { bounds, arbiter: defaultArbiter, free: 2n * 10n ** 18n, quote: [1000, 500000n, 4500000n], topUp: 0n, bonus: 0n };
    window.__wallet = { address: viewer, connected: true, signatures: [], sends: [] };
    localStorage.setItem('agent-jobs.session', 'fixture-only-not-a-real-session');
    localStorage.setItem('agent-jobs.session-owner', JSON.stringify({ address: viewer, expiresAt: Math.floor(Date.now() / 1000) + 86400 }));
  }, { viewer: account, hireling: contracts, defaultArbiter: arbiter, bounds: options.bounds });
  const state = { created: [] };
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort('blockedbyclient');
    const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/__test/token') return reply({ symbol: 'mUSD', decimals: 6 });
    if (url.pathname === '/__test/receipt') return reply({ status: 'success' });
    const chainJob = (id) => ({ job_id: id, status: v1Jobs[id], mode: 'hire', stack: 'main', board_id: 'public', token, reward: '5000000', creator, approver: creator, worker: v1Jobs[id] === 'open' ? null : agentWallet, agent_id: v1Jobs[id] === 'open' ? null : '7001', delivery_deadline: now + 86400, creator_bond: '0', worker_bond: '0', violation: null, rejection_reason_hash: null });
    if (url.pathname === '/data/jobs') return reply({ ok: true, jobs: Object.keys(v1Jobs).map(chainJob), index: { next_block: 100, updated_at: now } });
    const detail = /^\/data\/jobs\/(\d+)$/.exec(url.pathname)?.[1];
    if (detail !== undefined) return reply({ ok: true, job: chainJob(detail), board: { boardId: 'public', taskId: `task-${detail}` }, rewards: [], bonds: [], evidence: [], timeline: [], ruling: null, feedback: null });
    if (url.pathname === '/data/stats') return reply({ ok: true, jobs: 0, completed: 0, agents: 0, activity: { demo: 0, unclassified: 0, independent: null }, accounting: {} });
    if (url.pathname.startsWith('/data/')) return reply({ ok: true, agents: [], jobs: [], boards: [] });
    if (url.pathname.endsWith('/api/task_index')) return reply({ ok: true, result: Object.keys(v1Jobs).map((id) => offer(id, v1Jobs[id])) });
    if (url.pathname.endsWith('/api/create_task')) {
      state.created.push(route.request().postDataJSON());
      return reply({ ok: true, result: { taskId: 'task-v1', termsHash: `0x${'b'.repeat(64)}`, manifestUrl: '/offers/v1.json', screening: null, transactions: [{ description: 'Approve reward token', chainId: 10143, to: token, data: '0x01', value: '0' }, { description: 'Publish job', chainId: 10143, to: contracts.holding, data: '0x02', value: '0' }] } });
    }
    if (url.pathname.endsWith('/api/get_task')) {
      const { taskId } = route.request().postDataJSON();
      const id = /^task-(\d+)$/.exec(taskId)?.[1];
      if (id === undefined || v1Jobs[id] === undefined) return reply({ ok: true, result: { taskId, jobId: null, creator } });
      const open = v1Jobs[id] === 'open';
      const submitted = v1Jobs[id] === 'submitted';
      return reply({ ok: true, result: { ...offer(id, v1Jobs[id]), you: account === creator ? ['creator', 'approver'] : [], selection: [], terms: { brief: 'A v1 hire.', acceptanceCriteria: ['Done'], windows: { reviewSeconds: 86400, disputeSeconds: 86400, arbitrationSeconds: 172800 } }, chain: { status: v1Jobs[id], provider: open ? null : agentWallet, timely: true, submittedAt: submitted ? now - 90000 : null, reviewEndsAt: submitted ? now - 3600 : null, disputeEndsAt: null, arbitrationEndsAt: null, violation: null, listingMatchesOffer: true, paused: false } } });
    }
    if (url.pathname.endsWith('/api/settlement_actions')) return reply({ ok: true, result: { transactions: [{ description: 'Release the payment', chainId: 10143, to: contracts.evaluator, data: silence, value: '0' }] } });
    if (url.pathname.endsWith('/api/report_transaction')) return reply({ ok: true, result: {} });
    if (url.pathname.includes('/api/')) return reply({ ok: false, message: 'Fixture denies this operation' }, 400);
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  return { context, page, state };
}

async function capture(page, name) {
  const width = await page.evaluate(() => ({ actual: document.documentElement.scrollWidth, expected: innerWidth }));
  assert.ok(width.actual <= width.expected, `${name}: horizontal overflow`);
  await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
}

try {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    const device = viewport.width === 390 ? 'mobile' : 'desktop';
    const { context, page, state } = await fixture(viewport);
    await page.goto(`${base}/publish`);
    await page.locator('#post-title').fill('A v1 direct hire');
    await page.locator('#post-brief').fill('Fix it, with windows and an arbitrator of my choosing.');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    // Two ways to publish; the agent is named.
    assert.equal(await page.getByRole('radio').count(), 2);
    await page.locator('#post-invite').fill('1942');
    await page.getByText('A named agent is invited: you can select it as soon as the job is published. Leave it empty and agents apply.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();

    // Windows: presets, then custom hours checked against the Holding's bounds.
    await page.getByText('review 1 d · dispute 1 d · arbitration 2 d', { exact: true }).first().waitFor();
    await page.getByRole('radio', { name: 'Fast', exact: true }).click();
    await page.getByText('review 1 h · dispute 1 h · arbitration 12 h', { exact: true }).first().waitFor();
    await page.getByRole('radio', { name: 'Custom', exact: true }).last().click();
    await page.locator('#post-arbitrationHours').fill('6');
    await page.getByText('The arbitration window must be between 12 hours and 14 days.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Review', exact: true }).isDisabled(), true);
    await page.locator('#post-reviewHours').fill('36');
    await page.locator('#post-disputeHours').fill('12');
    await page.locator('#post-arbitrationHours').fill('72');

    // Hireling's arbiter by name and address; a custom one gets a warning and cannot be the creator.
    await page.getByText(arbiter, { exact: true }).waitFor();
    await page.getByRole('radio', { name: 'Someone else', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'A custom arbitrator rules on disputes instead of Hireling' }).waitFor();
    await page.locator('#post-arbitrator').fill(creator);
    await page.getByText('You cannot arbitrate your own job: you are its creator and approver.', { exact: true }).waitFor();
    await page.locator('#post-arbitrator').fill(custom);

    // Bonds, reserved from stake.
    await page.locator('#post-creator-bond').fill('5');
    await page.locator('#post-worker-bond').fill('3');
    await capture(page, `${device}-v1-terms`);
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    await page.getByText('review 1 d 12 h · dispute 12 h · arbitration 3 d', { exact: true }).waitFor();
    await page.getByText(`${custom} · yours`, { exact: true }).waitFor();
    await page.getByText('Agent #1942 · invited', { exact: true }).waitFor();
    await page.getByText('5 FACTORY reserved from your stake · at least 3 from the agent\'s', { exact: true }).waitFor();
    await page.getByText(/Stake 3 FACTORY more\./).waitFor();

    await page.getByRole('button', { name: /Confirm step 1 of 2/ }).waitFor();
    assert.equal(state.created.length, 1);
    const args = state.created[0];
    assert.deepEqual({ windows: args.windows, arbitrator: args.arbitrator, invite: args.invite, mode: args.mode, creatorBond: args.creatorBond, workerBond: args.workerBond }, {
      windows: { reviewSeconds: 36 * 3600, disputeSeconds: 12 * 3600, arbitrationSeconds: 72 * 3600 }, arbitrator: custom, invite: { agentId: '1942' }, mode: 'hire', creatorBond: '5', workerBond: '3',
    });
    assert.equal('selectionDeadline' in args, false);
    await page.getByText('Your wallet sends the reward approval and the publish transaction in order; your bond is reserved from your stake.', { exact: false }).waitFor();
    await capture(page, `${device}-v1-review`);
    results.push({ device, checks: ['two modes', 'named agent invited', 'presets', 'custom windows in bounds', 'default arbiter by name', 'custom arbiter warning and not creator', 'bonds from stake', 'free-stake shortfall with Stake link', 'create_task v1 arguments'], passed: true });
    await context.close();
  }
  // CLOCKS-UI: minute clocks and tighter bounds affect both displayed terms and create_task, including reload.
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    const { context, page, state } = await fixture(viewport, creator, { bounds: { review: [120, 600], dispute: [120, 900], arbitration: [300, 1800] } });
    await page.goto(`${base}/publish`);
    await page.locator('#post-title').fill('Minute-clock hire');
    await page.locator('#post-brief').fill('Use this deployment’s window bounds.');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByText('review 10 min · dispute 15 min · arbitration 30 min', { exact: true }).waitFor();
    await page.getByRole('radio', { name: 'Long', exact: true }).click();
    await page.getByText('review 10 min · dispute 15 min · arbitration 30 min', { exact: true }).waitFor();
    await page.getByRole('radio', { name: 'Fast', exact: true }).click();
    await page.getByText('review 2 min · dispute 2 min · arbitration 5 min', { exact: true }).waitFor();
    await page.getByRole('radio', { name: 'Custom', exact: true }).last().click();
    await page.getByText('2 minutes to 10 minutes', { exact: true }).waitFor();
    await page.getByText('5 minutes to 30 minutes', { exact: true }).waitFor();
    await page.locator('#post-reviewHours').fill('0.01');
    await page.getByText('The review window must be between 2 minutes and 10 minutes.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Review', exact: true }).isDisabled(), true);
    await page.getByRole('radio', { name: 'Fast', exact: true }).click();
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    await page.getByRole('button', { name: /Confirm step 1 of 2/ }).waitFor();
    assert.equal(state.created.length, 1);
    assert.deepEqual(state.created[0].windows, { reviewSeconds: 120, disputeSeconds: 120, arbitrationSeconds: 300 });
    await page.reload();
    await page.getByText('review 2 min · dispute 2 min · arbitration 5 min', { exact: true }).waitFor();
    await page.getByRole('button', { name: /Confirm step 1 of 2/ }).waitFor();
    assert.equal(state.created.length, 1);
    assert.equal(await page.evaluate(() => window.__wallet.sends.length), 0);
    await capture(page, `clocks-${viewport.width}-review`);
    results.push({ width: viewport.width, checks: ['Standard/Long clamp to deployment bounds', 'Fast uses minimums', 'minute custom bounds and refusal', 'exact minute create_task arguments', 'frozen windows survive reload without a second prepare'], passed: true });
    await context.close();
  }
  {
    const { context, page, state } = await fixture({ width: 390, height: 844 }, creator, { bounds: null });
    await page.goto(`${base}/publish`);
    await page.locator('#post-title').fill('No clocks');
    await page.locator('#post-brief').fill('The chain does not answer.');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByText('Window limits are unavailable until the chain answers.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Review', exact: true }).isDisabled(), true);
    assert.equal(state.created.length, 0);
    await context.close();
    results.push({ checks: ['unreadable clocks block offer preparation without guessed bounds'], passed: true });
  }
  // The v1 job page: a would-be worker sees its fee and net before activating; anyone tops up an active job.
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    const device = viewport.width === 390 ? 'mobile' : 'desktop';
    const { context, page } = await fixture(viewport, worker);
    await page.goto(`${base}/job/70`);
    await page.getByRole('heading', { name: 'If you take this job' }).waitFor();
    await page.getByText('Hireling’s fee · 10 %', { exact: true }).waitFor();
    await page.getByText('Your rate, set by how much you stake', { exact: true }).waitFor();
    await page.getByText('− 0.5 mUSD', { exact: true }).waitFor();
    await page.getByText('4.5 mUSD', { exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Add to the reward' }).count(), 0);
    await capture(page, `${device}-v1-fee-quote`);
    await page.goto(`${base}/job/71`);
    await page.getByRole('heading', { name: 'Add to the reward' }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'If you take this job' }).count(), 0);
    await page.getByRole('textbox', { name: 'Amount to add' }).fill('2');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    for (const step of [1, 2]) {
      await page.getByRole('button', { name: `Confirm step ${step} of 2` }).click();
      await page.getByRole('button', { name: 'Confirm fixture' }).click();
    }
    await page.getByRole('status').filter({ hasText: 'Added to the reward' }).waitFor();
    await page.getByText('By you', { exact: true }).waitFor();
    assert.equal(await page.getByText('2 mUSD', { exact: true }).count(), 2);
    const sends = await page.evaluate(() => window.__wallet.sends.map((tx) => tx.to.toLowerCase()));
    assert.deepEqual(sends, [token, contracts.holding]);
    await capture(page, `${device}-v1-top-up`);
    // A v1 payout call goes out with its measured gas limit (ADR-0011, D4), not a bare estimate.
    await page.goto(`${base}/job/72`);
    await page.getByRole('button', { name: 'Release the payment', exact: true }).click();
    await page.getByRole('button', { name: 'Release the payment', exact: true }).last().click();
    await page.getByRole('button', { name: 'Confirm in your wallet', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm fixture' }).click();
    await page.getByRole('status').filter({ hasText: 'Settled on-chain' }).waitFor();
    assert.deepEqual(await page.evaluate(() => { const tx = window.__wallet.sends.at(-1); return { to: tx.to.toLowerCase(), gas: String(tx.gas) }; }), { to: contracts.evaluator, gas: '1200000' });
    results.push({ device, checks: ['fee tier and net before activation', 'no top-up before activation', 'top-up approve then topUp', 'bonus shown after', 'v1 completeAfterSilence sent with 1.2M gas'], passed: true });
    await context.close();
  }
  assert.deepEqual(errors, []);
  writeFileSync(`${output}/results.json`, JSON.stringify({ tier: 'mocked Chromium only; no live board, signing or sends', results, errors }, null, 2));
  console.log(`PASS: publish v1, ${results.length} evidence records`);
} finally {
  await browser.close();
  await server.close();
}

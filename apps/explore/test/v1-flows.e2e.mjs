import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { encodeFunctionData, parseAbi } from 'viem';
import { createServer } from 'vite';

// The flow matrix's Explore rows on a v1 deployment that no single page test walks end to end: a direct hire from
// publishing to payment, request → quote → hire, a ruling for the worker with and without the creator's bond burned,
// and the fee an agent sees before activating in each fee tier. Mocked Chromium only: no live board, signing or sends.
const directory = fileURLToPath(new URL('.', import.meta.url));
const output = process.argv[2] ?? '/tmp/hireling-v1-flows-evidence';
const base = 'http://127.0.0.1:5201';
const creator = '0x1111111111111111111111111111111111111111';
const agentWallet = '0x6666666666666666666666666666666666666666';
const arbiter = '0xa000000000000000000000000000000000000001';
const config = JSON.parse(readFileSync(new URL('../../../contracts/config/monad-testnet.json', import.meta.url), 'utf8'));
const token = config.deployment.rewardTokens[0].toLowerCase();
const contracts = { factory: '0xf000000000000000000000000000000000000001', vault: '0xf000000000000000000000000000000000000002', feeSchedule: '0xf000000000000000000000000000000000000003', distributor: '0xf000000000000000000000000000000000000004', miningReserve: '0xf000000000000000000000000000000000000005', holding: '0xf000000000000000000000000000000000000006', evaluator: '0xf000000000000000000000000000000000000007', safe: '0xf000000000000000000000000000000000000008' };
const now = Math.floor(Date.now() / 1000);
const accept = (jobId) => encodeFunctionData({ abi: parseAbi(['function accept(uint256 jobId)']), functionName: 'accept', args: [BigInt(jobId)] });
const tx = (description, to, data) => ({ description, chainId: 10143, to, data, value: '0' });
const publishTxs = [tx('Approve reward token', token, '0x01'), tx('Publish job', contracts.holding, '0x02')];
const results = [];
const errors = [];

process.env.PRIVY_APP_ID = 'fixture-privy-app-id';
const server = await createServer({ envFile: false, server: { host: '127.0.0.1', port: 5201, strictPort: true }, plugins: [{ name: 'v1-flows-fixtures', enforce: 'pre', resolveId(source) {
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

/**
 * One board and chain, in `state`: jobs by id (chain status and, once ruled, the ruling), the offers they came from,
 * the quote request and its quotes. Tests move a job along by editing its status, as the agent and the chain would.
 */
async function fixture(viewport, account = creator) {
  const context = await browser.newContext({ viewport, hasTouch: viewport.width === 390, isMobile: viewport.width === 390 });
  await context.addInitScript(({ viewer, hireling, defaultArbiter }) => {
    window.__hireling = hireling;
    window.__v1 = { arbiter: defaultArbiter, free: 10n ** 22n, quote: [1000, 500000n, 4500000n], topUp: 0n, bonus: 0n };
    window.__wallet = { address: viewer, connected: true, signatures: [], sends: [] };
    localStorage.setItem('agent-jobs.session', 'fixture-only-not-a-real-session');
    localStorage.setItem('agent-jobs.session-owner', JSON.stringify({ address: viewer, expiresAt: Math.floor(Date.now() / 1000) + 86400 }));
  }, { viewer: account, hireling: contracts, defaultArbiter: arbiter });
  const state = {
    jobs: {
      95: { status: 'completed', violation: 'Quality', ruling: { for_worker: 1, slash_loser: 1, tx_hash: `0x${'95'.repeat(32)}` } },
      96: { status: 'completed', violation: 'None', ruling: { for_worker: 1, slash_loser: 0, tx_hash: `0x${'96'.repeat(32)}` } },
      98: { status: 'open' },
    },
    tasks: { 'task-95': '95', 'task-96': '96', 'task-98': '98' },
    created: [], requested: [], picked: [], request: null, calls: [],
    // The job a publish creates, listed when its publish transaction (the second send) is mined: before that the
    // offer has no job, as on the chain.
    publishing: null, receipts: 0,
  };
  const offer = (jobId) => ({ taskId: `task-${jobId}`, jobId, stack: 'main', title: `v1 job ${jobId}`, brief: 'A v1 hire.', acceptanceCriteria: ['Done'], mode: 'hire', token, reward: '5000000', creatorBond: '0', workerBond: '0', creator, approver: creator, deliveryDeadline: now + 86400, selectionDeadline: null, requiredChecks: [], quoted: false, executionBudget: null, termsHash: `0x${jobId.padStart(64, '0')}`, manifestUrl: `/offers/${jobId}.json`, screening: { verdict: 'clean', reasons: [] }, createdAt: now - 3600, status: state.jobs[jobId].status });
  const chainJob = (id) => {
    const j = state.jobs[id];
    const started = j.status !== 'open';
    return { job_id: id, status: j.status, mode: 'hire', stack: 'main', board_id: 'public', token, reward: '5000000', creator, approver: creator, worker: started ? agentWallet : null, agent_id: started ? '7001' : null, delivery_deadline: now + 86400, creator_bond: '0', worker_bond: '0', violation: j.violation ?? null, rejection_reason_hash: j.violation === undefined ? null : `0x${'ee'.repeat(32)}` };
  };
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort('blockedbyclient');
    const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const body = () => route.request().postDataJSON();
    if (url.pathname === '/__test/token') return reply({ symbol: 'mUSD', decimals: 6 });
    if (url.pathname === '/__test/receipt') {
      state.receipts += 1;
      if (state.receipts === 2 && state.publishing !== null) {
        state.tasks[state.publishing.taskId] = state.publishing.jobId;
        state.jobs[state.publishing.jobId] = { status: 'open' };
      }
      return reply({ status: 'success' });
    }
    if (url.pathname === '/data/jobs') return reply({ ok: true, jobs: Object.keys(state.jobs).map(chainJob), index: { next_block: 100, updated_at: now } });
    const detail = /^\/data\/jobs\/(\d+)$/.exec(url.pathname)?.[1];
    if (detail !== undefined) {
      if (state.jobs[detail] === undefined) return reply({ ok: false, code: 'not-found', message: 'No such job' }, 404);
      return reply({ ok: true, job: chainJob(detail), board: { boardId: 'public', taskId: `task-${detail}` }, rewards: [], bonds: [], evidence: [], timeline: [], ruling: state.jobs[detail].ruling ?? null, feedback: null });
    }
    if (url.pathname === '/data/stats') return reply({ ok: true, jobs: 0, completed: 0, agents: 0, activity: { demo: 0, unclassified: 0, independent: null }, accounting: {} });
    if (url.pathname.startsWith('/data/')) return reply({ ok: true, agents: [], jobs: [], boards: [] });
    if (!url.pathname.includes('/api/')) return route.continue();
    const name = url.pathname.replace(/^.*\/api\//, '');
    state.calls.push(name);
    switch (name) {
      case 'task_index': return reply({ ok: true, result: Object.keys(state.jobs).map(offer) });
      case 'get_task': {
        const { taskId } = body();
        const id = state.tasks[taskId];
        if (id === undefined) return reply({ ok: true, result: { taskId, jobId: null, creator } });
        const j = state.jobs[id];
        const you = account === creator ? ['creator', 'approver'] : account === agentWallet && j.status !== 'open' ? ['worker'] : [];
        return reply({ ok: true, result: { ...offer(id), you, selection: [], terms: { brief: 'A v1 hire.', acceptanceCriteria: ['Done'], windows: { reviewSeconds: 86400, disputeSeconds: 86400, arbitrationSeconds: 172800 } }, chain: { status: j.status, provider: j.status === 'open' ? null : agentWallet, timely: true, submittedAt: j.status === 'submitted' ? now - 600 : null, reviewEndsAt: j.status === 'submitted' ? now + 3600 : null, disputeEndsAt: null, arbitrationEndsAt: null, violation: j.violation ?? null, listingMatchesOffer: true, paused: false } } });
      }
      case 'create_task':
        state.created.push(body());
        return reply({ ok: true, result: { taskId: 'task-99', termsHash: `0x${'9'.repeat(64)}`, manifestUrl: '/offers/99.json', screening: null, transactions: publishTxs } });
      case 'request_quotes': {
        state.requested.push(body());
        const a = body();
        state.request = { requestId: 'rq-1', requestHash: `0x${'1'.repeat(64)}`, status: 'open', creator, title: a.title, brief: a.brief, acceptanceCriteria: a.acceptanceCriteria, tokens: a.tokens, creatorBond: a.creatorBond, workerBond: a.workerBond, deliveryDeadline: a.deliveryDeadline, quoteDeadline: a.quoteDeadline, stack: a.stack };
        return reply({ ok: true, result: { requestId: 'rq-1' } });
      }
      case 'list_quote_requests': return reply({ ok: true, result: state.request === null ? [] : [state.request] });
      case 'list_quotes': return reply({ ok: true, result: { picked: state.picked.length > 0 ? 'task-97' : null, quotes: [
        { quoteId: 'q-1', worker: agentWallet, agentId: '7001', token, symbol: 'mUSD', amount: '4', note: 'Two days, with tests.', expectedCosts: null, quoteHash: `0x${'a'.repeat(64)}` },
        { quoteId: 'q-2', worker: '0x7777777777777777777777777777777777777777', agentId: '7002', token, symbol: 'mUSD', amount: '6', note: '', expectedCosts: null, quoteHash: `0x${'b'.repeat(64)}` },
      ] } });
      case 'pick_quote':
        state.picked.push(body());
        return reply({ ok: true, result: { taskId: 'task-97', termsHash: `0x${'7'.repeat(64)}`, screening: null, transactions: publishTxs } });
      case 'approve_work': {
        const id = state.tasks[body().taskId];
        return reply({ ok: true, result: { transactions: [tx('Approve and pay', contracts.evaluator, accept(id))] } });
      }
      case 'get_dispute_bundle': return reply({ ok: true, result: { bundle: { rejection: { reasonText: 'Does not load on a phone.' }, statements: [{ role: 'worker', text: 'It loads; an old build was tested.' }] } } });
      case 'report_transaction': case 'report_event': case 'list_applications': return reply({ ok: true, result: name === 'list_applications' ? [] : {} });
      default: return reply({ ok: false, message: 'Fixture denies this operation' }, 400);
    }
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
const steps = async (page, n) => {
  for (let step = 1; step <= n; step++) {
    await page.getByRole('button', { name: `Confirm step ${step} of ${n}` }).click();
    await page.getByRole('button', { name: 'Confirm fixture' }).click();
  }
};
const sends = (page) => page.evaluate(() => window.__wallet.sends.map((t) => ({ to: t.to.toLowerCase(), gas: t.gas === undefined ? null : String(t.gas) })));
const refetch = (page) => page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));

try {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    const device = viewport.width === 390 ? 'mobile' : 'desktop';

    // Direct hire, publish to payment: name the agent, publish (approve + publish on the v1 Holding), the agent starts
    // and delivers, the creator approves with Evaluator.accept at its 1.2M limit.
    {
      const { context, page, state } = await fixture(viewport);
      await page.goto(`${base}/publish`);
      await page.locator('#post-title').fill('Fix the checkout');
      await page.locator('#post-brief').fill('The checkout fails on mobile Safari.');
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page.locator('#post-invite').fill('7001');
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page.locator('#post-reward').fill('5');
      await page.getByRole('button', { name: 'Review', exact: true }).click();
      await page.getByText('Agent #7001 · invited', { exact: true }).waitFor();
      assert.deepEqual(state.created.map((a) => ({ mode: a.mode, invite: a.invite, reward: a.reward })), [{ mode: 'hire', invite: { agentId: '7001' }, reward: '5' }]);
      state.publishing = { taskId: 'task-99', jobId: '99' };
      await steps(page, 2);
      await page.waitForURL('**/job/99');
      await page.getByRole('status').filter({ hasText: /Published/ }).waitFor();
      assert.deepEqual(await sends(page), [{ to: token, gas: null }, { to: contracts.holding, gas: null }]);

      // The agent activates and delivers (on-chain, from its own wallet); the page follows the chain.
      state.jobs[99].status = 'submitted';
      await page.reload();
      await page.getByRole('button', { name: /^Approve and pay/ }).first().click();
      await page.getByRole('dialog', { name: 'Approve and pay?' }).getByRole('button', { name: 'Approve and pay', exact: true }).click();
      state.jobs[99].status = 'completed';
      await page.getByRole('button', { name: 'Confirm in your wallet', exact: true }).click();
      await page.getByRole('button', { name: 'Confirm fixture' }).click();
      await page.getByRole('status').filter({ hasText: 'Paid 5 mUSD to Agent #7001' }).waitFor();
      assert.deepEqual((await sends(page)).at(-1), { to: contracts.evaluator, gas: '1200000' });
      await capture(page, `${device}-direct-hire-paid`);
      results.push({ device, flow: 'direct hire, publish to payment', checks: ['named agent', 'create_task invite', 'approve + publish', 'lands on the job page', 'agent delivers', 'approve via Evaluator.accept 1.2M gas', 'paid toast'], note: 'activation is the agent’s own transaction over MCP; the creator’s sponsored actions are in v1-job.e2e', passed: true });
      await context.close();
    }

    // Request → quote → hire: ask for quotes (nothing locked), compare, pick the lowest, publish it, land on the job.
    {
      const { context, page, state } = await fixture(viewport);
      await page.goto(`${base}/publish`);
      await page.locator('#post-title').fill('Translate the docs');
      await page.locator('#post-brief').fill('Translate the user guide into German.');
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page.getByRole('radio', { name: /Request quotes/ }).click();
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page.getByRole('button', { name: 'Review', exact: true }).click();
      await page.getByRole('button', { name: 'Ask for quotes', exact: true }).click();
      await page.waitForURL('**/quotes/rq-1');
      assert.equal(state.requested.length, 1);
      assert.equal(state.requested[0].stack, 'main');
      assert.equal(state.created.length, 0);
      assert.equal((await sends(page)).length, 0);
      await page.getByText('Lowest', { exact: true }).filter({ visible: true }).first().waitFor();
      await capture(page, `${device}-quotes`);
      const pick = viewport.width === 390 ? page.getByRole('button', { name: 'Pick', exact: true }).first() : page.getByRole('button', { name: 'Pick this quote', exact: true }).first();
      await pick.click();
      await page.getByRole('dialog', { name: "Pick Agent #7001's quote?" }).getByRole('button', { name: 'Pick this quote', exact: true }).click();
      assert.deepEqual(state.picked, [{ requestId: 'rq-1', quoteId: 'q-1' }]);
      state.publishing = { taskId: 'task-97', jobId: '97' };
      await steps(page, 2);
      await page.waitForURL('**/job/97');
      await page.getByRole('status').filter({ hasText: 'Published · 4 mUSD locked in escrow' }).waitFor();
      assert.deepEqual(await sends(page), [{ to: token, gas: null }, { to: contracts.holding, gas: null }]);
      results.push({ device, flow: 'request → quote → hire', checks: ['request_quotes on the v1 stack, nothing sent', 'quotes compared, lowest marked', 'pick_quote with the picked quote', 'approve + publish', 'lands on the job with the quoted price'], passed: true });
      await context.close();
    }

    // A ruling for the worker, with and without the creator's bond burned, as a party reads it.
    {
      const { context, page } = await fixture(viewport, agentWallet);
      await page.goto(`${base}/job/95`);
      await page.getByText('For the agent', { exact: true }).waitFor();
      await page.getByText('Creator’s bond burned', { exact: true }).waitFor();
      await page.getByText('Does not load on a phone.', { exact: true }).waitFor();
      await capture(page, `${device}-ruling-slash`);
      await page.goto(`${base}/job/96`);
      await page.getByText('For the agent', { exact: true }).waitFor();
      assert.equal(await page.getByText('Creator’s bond burned', { exact: true }).count(), 0);
      results.push({ device, flow: 'ruling for the worker', checks: ['for the agent', 'creator’s bond burned when slashed', 'no burn badge without slash', 'reason and statement to a party'], passed: true });
      await context.close();
    }
  }

  // The fee an agent sees before activating, in each tier of the default schedule (30, 10, 3, 1 %), as quoteActivation
  // returns it: fee and net exactly as the chain says (D11), no client-side rounding.
  {
    const { context, page } = await fixture({ width: 390, height: 844 }, agentWallet);
    await page.goto(`${base}/job/98`);
    for (const [bps, fee, net, pct] of [[3000, 1500000n, 3500000n, '30 %'], [1000, 500000n, 4500000n, '10 %'], [300, 150000n, 4850000n, '3 %'], [100, 50000n, 4950000n, '1 %']]) {
      await page.evaluate((q) => { window.__v1.quote = [q[0], BigInt(q[1]), BigInt(q[2])]; }, [bps, String(fee), String(net)]);
      await refetch(page);
      await page.getByText(`Hireling’s fee · ${pct}`, { exact: true }).waitFor();
      await page.getByText(`− ${Number(fee) / 1e6} mUSD`, { exact: true }).waitFor();
      await page.getByText(`${Number(net) / 1e6} mUSD`, { exact: true }).first().waitFor();
    }
    results.push({ flow: 'each fee tier', checks: ['30 %', '10 %', '3 %', '1 %', 'fee and net as quoteActivation returns them'], passed: true });
    await context.close();
  }
  assert.deepEqual(errors, []);
  writeFileSync(`${output}/results.json`, JSON.stringify({ tier: 'mocked Chromium only; no live board, signing or sends', results, errors }, null, 2));
  console.log(`PASS: v1 flows, ${results.length} evidence records`);
} finally {
  await browser.close();
  await server.close();
}

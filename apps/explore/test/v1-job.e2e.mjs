import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { encodeFunctionData, keccak256, parseAbi, toHex } from 'viem';
import { createServer } from 'vite';

// The v1 job page's own calls (flow matrix E column): cancel before activation, approve, reject, then the worker's
// dispute. Each goes to the v1 Holding or Evaluator; cancel and accept carry their ADR-0011 gas limits, reject and
// dispute (unfloored) go with the wallet's estimate. Mocked Chromium only: no live board, signing or sends.
const directory = fileURLToPath(new URL('.', import.meta.url));
const output = process.argv[2] ?? '/tmp/hireling-v1-job-evidence';
const base = 'http://127.0.0.1:5200';
const creator = '0x1111111111111111111111111111111111111111';
const agentWallet = '0x6666666666666666666666666666666666666666';
const config = JSON.parse(readFileSync(new URL('../../../contracts/config/monad-testnet.json', import.meta.url), 'utf8'));
const token = config.deployment.rewardTokens[0].toLowerCase();
const contracts = { factory: '0xf000000000000000000000000000000000000001', vault: '0xf000000000000000000000000000000000000002', feeSchedule: '0xf000000000000000000000000000000000000003', distributor: '0xf000000000000000000000000000000000000004', miningReserve: '0xf000000000000000000000000000000000000005', holding: '0xf000000000000000000000000000000000000006', evaluator: '0xf000000000000000000000000000000000000007', safe: '0xf000000000000000000000000000000000000008' };
const now = Math.floor(Date.now() / 1000);
const holdingAbi = parseAbi(['function cancel(uint256 jobId)']);
const evaluatorAbi = parseAbi(['function accept(uint256 jobId)', 'function reject(uint256 jobId, uint8 violation, bytes32 reasonHash)', 'function dispute(uint256 jobId)']);
const jobs = { 80: 'open', 81: 'submitted', 82: 'submitted', 83: 'rejected-pending' };
const tx = (description, to, data) => ({ description, chainId: 10143, to, data, value: '0' });
const offer = (jobId, status) => ({ taskId: `task-${jobId}`, jobId, stack: 'main', title: `v1 job ${jobId}`, brief: 'A v1 hire.', acceptanceCriteria: ['Done'], mode: 'hire', token, reward: '5000000', creatorBond: '0', workerBond: '0', creator, approver: creator, deliveryDeadline: now + 86400, selectionDeadline: null, requiredChecks: [], quoted: false, executionBudget: null, termsHash: `0x${jobId.padStart(64, '0')}`, manifestUrl: `/offers/${jobId}.json`, screening: { verdict: 'clean', reasons: [] }, createdAt: now - 3600, status });
const results = [];
const errors = [];

process.env.PRIVY_APP_ID = 'fixture-privy-app-id';
const server = await createServer({ envFile: false, server: { host: '127.0.0.1', port: 5200, strictPort: true }, plugins: [{ name: 'v1-job-fixtures', enforce: 'pre', resolveId(source) {
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

async function fixture(viewport, account) {
  const context = await browser.newContext({ viewport, hasTouch: viewport.width === 390, isMobile: viewport.width === 390 });
  await context.addInitScript(({ viewer, hireling }) => {
    window.__hireling = hireling;
    window.__v1 = { arbiter: '0xa000000000000000000000000000000000000001', free: 10n ** 21n, quote: [1000, 500000n, 4500000n], topUp: 0n, bonus: 0n };
    window.__wallet = { address: viewer, connected: true, signatures: [], sends: [] };
    localStorage.setItem('agent-jobs.session', 'fixture-only-not-a-real-session');
    localStorage.setItem('agent-jobs.session-owner', JSON.stringify({ address: viewer, expiresAt: Math.floor(Date.now() / 1000) + 86400 }));
  }, { viewer: account, hireling: contracts });
  const state = { calls: [] };
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort('blockedbyclient');
    const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const body = () => route.request().postDataJSON();
    if (url.pathname === '/__test/token') return reply({ symbol: 'mUSD', decimals: 6 });
    if (url.pathname === '/__test/receipt') return reply({ status: 'success' });
    const chainJob = (id) => ({ job_id: id, status: jobs[id], mode: 'hire', stack: 'main', board_id: 'public', token, reward: '5000000', creator, approver: creator, worker: jobs[id] === 'open' ? null : agentWallet, agent_id: jobs[id] === 'open' ? null : '7001', delivery_deadline: now + 86400, creator_bond: '0', worker_bond: '0', violation: jobs[id] === 'rejected-pending' ? 'Quality' : null, rejection_reason_hash: null });
    if (url.pathname === '/data/jobs') return reply({ ok: true, jobs: Object.keys(jobs).map(chainJob), index: { next_block: 100, updated_at: now } });
    const detail = /^\/data\/jobs\/(\d+)$/.exec(url.pathname)?.[1];
    if (detail !== undefined) return reply({ ok: true, job: chainJob(detail), board: { boardId: 'public', taskId: `task-${detail}` }, rewards: [], bonds: [], evidence: [], timeline: [], ruling: null, feedback: null });
    if (url.pathname.startsWith('/data/')) return reply({ ok: true, agents: [], jobs: [], boards: [] });
    if (!url.pathname.includes('/api/')) return route.continue();
    const name = url.pathname.replace(/^.*\/api\//, '');
    if (name === 'task_index') return reply({ ok: true, result: Object.keys(jobs).map((id) => offer(id, jobs[id])) });
    if (name === 'get_task') {
      const id = /^task-(\d+)$/.exec(body().taskId)?.[1];
      const status = jobs[id];
      const you = account === creator ? ['creator', 'approver'] : account === agentWallet && status !== 'open' ? ['worker'] : [];
      return reply({ ok: true, result: { ...offer(id, status), you, selection: [], terms: { brief: 'A v1 hire.', acceptanceCriteria: ['Done'], windows: { reviewSeconds: 86400, disputeSeconds: 86400, arbitrationSeconds: 172800 } }, chain: { status, provider: status === 'open' ? null : agentWallet, timely: true, submittedAt: status === 'submitted' ? now - 600 : null, reviewEndsAt: status === 'submitted' ? now + 3600 : null, disputeEndsAt: status === 'rejected-pending' ? now + 3600 : null, arbitrationEndsAt: null, violation: status === 'rejected-pending' ? 'Quality' : null, listingMatchesOffer: true, paused: false } } });
    }
    const jobId = BigInt(/^task-(\d+)$/.exec(body()?.taskId ?? '')?.[1] ?? '0');
    if (['cancel_task', 'approve_work', 'reject_work', 'dispute'].includes(name)) state.calls.push({ name, args: body() });
    if (name === 'cancel_task') return reply({ ok: true, result: { transactions: [tx('Cancel the job', contracts.holding, encodeFunctionData({ abi: holdingAbi, functionName: 'cancel', args: [jobId] }))] } });
    if (name === 'approve_work') return reply({ ok: true, result: { transactions: [tx('Approve and pay', contracts.evaluator, encodeFunctionData({ abi: evaluatorAbi, functionName: 'accept', args: [jobId] }))] } });
    if (name === 'reject_work') return reply({ ok: true, result: { transactions: [tx('Reject', contracts.evaluator, encodeFunctionData({ abi: evaluatorAbi, functionName: 'reject', args: [jobId, 1, keccak256(toHex(body().reason))] }))] } });
    if (name === 'dispute') return reply({ ok: true, result: { transactions: [tx('Dispute the rejection', contracts.evaluator, encodeFunctionData({ abi: evaluatorAbi, functionName: 'dispute', args: [jobId] }))] } });
    if (name === 'report_transaction' || name === 'report_event') return reply({ ok: true, result: {} });
    return reply({ ok: false, message: 'Fixture denies this operation' }, 400);
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
const lastSend = (page) => page.evaluate(() => { const t = window.__wallet.sends.at(-1); return { to: t.to.toLowerCase(), gas: t.gas === undefined ? null : String(t.gas) }; });
async function send(page, done) {
  await page.getByRole('button', { name: 'Confirm in your wallet', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm fixture' }).click();
  await page.getByRole('status').filter({ hasText: done }).waitFor();
}

try {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    const device = viewport.width === 390 ? 'mobile' : 'desktop';
    {
      const { context, page, state } = await fixture(viewport, creator);
      // Cancel before activation: Holding.cancel with its 700k limit.
      await page.goto(`${base}/job/80`);
      await page.getByRole('button', { name: 'Cancel the job', exact: true }).click();
      await page.getByRole('dialog', { name: 'Cancel this job?' }).getByRole('button', { name: 'Cancel the job', exact: true }).click();
      await send(page, 'Cancelled.');
      assert.deepEqual(await lastSend(page), { to: contracts.holding, gas: '700000' });

      // Approve inside the review window: Evaluator.accept with its 1.2M limit.
      await page.goto(`${base}/job/81`);
      await page.getByRole('button', { name: /^Approve and pay/ }).first().click();
      await capture(page, `${device}-v1-approve`);
      await page.getByRole('dialog', { name: 'Approve and pay?' }).getByRole('button', { name: 'Approve and pay', exact: true }).click();
      await send(page, 'Paid 5 mUSD');
      assert.deepEqual(await lastSend(page), { to: contracts.evaluator, gas: '1200000' });

      // Reject for a named fault: unfloored, so the wallet estimates.
      await page.goto(`${base}/job/82`);
      await page.getByRole('button', { name: 'Reject', exact: true }).first().click();
      const sheet = page.getByRole('dialog', { name: 'Reject this work?' });
      await sheet.getByRole('radio', { name: 'Not good enough' }).click();
      await sheet.getByRole('textbox').fill('The page does not load on a phone.');
      await sheet.getByRole('button', { name: 'Reject', exact: true }).click();
      await send(page, 'Rejected.');
      assert.deepEqual(await lastSend(page), { to: contracts.evaluator, gas: null });
      assert.deepEqual(state.calls.map((c) => c.name), ['cancel_task', 'approve_work', 'reject_work']);
      assert.deepEqual(state.calls[2].args, { taskId: 'task-82', violation: 'Quality', reason: 'The page does not load on a phone.' });
      await context.close();
    }
    {
      // The worker disputes the rejection inside the dispute window: unfloored too.
      const { context, page, state } = await fixture(viewport, agentWallet);
      await page.goto(`${base}/job/83`);
      await page.getByRole('button', { name: 'Dispute the rejection', exact: true }).click();
      const sheet = page.getByRole('dialog', { name: 'Dispute the rejection?' });
      await sheet.getByRole('textbox').fill('It loads; the creator tested an old build.');
      await capture(page, `${device}-v1-dispute`);
      await sheet.getByRole('button', { name: 'Dispute', exact: true }).click();
      await send(page, 'Disputed.');
      assert.deepEqual(await lastSend(page), { to: contracts.evaluator, gas: null });
      assert.deepEqual(state.calls, [{ name: 'dispute', args: { taskId: 'task-83', statement: 'It loads; the creator tested an old build.' } }]);
      await context.close();
    }
    results.push({ device, checks: ['cancel before activation: Holding.cancel 700k gas', 'approve: Evaluator.accept 1.2M gas', 'reject with violation and reason, wallet estimate', 'worker dispute with statement, wallet estimate'], passed: true });
  }
  assert.deepEqual(errors, []);
  writeFileSync(`${output}/results.json`, JSON.stringify({ tier: 'mocked Chromium only; no live board, signing or sends', results, errors }, null, 2));
  console.log(`PASS: v1 job, ${results.length} evidence records`);
} finally {
  await browser.close();
  await server.close();
}

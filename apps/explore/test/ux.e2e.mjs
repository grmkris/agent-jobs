import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import playwright from 'playwright-core';
import { createServer } from 'vite';

const directory = fileURLToPath(new URL('.', import.meta.url));
const output = process.argv[2] ?? '/tmp/hireling-ux-evidence';
const base = 'http://127.0.0.1:5190';
const creator = '0x1111111111111111111111111111111111111111';
const token = '0x2222222222222222222222222222222222222222';
const transactions = ['Approve reward token', 'Approve FACTORY bond', 'Publish job'].map((description, index) => ({ description, chainId: 10143, to: token, data: `0x0${index}`, value: '0' }));
const now = Math.floor(Date.now() / 1000);
const offer = { taskId: 'fixture-offer', jobId: null, title: 'Wallet fixture job', creator, approver: creator, mode: 'hire', stack: 'main', token, reward: '5000000', creatorBond: '0', workerBond: '0', deliveryDeadline: now + 86400, selectionDeadline: null, termsHash: '0xabcdef', manifestUrl: '/offers/fixture.json', terms: { brief: `Long URL https://example.test/${'long-segment'.repeat(60)}`, acceptanceCriteria: [`Long criterion ${'unbroken'.repeat(60)}`], evidencePolicy: { checks: [] }, windows: { reviewSeconds: 3600, disputeSeconds: 3600, arbitrationSeconds: 3600 } }, deliverable: { accepts: ['url'] }, screening: { verdict: 'ok', reasons: [] }, executionBudget: null, requiredChecks: [], brief: `https://example.test/${'segment'.repeat(100)}`, acceptanceCriteria: ['Readable on a phone'], status: 'completed' };
const server = await createServer({ envFile: false, server: { host: '127.0.0.1', port: 5190, strictPort: true }, plugins: [{ name: 'ux-wallet-fixtures', enforce: 'pre', resolveId(source) {
  if (source === 'wagmi') return `${directory}wagmi.mjs`;
  if (source === 'wagmi/actions') return `${directory}wagmi-actions.mjs`;
  if (source.endsWith('/Privy.tsx')) return `${directory}privy.mjs`;
} }] });
await server.listen();
const browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/home/kristjan/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome' });
const results = [];
const failures = [];

async function fixture(viewport, options = {}) {
  const context = await browser.newContext({ viewport, hasTouch: viewport.width === 390, isMobile: viewport.width === 390, colorScheme: options.dark ? 'dark' : 'light' });
  await context.addInitScript(({ creator, batch }) => {
    window.__wallet = { sends: [], connected: true, batch };
    localStorage.setItem('agent-jobs.session', 'fixture-only-not-a-real-session');
    localStorage.setItem('agent-jobs.session-owner', JSON.stringify({ address: creator, expiresAt: Math.floor(Date.now() / 1000) + 86400 }));
  }, { creator, batch: options.batch ?? false });
  const state = { chainError: false, receiptError: false, reportError: false, reports: 0, published: false, tokenError: false, tokenDelay: 0 };
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort('blockedbyclient');
    const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/__test/token') {
      if (state.tokenDelay) await new Promise((resolve) => setTimeout(resolve, state.tokenDelay));
      return reply({ symbol: 'OPEN', decimals: 6 }, state.tokenError ? 503 : 200);
    }
    if (url.pathname === '/__test/receipt') return reply({ status: 'success' }, state.receiptError ? 503 : 200);
    if (url.pathname.endsWith('/api/task_index')) return reply({ ok: true, result: [{ ...offer, jobId: '60' }] });
    if (url.pathname.endsWith('/api/get_task')) return reply({ ok: true, result: { ...offer, jobId: state.published ? '61' : null } });
    if (url.pathname.endsWith('/api/publish_transactions')) return reply({ ok: true, result: { transactions } });
    if (url.pathname.endsWith('/api/create_task')) return reply({ ok: true, result: { ...offer, transactions } });
    if (url.pathname.endsWith('/api/report_transaction')) {
      if (state.reportError) return reply({ ok: false, message: 'Fixture board unavailable' }, 503);
      state.reports++;
      if (state.reports === (options.batch ? 1 : 3)) state.published = true;
      return reply({ ok: true, result: {} });
    }
    if (url.pathname.endsWith('/api/list_quote_requests')) return reply({ ok: true, result: [] });
    if (url.pathname.includes('/api/')) return reply({ ok: false, message: 'Fixture denies this operation' }, 400);
    if (url.pathname === '/data/jobs') return reply({ jobs: state.chainError ? [] : [{ job_id: '60', status: 'completed', mode: 'hire', board_id: 'public', token, reward: '5000000', creator, approver: creator, worker: creator, agent_id: '1', delivery_deadline: now + 86400, creator_bond: '0', worker_bond: '0' }], index: { next_block: 100, updated_at: now } }, state.chainError ? 503 : 200);
    if (url.pathname === '/data/boards') return reply({ boards: [] });
    if (url.pathname === '/data/stats') return reply({ jobs: 1, completed: 1, agents: 1, paidOut: { [token]: '5000000' }, inEscrow: {} });
    if (url.pathname.startsWith('/data/job/')) return reply({ job: { job_id: '60', status: 'completed', mode: 'hire', token, reward: '5000000', creator, approver: creator, worker: creator, agent_id: '1', violation: null }, rewards: [{ amount: '5000000', to_worker: 1 }], evidence: [], timeline: [], ruling: null, board: null });
    if (url.pathname.startsWith('/data/')) return reply({ agents: [], jobs: [] });
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => failures.push(error.message));
  return { context, page, state };
}

async function snap(page, device, name) {
  mkdirSync(`${output}/${device}`, { recursive: true });
  await page.screenshot({ path: `${output}/${device}/${name}.png`, fullPage: true });
  results.push({ device, name, ...await page.evaluate(() => ({ width: innerWidth, clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, dialogs: document.querySelectorAll('dialog[open]').length, text: document.body.innerText })) });
}

async function testPublish(viewport, batch = false) {
  const { context, page, state } = await fixture(viewport, { batch });
  const device = viewport.width === 390 ? 'mobile' : 'desktop';
  await page.goto(`${base}/publish?resume=fixture-offer`);
  await page.getByRole('button', { name: 'Prepare wallet steps' }).click();
  const confirm = () => page.getByRole('button', { name: batch ? /Confirm all 3/ : /Confirm step/ });
  await confirm().waitFor();
  assert.equal(await page.locator('dialog[open]').count(), 0);
  assert.equal(await page.getByText('Waiting', { exact: true }).count(), batch ? 0 : 3);
  await snap(page, device, `publish-inline${batch ? '-batch' : ''}`);
  await confirm().click();
  await page.getByRole('dialog', { name: 'Wallet confirmation fixture' }).waitFor();
  assert.equal(await page.locator('dialog[open]').count(), 0);
  await snap(page, device, `wallet-visible${batch ? '-batch' : ''}`);
  await page.getByRole('button', { name: 'Decline fixture' }).click();
  await page.getByRole('button', { name: 'Try again' }).waitFor();
  assert.equal(await page.evaluate(() => window.__wallet.sends.length), 0);
  await page.getByRole('button', { name: 'Try again' }).click();
  state.receiptError = true;
  await page.getByRole('button', { name: 'Confirm fixture' }).click();
  await page.getByRole('button', { name: 'Try again' }).waitFor();
  assert.equal(await page.evaluate(() => window.__wallet.sends.length), 1);
  state.receiptError = false;
  state.reportError = true;
  await page.getByRole('button', { name: 'Try again' }).click();
  await page.getByRole('button', { name: 'Record it again' }).waitFor();
  assert.equal(await page.evaluate(() => window.__wallet.sends.length), 1);
  await snap(page, device, 'confirmed-board-retry');
  state.reportError = false;
  await page.getByRole('button', { name: 'Record it again' }).click();
  if (!batch) {
    await page.getByRole('button', { name: 'Confirm step 2 of 3' }).waitFor();
    await page.reload();
    await page.getByRole('button', { name: 'Prepare wallet steps' }).click();
    await page.getByRole('button', { name: 'Confirm step 2 of 3' }).waitFor();
    assert.equal(state.reports, 1);
    for (const step of [2, 3]) {
      await page.getByRole('button', { name: `Confirm step ${step} of 3` }).click();
      await page.getByRole('button', { name: 'Confirm fixture' }).click();
    }
  }
  await page.waitForURL('**/job/61');
  assert.equal(state.reports, batch ? 1 : 3);
  results.push({ device, name: 'publish-regressions', batch, checks: ['no native publish overlay', 'wallet operable', 'decline retry', 'receipt retry no send', 'board report retry no send', 'reload no duplicate approval', 'ordered publish'] });
  await context.close();
}

try {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) await testPublish(viewport);
  await testPublish({ width: 390, height: 844 }, true);
  assert.deepEqual(failures, []);
  console.log(`PASS: ${results.length} publish browser evidence records`);
} finally {
  mkdirSync(output, { recursive: true });
  writeFileSync(`${output}/e2e.json`, JSON.stringify({ results, failures }, null, 2));
  await browser.close();
  await server.close();
}

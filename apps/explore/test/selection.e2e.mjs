import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const directory = fileURLToPath(new URL('.', import.meta.url));
const output = process.argv[2] ?? '/tmp/hireling-selection-evidence';
const base = 'http://127.0.0.1:5192';
const creator = '0x1111111111111111111111111111111111111111';
const token = '0x2222222222222222222222222222222222222222';
const now = Math.floor(Date.now() / 1000);
const applications = [1, 2].map((index) => ({ id: `app-${index}`, worker: `0x${String(index + 2).repeat(40)}`, agent_id: String(7000 + index), note: 'Mocked test applicant' }));
const selection = (application, state = 'signed') => ({ applicationId: application.id, agentId: application.agent_id, activateBy: state === 'expired' ? now - 1 : now + 3600, state });
const offer = { taskId: 'selection-fixture', jobId: '61', title: 'Selection refresh fixture', creator, approver: creator, mode: 'hire', stack: 'main', token, reward: '5000000', creatorBond: '0', workerBond: '0', deliveryDeadline: now + 86400, selectionDeadline: null, termsHash: `0x${'11'.repeat(32)}`, requiredChecks: [], executionBudget: null, screening: { verdict: 'clean', reasons: [] }, terms: { brief: 'Browser regression only; no live Job 61 interaction.', acceptanceCriteria: [], windows: { reviewSeconds: 3600, disputeSeconds: 3600, arbitrationSeconds: 3600 } } };
const results = [];
const errors = [];
const server = await createServer({ envFile: false, server: { host: '127.0.0.1', port: 5192, strictPort: true }, plugins: [{ name: 'selection-wallet-fixtures', enforce: 'pre', resolveId(source) {
  if (source === 'wagmi') return `${directory}directory-wagmi.mjs`;
  if (source === 'wagmi/actions') return `${directory}wagmi-actions.mjs`;
  if (source.endsWith('/Privy.tsx')) return `${directory}privy.mjs`;
}, transform(source, id) {
  if (id.endsWith('/components/Wallet.tsx')) return source.replace('  const ours =', '  window.__fixtureSignOut = signOut;\n  const ours =');
} }] });
await server.listen();
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/home/kristjan/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome' });
mkdirSync(output, { recursive: true });

async function fixture(viewport, pool = false) {
  const context = await browser.newContext({ viewport, hasTouch: viewport.width === 390, isMobile: viewport.width === 390 });
  await context.addInitScript((address) => {
    window.__wallet = { address, connected: true, signatures: [], sends: [] };
    localStorage.setItem('agent-jobs.session', 'fixture-only-not-a-real-session');
    localStorage.setItem('agent-jobs.session-owner', JSON.stringify({ address, expiresAt: Math.floor(Date.now() / 1000) + 86400 }));
  }, creator);
  const state = { selections: [selection(applications[0])], calls: [], chainStatus: 'open', taskReads: 0, afterSubmitState: 'signed' };
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort('blockedbyclient');
    const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/__test/token') return reply({ symbol: 'TEST', decimals: 6 });
    if (url.pathname === '/data/jobs/61') return reply({ ok: true, job: { status: state.chainStatus, mode: 'hire', worker: null, agent_id: null, creator, approver: creator, token, reward: '5000000', creator_bond: '0', worker_bond: '0', delivery_deadline: now + 86400, selection_deadline: null }, board: { boardId: 'public', taskId: offer.taskId }, rewards: [], bonds: [], evidence: [], feedback: null, ruling: null, timeline: [] });
    if (url.pathname === '/data/stats') return reply({ ok: true, jobs: 0, completed: 0, agents: 0, activity: { demo: 0, unclassified: 0, independent: null }, accounting: {} });
    if (url.pathname.startsWith('/data/')) return reply({ ok: true, agents: [], jobs: [], boards: [] });
    if (url.pathname.includes('/api/')) {
      const name = url.pathname.split('/').at(-1);
      state.calls.push(name);
      if (name === 'task_index') return reply({ ok: true, result: [{ ...offer, status: state.chainStatus }] });
      if (name === 'get_task') {
        state.taskReads += 1;
        return reply({ ok: true, result: { ...offer, creator: pool ? '0x4444444444444444444444444444444444444444' : creator, selection: state.selections, you: pool ? ['creator'] : ['creator', 'approver'], chain: { status: state.chainStatus, provider: null, timely: false, submittedAt: null, reviewEndsAt: null, disputeEndsAt: null, arbitrationEndsAt: null, violation: null, listingMatchesOffer: true, paused: false } } });
      }
      if (name === 'list_applications') return reply({ ok: true, result: applications });
      if (name === 'select_worker') return reply({ ok: true, result: { nonce: '1', sign: { typedData: JSON.stringify({ domain: { chainId: 10143 }, types: { Selection: [{ name: 'nonce', type: 'uint256' }] }, primaryType: 'Selection', message: { nonce: '1' } }) } } });
      if (name === 'submit_selection') {
        const selected = selection(applications[0], state.afterSubmitState);
        state.selections = [selected];
        return reply({ ok: true, result: { ok: true, worker: applications[0].worker, activateBy: selected.activateBy } });
      }
      return reply({ ok: false, message: 'Fixture denies unexpected operation' }, 400);
    }
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
    await page.goto(`${base}/job/61`);
    await page.getByText('Selected — waiting for worker activation', { exact: true }).waitFor();
    await page.getByText('On-chain: Open', { exact: true }).waitFor();
    assert.equal(await page.getByText('Selected', { exact: true }).count(), 2);
    assert.equal(await page.getByRole('button', { name: 'Select', exact: true }).count(), 1);
    const reads = state.taskReads;
    await page.reload();
    await page.getByText('Selected — waiting for worker activation', { exact: true }).waitFor();
    assert.ok(state.taskReads > reads, 'reload must issue a fresh persisted task read');
    assert.equal(state.calls.filter((name) => name === 'select_worker' || name === 'submit_selection').length, 0);
    assert.deepEqual(await page.evaluate(() => window.__wallet.signatures), []);
    await capture(page, `${device}-selected-reload`);
    state.selections = [selection(applications[0], 'expired')];
    await page.reload();
    await page.getByText('The previous selection expired before activation. You can select an applicant again.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Select', exact: true }).count(), 2);
    assert.equal(await page.getByText('Selected — waiting for worker activation', { exact: true }).count(), 0);
    await capture(page, `${device}-expired`);
    state.selections = [selection(applications[0]), selection(applications[1])];
    await page.reload();
    await page.getByText('Selected — waiting for worker activation', { exact: true }).waitFor();
    // Both applicants' badges render after the status line: wait for the third before counting.
    await page.getByText('Selected', { exact: true }).nth(2).waitFor();
    assert.equal(await page.getByText('Selected', { exact: true }).count(), 3);
    state.selections = [selection(applications[0], 'invalid')];
    await page.reload();
    await page.getByText('The previous selection is no longer valid for this offer. No worker activation is confirmed.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Select', exact: true }).count(), 2);
    state.selections = [selection(applications[0], 'unavailable')];
    await page.reload();
    await page.getByText('Selection verification is unavailable. A stored signature is not proof the worker can still activate.', { exact: true }).waitFor();
    assert.equal(await page.getByText('Selected — waiting for worker activation', { exact: true }).count(), 0);
    state.selections = [];
    await page.reload();
    await page.getByRole('button', { name: 'Select', exact: true }).first().click();
    await page.getByRole('button', { name: 'Sign the selection', exact: true }).click();
    await page.getByText('Selected — waiting for worker activation', { exact: true }).waitFor();
    assert.equal(state.calls.filter((name) => name === 'submit_selection').length, 1);
    assert.equal(await page.evaluate(() => window.__wallet.sends.length), 0);
    state.selections = [];
    state.afterSubmitState = 'invalid';
    await page.reload();
    await page.getByRole('button', { name: 'Select', exact: true }).first().click();
    await page.getByRole('button', { name: 'Sign the selection', exact: true }).click();
    await page.getByText('The previous selection is no longer valid for this offer. No worker activation is confirmed.', { exact: true }).waitFor();
    assert.equal(await page.getByText('Selected — waiting for worker activation', { exact: true }).count(), 0);
    state.selections = [selection(applications[0])];
    await page.reload();
    await page.getByText('Selected — waiting for worker activation', { exact: true }).waitFor();
    await page.getByText('Applications · 2', { exact: true }).waitFor();
    const applicationReads = state.calls.filter((name) => name === 'list_applications').length;
    await page.evaluate(() => window.__fixtureSignOut());
    await page.getByText('Applications · 2', { exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await page.getByText('Selected', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Select', exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => window.__wallet.address), creator);
    assert.equal(state.calls.filter((name) => name === 'list_applications').length, applicationReads);
    await capture(page, `${device}-signed-out`);
    await page.reload();
    await page.getByText('Selected — waiting for worker activation', { exact: true }).waitFor();
    await page.evaluate(() => { window.__wallet.address = '0x5555555555555555555555555555555555555555'; window.dispatchEvent(new Event('fixture-wallet-change')); });
    await page.getByText('Selected — waiting for worker activation', { exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await page.getByText('Selected', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Select', exact: true }).count(), 0);
    results.push({ device, viewport, checks: ['persisted reload without signing', 'expired reselect', 'multiple selections', 'invalid selection', 'unavailable verification', 'new selection cache hydration', 'signed-out connected wallet hides cached applications', 'account switch hides selection'], passed: true });
    await context.close();
  }
  const poolFixture = await fixture({ width: 390, height: 844 }, true);
  await poolFixture.page.goto(`${base}/job/61`);
  await poolFixture.page.getByText('Selected — waiting for worker activation', { exact: true }).waitFor();
  await poolFixture.page.getByText('Applications · 2', { exact: true }).waitFor();
  assert.equal(await poolFixture.page.getByRole('button', { name: 'Select', exact: true }).count(), 1);
  assert.equal(await poolFixture.page.getByText('On-chain: Open', { exact: true }).count(), 1);
  results.push({ checks: ['distinct pool contract and curator viewer receives application badge/actions'], passed: true });
  await poolFixture.context.close();
  assert.deepEqual(errors, []);
  writeFileSync(`${output}/results.json`, JSON.stringify({ tier: 'mocked Chromium only; no live Job 61, wallet signing or sends', results, errors }, null, 2));
  console.log('PASS: selection regression at 390x844 and 1440x900');
} finally {
  await browser.close();
  await server.close();
}

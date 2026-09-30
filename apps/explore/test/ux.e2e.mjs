import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
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
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/home/kristjan/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome' });
const results = [];
const failures = [];

async function fixture(viewport, options = {}) {
  const context = await browser.newContext({ viewport, hasTouch: viewport.width === 390, isMobile: viewport.width === 390, colorScheme: options.dark ? 'dark' : 'light' });
  await context.addInitScript(({ owner, batch, connected }) => {
    window.__wallet = { sends: JSON.parse(localStorage.getItem('fixture-wallet-sends') ?? '[]'), connected, batch, address: localStorage.getItem('fixture-wallet-address') ?? owner };
    if (!localStorage.getItem('agent-jobs.session')) localStorage.setItem('agent-jobs.session', 'fixture-only-not-a-real-session');
    if (!localStorage.getItem('agent-jobs.session-owner')) localStorage.setItem('agent-jobs.session-owner', JSON.stringify({ address: owner, expiresAt: Math.floor(Date.now() / 1000) + 86400 }));
  }, { owner: creator, batch: options.batch ?? false, connected: options.connected ?? true });
  const state = { chainError: options.chainError ?? false, boardError: options.boardError ?? false, receiptError: false, reportError: false, reports: 0, published: false, tokenError: options.tokenError ?? false, tokenDelay: options.tokenDelay ?? 0, tokenDecimals: options.tokenDecimals ?? 6, tokenSymbol: options.tokenSymbol ?? 'OPEN', jobStatus: options.jobStatus ?? 'completed', boardStatus: options.boardStatus ?? 'completed', taskError: false };
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort('blockedbyclient');
    const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/__test/token') {
      if (state.tokenDelay) await new Promise((resolve) => setTimeout(resolve, state.tokenDelay));
      return reply({ symbol: state.tokenSymbol, decimals: state.tokenDecimals }, state.tokenError ? 503 : 200);
    }
    if (url.pathname === '/__test/receipt') return reply({ status: 'success' }, state.receiptError ? 503 : 200);
    if (url.pathname.endsWith('/api/task_index')) return reply({ ok: !state.boardError, message: 'Board unavailable', result: [{ ...offer, jobId: '60' }] }, state.boardError ? 503 : 200);
    if (url.pathname.endsWith('/api/get_task')) {
      if (state.taskError) return reply({ ok: false, message: 'Board unavailable' }, 503);
      const jobId = state.published ? '61' : route.request().frame().url().includes('/job/') ? '60' : null;
      return reply({ ok: true, result: { ...offer, jobId, you: jobId === null ? [] : ['creator', 'approver'], chain: { status: jobId === null ? 'awaiting-publish' : state.boardStatus, provider: jobId === null ? null : creator, timely: true, submittedAt: jobId === null ? null : now - 10, reviewEndsAt: now + 3600, disputeEndsAt: null, arbitrationEndsAt: null, violation: null, listingMatchesOffer: true, paused: false } } });
    }
    if (url.pathname.endsWith('/api/publish_transactions')) return reply({ ok: true, result: { transactions } });
    if (url.pathname.endsWith('/api/get_board')) return reply({ ok: true, result: { board: { id: 'public', name: 'Fixture board', rewardTokens: [], stacks: [] } } });
    if (url.pathname.endsWith('/api/create_task')) return reply({ ok: true, result: { ...offer, transactions } });
    if (url.pathname.endsWith('/api/approve_work')) return reply({ ok: true, result: { transactions: [transactions[2]] } });
    if (url.pathname.endsWith('/api/report_transaction')) {
      if (state.reportError) return reply({ ok: false, message: 'Fixture board unavailable' }, 503);
      state.reports++;
      if (state.reports === (options.batch ? 1 : 3)) state.published = true;
      return reply({ ok: true, result: {} });
    }
    if (url.pathname.endsWith('/api/list_quote_requests')) return reply({ ok: true, result: [] });
    if (url.pathname.includes('/api/')) return reply({ ok: false, message: 'Fixture denies this operation' }, 400);
    if (url.pathname === '/data/jobs') return state.chainError
      ? reply({ ok: false, message: 'Chain unavailable' }, 503)
      : reply({ ok: true, jobs: [{ job_id: '60', status: 'completed', mode: 'hire', board_id: 'public', token, reward: '5000000', creator, approver: creator, worker: creator, agent_id: '1', delivery_deadline: now + 86400, creator_bond: '0', worker_bond: '0' }], index: { next_block: 100, updated_at: now } });
    if (url.pathname === '/data/boards') return reply({ ok: true, boards: [] });
    if (url.pathname === '/data/stats') return reply({ ok: true, jobs: 1, completed: 1, agents: 1, paidOut: { [token]: '5000000' }, inEscrow: {} });
    if (url.pathname.startsWith('/data/jobs/')) return state.chainError
      ? reply({ ok: false, message: 'Chain unavailable' }, 503)
      : reply({ ok: true, job: { job_id: '60', status: state.jobStatus, mode: 'hire', token, reward: '5000000', creator, approver: creator, worker: creator, agent_id: '1', violation: null }, rewards: [{ amount: '5000000', to_worker: 1 }], evidence: [], timeline: [], ruling: null, board: null });
    if (url.pathname.startsWith('/data/')) return reply({ ok: true, agents: [], jobs: [] });
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
  await page.getByRole('button', { name: 'Confirm fixture' }).focus();
  assert.equal(await page.getByRole('button', { name: 'Confirm fixture' }).evaluate((button) => {
    const bounds = button.getBoundingClientRect();
    return document.activeElement === button && button === document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  }), true);
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

async function testTokenAmounts() {
  const { context, page } = await fixture({ width: 390, height: 844 }, { tokenDelay: 1500 });
  await page.goto(base);
  await page.waitForTimeout(500);
  assert.equal(await page.getByText('0 tokens', { exact: true }).count(), 0);
  await page.getByText('5 OPEN', { exact: true }).waitFor();
  await snap(page, 'mobile', 'token-resolved-list');
  await page.getByRole('link', { name: /Wallet fixture job/ }).click();
  await page.getByText('5 OPEN', { exact: true }).first().waitFor();
  await page.getByRole('link', { name: 'Jobs', exact: true }).first().click();
  await page.getByText('5 OPEN', { exact: true }).waitFor();
  results.push({ name: 'token-cold-pending-resolved-list-detail-list', passed: true });
  await context.close();
  const failure = await fixture({ width: 390, height: 844 }, { tokenError: true });
  await failure.page.goto(base);
  await failure.page.getByText('Token unavailable', { exact: true }).waitFor();
  assert.equal(await failure.page.getByText('0 tokens', { exact: true }).count(), 0);
  await snap(failure.page, 'mobile', 'token-failure');
  await failure.context.close();
  const totals = await fixture({ width: 1440, height: 900 }, { connected: false });
  await totals.page.goto(base);
  await totals.page.getByText('5 OPEN', { exact: true }).first().waitFor();
  assert.ok((await totals.page.getByText('5 OPEN', { exact: true }).count()) >= 2);
  results.push({ name: 'aggregate-metadata-resolution', passed: true });
  await totals.context.close();
}

async function testLayout(viewport, dark = false, enlarged = false) {
  const { context, page } = await fixture(viewport, { dark });
  await page.goto(`${base}/job/60`);
  await page.getByText('5 OPEN', { exact: true }).first().waitFor();
  if (enlarged) await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
  await page.getByText('Details', { exact: true }).click();
  await page.waitForTimeout(500);
  const dimensions = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  await snap(page, viewport.width === 390 ? 'mobile' : 'desktop', `long-job-${dark ? 'dark' : 'light'}${enlarged ? '-200pct' : ''}`);
  assert.ok(dimensions.scroll <= dimensions.client, JSON.stringify(dimensions));
  await context.close();
}

async function testControls(viewport) {
  const { context, page } = await fixture(viewport, { connected: false });
  await page.goto(base);
  const how = page.getByRole('button', { name: 'How it works' });
  await how.click();
  const dialog = page.getByRole('dialog', { name: 'How Hireling works' });
  await dialog.waitFor();
  await dialog.evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {})));
  });
  const close = page.getByRole('button', { name: 'Close', exact: true });
  const bounds = await close.boundingBox();
  assert.ok(bounds.width >= 44 && bounds.height >= 44, `Close target ${JSON.stringify(bounds)} at ${JSON.stringify(viewport)}`);
  await page.keyboard.press('Escape');
  assert.equal(await how.evaluate((button) => button === document.activeElement), true);
  const all = page.getByRole('radio', { name: /All/ });
  await all.focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('radio', { name: /Open/ }).getAttribute('aria-checked'), 'true');
  assert.equal(await page.getByRole('radio', { name: /Open/ }).evaluate((button) => button === document.activeElement), true);
  await page.keyboard.press('End');
  assert.equal(await page.getByRole('radio', { name: /Done/ }).getAttribute('aria-checked'), 'true');
  await page.keyboard.press('Home');
  assert.equal(await all.getAttribute('tabindex'), '0');
  await page.goto(`${base}/publish`);
  await page.locator('#post-title').fill('Control fixture');
  await page.locator('#post-brief').fill('Control sizes and keyboard semantics.');
  await page.locator('#post-criteria').fill('Keyboard and touch controls work.');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const choice = page.getByRole('radio', { name: /Hire one agent/ });
  await choice.focus();
  await page.keyboard.press('ArrowDown');
  const quotes = page.getByRole('radio', { name: /Get quotes first/ });
  assert.equal(await quotes.getAttribute('aria-checked'), 'true');
  assert.equal(await quotes.evaluate((button) => button === document.activeElement), true);
  await page.keyboard.press('Home');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByText('Advanced', { exact: true }).click();
  const targets = await page.locator('[role="radio"], [role="switch"], [aria-pressed], button[aria-label^="Copy"]').evaluateAll((elements) => elements.filter((element) => element.getBoundingClientRect().width > 0).map((element) => ({ text: element.textContent, width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })));
  assert.ok(targets.length > 5);
  assert.ok(targets.every(({ width, height }) => Math.round(width * 1000) >= 44000 && Math.round(height * 1000) >= 44000), JSON.stringify(targets));
  await snap(page, viewport.width === 390 ? 'mobile' : 'desktop', 'controls-44px-keyboard');
  results.push({ name: 'controls', viewport, targets });
  await context.close();
}

async function testChainFailure() {
  const { context, page, state } = await fixture({ width: 390, height: 844 }, { chainError: true });
  await page.goto(base);
  await page.getByText('Chain jobs are unavailable', { exact: true }).waitFor();
  assert.equal(await page.getByText('Indexing…', { exact: true }).count(), 0);
  assert.match(await page.getByRole('radio', { name: /Done/ }).innerText(), /—/);
  await snap(page, 'mobile', 'first-chain-failure');
  state.chainError = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByRole('radio', { name: /Done 1/ }).waitFor();
  state.chainError = true;
  await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
  await page.waitForTimeout(21000);
  await page.getByText(/Showing last-known chain facts/).waitFor();
  assert.match(await page.getByRole('radio', { name: /Done/ }).innerText(), /1/);
  assert.equal(await page.getByText('Indexing…', { exact: true }).count(), 0);
  await snap(page, 'mobile', 'stale-chain-facts');
  state.chainError = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByText(/Showing last-known chain facts/).waitFor({ state: 'hidden' });
  results.push({ name: 'partial-chain-first-failure-stale-retry', passed: true });
  await context.close();
}

async function testUncertainSend() {
  const { context, page } = await fixture({ width: 390, height: 844 });
  await page.goto(`${base}/publish?resume=fixture-offer`);
  await page.getByRole('button', { name: 'Prepare wallet steps' }).click();
  await page.getByRole('button', { name: 'Confirm step 1 of 3' }).click();
  await page.evaluate(() => { window.__wallet.ambiguous = true; });
  await page.getByRole('button', { name: 'Confirm fixture' }).click();
  await page.getByRole('textbox', { name: 'Transaction hash from wallet activity' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Try again', exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => window.__wallet.sends.length), 1);
  await page.reload();
  await page.getByRole('button', { name: 'Prepare wallet steps' }).click();
  await page.getByRole('textbox', { name: 'Transaction hash from wallet activity' }).fill(`0x${'1'.padStart(64, '0')}`);
  await page.getByRole('button', { name: 'Check existing transaction' }).click();
  await page.getByRole('button', { name: 'Confirm step 2 of 3' }).waitFor();
  assert.equal(await page.evaluate(() => window.__wallet.sends.length), 1);
  results.push({ name: 'ambiguous-broadcast-reload-reconcile-no-resend', passed: true });
  await context.close();
}

async function testNewPublishOwner() {
  const { context, page } = await fixture({ width: 390, height: 844 });
  await page.goto(`${base}/publish`);
  await page.locator('#post-title').fill('Prepared by account A');
  await page.locator('#post-brief').fill('A frozen account-bound offer.');
  await page.locator('#post-criteria').fill('Keep the original wallet and terms.');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.locator('#post-reward').fill('10');
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm step 1 of 3' }).waitFor();
  const accountB = `0x${'3'.repeat(40)}`;
  await page.evaluate((address) => { window.__wallet.address = address; localStorage.setItem('fixture-wallet-address', address); window.dispatchEvent(new Event('fixture-wallet-change')); }, accountB);
  await page.getByText('Return to the wallet that prepared this offer before confirming more steps.').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Confirm step 1 of 3' }).isDisabled(), true);
  assert.equal(await page.evaluate(() => window.__wallet.sends.length), 0);
  await page.evaluate((address) => { window.__wallet.address = address; localStorage.setItem('fixture-wallet-address', address); window.dispatchEvent(new Event('fixture-wallet-change')); }, creator);
  await page.getByRole('button', { name: 'Confirm step 1 of 3' }).click();
  await page.getByRole('button', { name: 'Decline fixture' }).click();
  await page.getByRole('button', { name: 'Try again' }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: 'Confirm step 1 of 3' }).waitFor();
  const snapshots = await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('hireling.post-draft:')).map((key) => ({ key, value: JSON.parse(localStorage.getItem(key)) })));
  assert.ok(snapshots.some(({ key, value }) => key.endsWith(creator) && value.frozen.owner === creator && value.frozen.started === true));
  assert.equal(snapshots.some(({ key, value }) => key.endsWith(accountB) && value.frozen !== null), false);
  await page.reload();
  await page.getByRole('button', { name: 'Confirm step 1 of 3' }).waitFor();
  await page.getByText('Prepared by account A', { exact: true }).first().waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('fixture-wallet-address')), creator);
  results.push({ name: 'new-publish-owner-bound-before-first-send-and-reload', passed: true });
  await context.close();
}

async function testConflictingActions() {
  const { context, page, state } = await fixture({ width: 390, height: 844 }, { jobStatus: 'submitted', boardStatus: 'submitted' });
  await page.goto(`${base}/job/60`);
  await page.getByRole('button', { name: /Approve and pay 5 OPEN/ }).click();
  await page.getByRole('button', { name: 'Approve and pay', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm in your wallet', exact: true }).click();
  state.receiptError = true;
  await page.getByRole('button', { name: 'Confirm fixture' }).click();
  await page.getByRole('button', { name: 'Try again' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Reject', exact: true }).isDisabled(), true);
  assert.equal(await page.locator('dialog[open]').count(), 0);
  state.receiptError = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await page.getByRole('status').filter({ hasText: 'Paid 5 OPEN to Agent #1' }).waitFor();
  assert.equal(await page.evaluate(() => window.__wallet.sends.length), 1);
  assert.equal(await page.getByText('Rejected. The dispute window is open.', { exact: true }).count(), 0);
  results.push({ name: 'conflicting-job-action-is-locked-through-receipt-recovery', passed: true });
  await context.close();
}

async function testFrozenRecovery() {
  for (const confirmed of [false, true]) {
    const { context, page } = await fixture({ width: 390, height: 844 });
    await page.goto(`${base}/publish`);
    await page.locator('#post-title').fill('Expiry fixture');
    await page.locator('#post-brief').fill('Frozen terms');
    await page.locator('#post-criteria').fill('Keep the frozen terms.');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm step 1 of 3' }).click();
    await page.getByRole('button', { name: confirmed ? 'Confirm fixture' : 'Decline fixture' }).click();
    await page.getByRole('button', { name: confirmed ? 'Confirm step 2 of 3' : 'Try again' }).waitFor();
    await page.evaluate(() => {
      const key = Object.keys(localStorage).find((entry) => entry.startsWith('hireling.post-draft:'));
      const draft = JSON.parse(localStorage.getItem(key));
      draft.frozen.deliveryDeadline = Math.floor(Date.now() / 1000) - 1;
      localStorage.setItem(key, JSON.stringify(draft));
    });
    await page.reload();
    await page.getByText('This offer has expired. Prepare a new offer before confirming any new steps.').waitFor();
    const confirm = page.getByRole('button', { name: confirmed ? 'Confirm step 2 of 3' : 'Confirm step 1 of 3' });
    assert.equal(await confirm.isDisabled(), true);
    const restart = page.getByRole('button', { name: 'Start a new offer', exact: true });
    assert.equal(await restart.isDisabled(), false);
    await restart.click();
    assert.equal(await page.locator('#post-title').isEnabled(), true);
    assert.equal(await page.evaluate(() => window.__wallet.sends.length), confirmed ? 1 : 0);
    results.push({ name: `expired-offer-safe-restart-after-${confirmed ? 'confirmed-approval' : 'wallet-refusal'}`, passed: true });
    await context.close();
  }
}

async function testFrozenPrefill() {
  const { context, page } = await fixture({ width: 390, height: 844 });
  await page.goto(`${base}/embed/public?view=publish&title=Original%20offer&brief=Original%20terms&reward=10`);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm step 1 of 3' }).click();
  await page.evaluate((replacementToken) => window.postMessage({ source: 'agent-jobs-host', type: 'prefill', payload: { title: 'Changed offer', brief: 'Changed terms', reward: '999', token: replacementToken, mode: 'contest' } }, '*'), token);
  await page.getByRole('button', { name: 'Decline fixture' }).click();
  await page.getByRole('button', { name: 'Try again' }).waitFor();
  await page.getByText('Original offer', { exact: true }).first().waitFor();
  assert.equal(await page.getByText('Changed offer', { exact: true }).count(), 0);
  const snapshot = await page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find((entry) => entry.startsWith('hireling.post-draft:')))));
  assert.equal(snapshot.frozen.form.reward, '10');
  assert.equal(snapshot.frozen.form.mode, 'hire');
  assert.notEqual(snapshot.frozen.form.token, token);
  await page.reload();
  await page.getByText('Original offer', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: 'Confirm step 1 of 3' }).waitFor();
  assert.equal(await page.evaluate(() => window.__wallet.sends.length), 0);
  results.push({ name: 'host-prefill-cannot-change-frozen-consent-after-reload', passed: true });
  await context.close();
}

async function testStaleBoardDetail() {
  const { context, page, state } = await fixture({ width: 390, height: 844 }, { jobStatus: 'active', boardStatus: 'active' });
  await page.goto(`${base}/job/60`);
  await page.getByText(/Locked in escrow/).first().waitFor();
  state.taskError = true;
  state.jobStatus = 'completed';
  await page.getByText(/Showing indexed chain facts instead/).waitFor({ timeout: 45000 });
  await page.getByText('Paid to Agent #1', { exact: true }).waitFor();
  assert.equal(await page.getByText(/Locked in escrow/).count(), 0);
  state.taskError = false;
  state.boardStatus = 'completed';
  await page.getByRole('button', { name: 'Retry offer details' }).click();
  await page.getByText(/Showing indexed chain facts instead/).waitFor({ state: 'hidden' });
  results.push({ name: 'stale-board-active-never-overrides-fresh-chain-completion', passed: true });
  await context.close();
}

async function testLongToken() {
  const { context, page } = await fixture({ width: 390, height: 844 }, { tokenSymbol: 'LONG'.repeat(30), tokenDecimals: 0 });
  await page.goto(base);
  await page.getByText(`5,000,000 ${'LONG'.repeat(30)}`, { exact: true }).waitFor();
  await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
  const bounds = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, outside: [...document.querySelectorAll('body *')].filter((element) => element.getBoundingClientRect().right > document.documentElement.clientWidth).map((element) => ({ tag: element.tagName, className: element.className, text: element.textContent?.slice(0, 80), right: element.getBoundingClientRect().right })) }));
  await snap(page, 'mobile', 'long-token-200pct');
  assert.ok(bounds.scroll <= bounds.client, JSON.stringify(bounds));
  results.push({ name: 'long-token-zero-decimal-row-200pct-contained', passed: true });
  await context.close();
}

try {
  if (process.argv[3] === 'long-token') {
    await testLongToken();
  } else {
    for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) await testPublish(viewport);
    await testPublish({ width: 390, height: 844 }, true);
    await testTokenAmounts();
    await testLayout({ width: 390, height: 844 });
    await testLayout({ width: 390, height: 844 }, true);
    await testLayout({ width: 390, height: 844 }, false, true);
    await testLayout({ width: 1440, height: 900 });
    for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) await testControls(viewport);
    await testChainFailure();
    await testUncertainSend();
    await testNewPublishOwner();
    await testConflictingActions();
    await testFrozenRecovery();
    await testFrozenPrefill();
    await testStaleBoardDetail();
    await testLongToken();
  }
  assert.deepEqual(failures, []);
  console.log(`PASS: ${results.length} publish browser evidence records`);
} finally {
  mkdirSync(output, { recursive: true });
  writeFileSync(`${output}/e2e.json`, JSON.stringify({ results, failures }, null, 2));
  await browser.close();
  await server.close();
}

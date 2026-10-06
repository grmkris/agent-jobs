import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const directory = fileURLToPath(new URL('.', import.meta.url));
const output = process.argv[2] ?? '/tmp/sidequest-ux-evidence';
const base = 'http://127.0.0.1:5190';
const creator = '0x1111111111111111111111111111111111111111';
const token = '0x2222222222222222222222222222222222222222';
const arbitrator = JSON.parse(readFileSync(new URL('../../../contracts/config/monad-testnet.json', import.meta.url), 'utf8')).deployment.sidequest.defaultArbitrator;
const transactions = ['Approve reward token', 'Approve SIDE bond', 'Publish job'].map((description, index) => ({ description, chainId: 10143, to: token, data: `0x0${index}`, value: '0' }));
const now = Math.floor(Date.now() / 1000);
const offer = { taskId: 'fixture-offer', jobId: null, title: 'Wallet fixture job', creator, approver: creator, mode: 'hire', stack: 'main', kind: 'sidequest-v1', token, reward: '5000000', creatorBond: '0', workerBond: '0', deliveryDeadline: now + 86400, selectionDeadline: null, termsHash: '0xabcdef', manifestUrl: '/offers/fixture.json', terms: { brief: `Long URL https://example.test/${'long-segment'.repeat(60)}`, acceptanceCriteria: [`Long criterion ${'unbroken'.repeat(60)}`], evidencePolicy: { checks: [] }, windows: { reviewSeconds: 3600, disputeSeconds: 3600, arbitrationSeconds: 3600 } }, deliverable: { accepts: ['url'] }, screening: { verdict: 'ok', reasons: [] }, executionBudget: null, requiredChecks: [], brief: `https://example.test/${'segment'.repeat(100)}`, acceptanceCriteria: ['Readable on a phone'], status: 'completed' };
// A Privy app id whatever the runner's shell holds, so sign-in buttons render the same everywhere; Privy itself is a
// test double (privy.mjs, privy-react-auth.mjs) and nothing reaches Privy.
process.env.PRIVY_APP_ID = 'fixture-privy-app-id';
const server = await createServer({ envFile: false, server: { host: '127.0.0.1', port: 5190, strictPort: true }, plugins: [{ name: 'ux-wallet-fixtures', enforce: 'pre', resolveId(source) {
  if (source === 'wagmi') return `${directory}v1-wagmi.mjs`;
  if (source === 'wagmi/actions') return `${directory}wagmi-actions.mjs`;
  if (source.endsWith('/Privy.tsx')) return `${directory}privy.mjs`;
  if (source === '@privy-io/react-auth') return `${directory}privy-react-auth.mjs`;
} }] });
await server.listen();
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/home/kristjan/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome' });
const results = [];
const failures = [];

async function fixture(viewport, options = {}) {
  const context = await browser.newContext({ viewport, hasTouch: viewport.width === 390, isMobile: viewport.width === 390, colorScheme: options.dark ? 'dark' : 'light' });
  await context.addInitScript(({ owner, batch, connected, session, arbiter }) => {
    window.__v1 = { arbiter, free: 100n * 10n ** 18n, bonus: 0n, topUp: 0n, quote: [3000, 1500000n, 3500000n] };
    window.__wallet = { sends: JSON.parse(localStorage.getItem('fixture-wallet-sends') ?? '[]'), connected, batch, address: localStorage.getItem('fixture-wallet-address') ?? owner };
    if (!session) {
      // Signed out: the automatic sign-in prompt was already asked (and declined) in this tab.
      sessionStorage.setItem(`sidequest.asked:${window.__wallet.address.toLowerCase()}`, '1');
      return;
    }
    if (!localStorage.getItem('sidequest.session')) localStorage.setItem('sidequest.session', 'fixture-only-not-a-real-session');
    if (!localStorage.getItem('sidequest.session-owner')) localStorage.setItem('sidequest.session-owner', JSON.stringify({ address: owner, expiresAt: Math.floor(Date.now() / 1000) + 86400 }));
  }, { owner: options.address ?? creator, batch: options.batch ?? false, connected: options.connected ?? true, session: options.session ?? true, arbiter: arbitrator });
  const state = { chainError: options.chainError ?? false, detailError: false, boardError: options.boardError ?? false, receiptError: false, reportError: false, reports: 0, published: false, tokenError: options.tokenError ?? false, tokenDelay: options.tokenDelay ?? 0, tokenDecimals: options.tokenDecimals ?? 6, tokenSymbol: options.tokenSymbol ?? 'OPEN', jobStatus: options.jobStatus ?? 'completed', boardStatus: options.boardStatus ?? 'completed', taskError: false, signIns: 0, deadline: offer.deliveryDeadline };
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
      return reply({ ok: true, result: { ...offer, deliveryDeadline: state.deadline, jobId, you: jobId === null ? [] : (options.you ?? ['creator', 'approver']), chain: { status: jobId === null ? 'awaiting-publish' : state.boardStatus, provider: jobId === null ? null : creator, timely: true, submittedAt: jobId === null ? null : now - 10, reviewEndsAt: options.reviewEndsAt ?? now + 3600, disputeEndsAt: null, arbitrationEndsAt: null, violation: null, listingMatchesOffer: true, paused: false } } });
    }
    if (url.pathname.endsWith('/api/auth_challenge')) return reply({ ok: true, result: { message: 'Fixture sign-in message; no real session' } });
    if (url.pathname.endsWith('/api/auth_login')) {
      state.signIns++;
      return reply({ ok: true, result: { session: 'fixture-only-not-a-real-session', address: options.address ?? creator, expiresAt: now + 86400 } });
    }
    if (url.pathname.endsWith('/api/settlement_actions')) return reply({ ok: true, result: { transactions: [{ description: 'Release the payment', chainId: 10143, to: token, data: '0x5e771e', value: '0' }] } });
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
    if (url.pathname.endsWith('/api/agents')) return reply({ ok: true, result: { agents: [] } });
    if (url.pathname.includes('/api/')) return reply({ ok: false, message: 'Fixture denies this operation' }, 400);
    if (url.pathname === '/data/jobs') return state.chainError
      ? reply({ ok: false, message: 'Chain unavailable' }, 503)
      : reply({ ok: true, jobs: [{ job_id: '60', status: 'completed', kind: 'sidequest-v1', mode: 'hire', board_id: 'public', token, reward: '5000000', creator, approver: creator, worker: creator, agent_id: '1', delivery_deadline: now + 86400, creator_bond: '0', worker_bond: '0' }], index: { next_block: 100, updated_at: now } });
    if (url.pathname === '/data/boards') return reply({ ok: true, boards: [] });
    if (url.pathname === '/data/stats') return reply({ ok: true, jobs: 1, completed: 1, agents: 1, activity: { demo: 1, unclassified: 0, independent: null }, accounting: { [token]: { gross: '5000000', fee: '0', net: '5000000', paid: '5000000' } } });
    if (url.pathname.startsWith('/data/jobs/')) return (state.chainError || state.detailError)
      ? reply({ ok: false, message: 'Chain unavailable' }, 503)
      : reply({ ok: true, job: { job_id: '60', status: state.jobStatus, kind: 'sidequest-v1', mode: 'hire', token, reward: '5000000', creator, approver: creator, worker: creator, agent_id: '1', violation: null }, rewards: [{ amount: '5000000', to_worker: 1 }], evidence: [], timeline: [], ruling: null, board: null });
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
  await page.goto(`${base}/account?resume=fixture-offer`);
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
  await page.goto(`${base}/jobs`);
  await page.waitForTimeout(500);
  assert.equal(await page.getByText('0 tokens', { exact: true }).count(), 0);
  await page.getByText('5 OPEN', { exact: true }).waitFor();
  await snap(page, 'mobile', 'token-resolved-list');
  await page.getByRole('link', { name: /Wallet fixture job/ }).click();
  await page.getByText('5 OPEN', { exact: true }).first().waitFor();
  await page.getByRole('link', { name: 'Jobs', exact: true }).first().click();
  await page.waitForURL('**/jobs');
  await page.getByText('5 OPEN', { exact: true }).waitFor();
  results.push({ name: 'token-cold-pending-resolved-list-detail-list', passed: true });
  await context.close();
  const failure = await fixture({ width: 390, height: 844 }, { tokenError: true });
  await failure.page.goto(`${base}/jobs`);
  await failure.page.getByText('Token unavailable', { exact: true }).waitFor();
  assert.equal(await failure.page.getByText('0 tokens', { exact: true }).count(), 0);
  await snap(failure.page, 'mobile', 'token-failure');
  await failure.context.close();
  const totals = await fixture({ width: 1440, height: 900 }, { connected: false });
  await totals.page.goto(base);
  // The landing lists live jobs with resolved token amounts; its per-token aggregate totals left in the redesign.
  await totals.page.getByText('5 OPEN', { exact: true }).first().waitFor();
  assert.equal(await totals.page.getByText('0 tokens', { exact: true }).count(), 0);
  results.push({ name: 'landing-token-resolution', passed: true });
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
  await page.goto(`${base}/jobs`);
  const how = page.getByRole('button', { name: 'How it works' });
  await how.click();
  const dialog = page.getByRole('dialog', { name: 'How Sidequest works' });
  await dialog.waitFor();
  await dialog.evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {})));
  });
  // Touch targets are 44 px on a coarse pointer (the phone context has touch); desktop controls are 32 px.
  const minTarget = viewport.width === 390 ? 44 : 32;
  const close = page.getByRole('button', { name: 'Close', exact: true });
  const bounds = await close.boundingBox();
  assert.ok(bounds.width >= minTarget && bounds.height >= minTarget, `Close target ${JSON.stringify(bounds)} at ${JSON.stringify(viewport)}`);
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
  await page.getByRole('button', { name: 'Create with agent', exact: true }).click();
  const creation = page.getByRole('dialog', { name: 'Create with your agent' });
  await creation.waitFor();
  await page.getByRole('link', { name: 'Set up an agent', exact: true }).waitFor();
  await creation.evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {})));
  });
  await page.waitForTimeout(250);
  const targets = await creation.locator('button, [role="radio"]').evaluateAll((elements) => elements.filter((element) => element.getBoundingClientRect().width > 0).map((element) => ({ text: element.textContent, width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })));
  assert.ok(targets.length > 0);
  assert.ok(targets.every(({ width, height }) => Math.round(width * 1000) >= minTarget * 1000 && Math.round(height * 1000) >= minTarget * 1000), JSON.stringify(targets));
  await snap(page, viewport.width === 390 ? 'mobile' : 'desktop', 'controls-44px-keyboard');
  results.push({ name: 'controls', viewport, targets });
  await context.close();
}

async function testChainFailure() {
  const { context, page, state } = await fixture({ width: 390, height: 844 }, { chainError: true });
  await page.goto(`${base}/jobs`);
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
  // A wallet error after the broadcast: the nonce snapshot finds the mined step, so it continues without a resend.
  {
    const { context, page, state } = await fixture({ width: 390, height: 844 });
    await page.goto(`${base}/account?resume=fixture-offer`);
    await page.getByRole('button', { name: 'Prepare wallet steps' }).click();
    await page.getByRole('button', { name: 'Confirm step 1 of 3' }).click();
    await page.getByRole('dialog', { name: 'Wallet confirmation fixture' }).waitFor();
    await page.evaluate(() => { window.__wallet.ambiguous = true; });
    await page.getByRole('button', { name: 'Confirm fixture' }).click();
    await page.getByText('Checking the chain…', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Try again', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Confirm step 2 of 3' }).waitFor({ timeout: 20000 });
    assert.equal(await page.evaluate(() => window.__wallet.sends.length), 1);
    assert.equal(state.reports, 1);
    results.push({ name: 'ambiguous-broadcast-found-by-nonce-no-resend', passed: true });
    await context.close();
  }
  // The chain cannot answer: the step stays uncertain with a check again, never a resend, until the chain finds it.
  {
    const { context, page } = await fixture({ width: 390, height: 844 });
    await page.goto(`${base}/account?resume=fixture-offer`);
    await page.getByRole('button', { name: 'Prepare wallet steps' }).click();
    await page.getByRole('button', { name: 'Confirm step 1 of 3' }).click();
    await page.getByRole('dialog', { name: 'Wallet confirmation fixture' }).waitFor();
    await page.evaluate(() => { window.__wallet.ambiguous = true; window.__wallet.chainDown = true; });
    await page.getByRole('button', { name: 'Confirm fixture' }).click();
    await page.getByRole('button', { name: 'Check the chain again' }).waitFor({ timeout: 30000 });
    await page.getByRole('textbox', { name: 'Transaction hash from wallet activity' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Try again', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: /Confirm step/ }).count(), 0);
    await snap(page, 'mobile', 'uncertain-chain-unavailable');
    await page.evaluate(() => { window.__wallet.chainDown = false; });
    await page.getByRole('button', { name: 'Check the chain again' }).click();
    await page.getByRole('button', { name: 'Confirm step 2 of 3' }).waitFor({ timeout: 20000 });
    assert.equal(await page.evaluate(() => window.__wallet.sends.length), 1);
    results.push({ name: 'ambiguous-broadcast-chain-down-stays-uncertain-then-check-again', passed: true });
    await context.close();
  }
  // A reload while the chain is being checked picks the check up again from the stored snapshot.
  {
    const { context, page } = await fixture({ width: 390, height: 844 });
    await page.goto(`${base}/account?resume=fixture-offer`);
    await page.getByRole('button', { name: 'Prepare wallet steps' }).click();
    await page.getByRole('button', { name: 'Confirm step 1 of 3' }).click();
    await page.getByRole('dialog', { name: 'Wallet confirmation fixture' }).waitFor();
    await page.evaluate(() => { window.__wallet.ambiguous = true; window.__wallet.chainDown = true; });
    await page.getByRole('button', { name: 'Confirm fixture' }).click();
    await page.getByText('Checking the chain…', { exact: true }).waitFor();
    await page.reload();
    await page.getByRole('button', { name: 'Prepare wallet steps' }).click();
    await page.getByRole('button', { name: 'Confirm step 2 of 3' }).waitFor({ timeout: 20000 });
    assert.equal(await page.evaluate(() => window.__wallet.sends.length), 1);
    results.push({ name: 'ambiguous-broadcast-reload-reconciles-from-snapshot', passed: true });
    await context.close();
  }
  // A wallet error before anything was broadcast: the unchanged nonce proves it, and a real retry is offered.
  {
    const { context, page } = await fixture({ width: 390, height: 844 });
    await page.goto(`${base}/account?resume=fixture-offer`);
    await page.getByRole('button', { name: 'Prepare wallet steps' }).click();
    await page.getByRole('button', { name: 'Confirm step 1 of 3' }).click();
    await page.getByRole('dialog', { name: 'Wallet confirmation fixture' }).waitFor();
    await page.evaluate(() => { window.__wallet.dropped = true; });
    await page.getByRole('button', { name: 'Confirm fixture' }).click();
    await page.getByRole('button', { name: 'Try again' }).waitFor({ timeout: 20000 });
    await page.getByText(/nothing left your account, so nothing was sent/).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Transaction hash from wallet activity' }).count(), 0);
    assert.equal(await page.evaluate(() => window.__wallet.sends.length), 0);
    await snap(page, 'mobile', 'dropped-send-retry');
    await page.evaluate(() => { window.__wallet.dropped = false; });
    await page.getByRole('button', { name: 'Try again' }).click();
    await page.getByRole('button', { name: 'Confirm fixture' }).click();
    await page.getByRole('button', { name: 'Confirm step 2 of 3' }).waitFor();
    assert.equal(await page.evaluate(() => window.__wallet.sends.length), 1);
    results.push({ name: 'wallet-error-before-broadcast-offers-real-retry', passed: true });
    await context.close();
  }
}

async function testSignedOutSettle() {
  const stranger = '0x4444444444444444444444444444444444444444';
  const due = { jobStatus: 'submitted', boardStatus: 'submitted', reviewEndsAt: now - 600, you: [], session: false };
  // No wallet yet: the permissionless step is a sign-in, never a button that does nothing.
  {
    const { context, page } = await fixture({ width: 390, height: 844 }, { ...due, connected: false });
    await page.goto(`${base}/job/60`);
    await page.getByRole('button', { name: 'Sign in to release the payment' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Release the payment', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Sign in to release the payment' }).click();
    assert.equal(await page.evaluate(() => window.__privyLogins), 1);
    await snap(page, 'mobile', 'signed-out-settle');
    await context.close();
  }
  // A wallet that has not signed in to the board: sign in, then the real action sends.
  {
    const { context, page, state } = await fixture({ width: 390, height: 844 }, { ...due, address: stranger });
    await page.goto(`${base}/job/60`);
    const signIn = page.getByRole('button', { name: 'Sign in to release the payment' });
    await signIn.waitFor();
    assert.equal(await page.getByRole('button', { name: 'Release the payment', exact: true }).count(), 0);
    await page.evaluate(() => { window.__wallet.canSign = true; });
    await signIn.click();
    await page.getByRole('button', { name: 'Release the payment', exact: true }).click();
    assert.equal(state.signIns, 1);
    await page.getByRole('button', { name: 'Release the payment', exact: true }).last().click();
    await page.getByRole('button', { name: 'Confirm in your wallet', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm fixture' }).click();
    await page.getByRole('status').filter({ hasText: 'Settled on-chain' }).waitFor();
    assert.equal(await page.evaluate(() => window.__wallet.sends.length), 1);
    results.push({ name: 'signed-out-settle-is-a-sign-in-then-sends', passed: true });
    await context.close();
  }
}

async function testResumeOwner() {
  const { context, page } = await fixture({ width: 390, height: 844 }, { address: `0x${'3'.repeat(40)}` });
  await page.goto(`${base}/account?resume=fixture-offer`);
  await page.getByText(/Only the person who prepared this offer/).first().waitFor();
  assert.equal(await page.getByRole('button', { name: 'Prepare wallet steps' }).count(), 0);
  assert.equal(await page.evaluate(() => window.__wallet.sends.length), 0);
  results.push({ name: 'saved-offer-recovery-requires-original-creator', passed: true });
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
  await page.getByRole('status').filter({ hasText: 'Paid 5 OPEN to Worker #1' }).waitFor();
  assert.equal(await page.evaluate(() => window.__wallet.sends.length), 1);
  assert.equal(await page.getByText('Rejected. The dispute window is open.', { exact: true }).count(), 0);
  results.push({ name: 'conflicting-job-action-is-locked-through-receipt-recovery', passed: true });
  await context.close();
}

async function testFrozenRecovery() {
  const { context, page, state } = await fixture({ width: 390, height: 844 });
  state.deadline = now - 1;
  await page.goto(`${base}/account?resume=fixture-offer`);
  await page.getByText(/expired|delivery deadline has passed/).first().waitFor();
  const prepare = page.getByRole('button', { name: 'Prepare wallet steps' });
  assert.equal(await prepare.isDisabled(), true);
  assert.equal(await page.evaluate(() => window.__wallet.sends.length), 0);
  results.push({ name: 'expired-saved-offer-cannot-publish', passed: true });
  await context.close();
}

async function testRetiredAuthoring() {
  const { context, page } = await fixture({ width: 390, height: 844 });
  await page.goto(`${base}/embed/public?view=publish&title=Original%20offer&brief=Original%20terms&reward=10`);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => window.postMessage({ source: 'sidequest-host', type: 'prefill', payload: { title: 'Changed offer', brief: 'Changed terms', reward: '999', mode: 'contest' } }, '*'));
  assert.equal(await page.locator('#post-title').count(), 0);
  assert.equal(await page.getByRole('button', { name: /Confirm step|Review|Ask for quotes/ }).count(), 0);
  assert.equal(await page.evaluate(() => window.__wallet.sends.length), 0);
  await page.goto(`${base}/publish`);
  await page.getByRole('heading', { name: 'Page not found' }).waitFor();
  results.push({ name: 'retired-form-and-embed-prefill-cannot-author-or-publish', passed: true });
  await context.close();
}

async function testStaleBoardDetail() {
  const { context, page, state } = await fixture({ width: 390, height: 844 }, { jobStatus: 'active', boardStatus: 'active' });
  await page.goto(`${base}/job/60`);
  await page.getByText(/Locked in escrow/).first().waitFor();
  state.taskError = true;
  state.jobStatus = 'completed';
  await page.getByText(/Showing indexed chain facts instead/).waitFor({ timeout: 45000 });
  await page.getByText('Paid to Worker #1', { exact: true }).waitFor();
  assert.equal(await page.getByText(/Locked in escrow/).count(), 0);
  state.taskError = false;
  state.boardStatus = 'completed';
  await page.getByRole('button', { name: 'Retry offer details' }).click();
  await page.getByText(/Showing indexed chain facts instead/).waitFor({ state: 'hidden' });
  results.push({ name: 'stale-board-active-never-overrides-fresh-chain-completion', passed: true });
  await context.close();
}

async function testChainDetailFailureWithBoardData() {
  const { context, page, state } = await fixture({ width: 390, height: 844 }, { jobStatus: 'submitted', boardStatus: 'submitted' });
  await page.goto(`${base}/job/60`);
  await page.getByText(/Locked in escrow/).first().waitFor();
  state.detailError = true;
  await page.getByText('Chain job details are unavailable.', { exact: false }).waitFor({ timeout: 45000 });
  await page.getByText(/Showing last-known indexed facts/).waitFor();
  assert.equal(await page.getByText(/Locked in escrow/).count() > 0, true);
  assert.equal(await page.getByRole('button', { name: /Approve and pay 5 OPEN/ }).isDisabled(), true);
  state.detailError = false;
  state.jobStatus = 'completed';
  state.boardStatus = 'completed';
  await page.getByRole('button', { name: 'Retry job details' }).click();
  await page.getByText('Paid to Worker #1', { exact: true }).waitFor();
  results.push({ name: 'chain-detail-failure-keeps-board-pauses-actions-and-recovers-on-retry', passed: true });
  await context.close();
}

async function testLongToken() {
  const { context, page } = await fixture({ width: 390, height: 844 }, { tokenSymbol: 'LONG'.repeat(30), tokenDecimals: 0 });
  await page.goto(`${base}/jobs`);
  await page.getByText(`5,000,000 ${'LONG'.repeat(30)}`, { exact: true }).waitFor();
  await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
  const bounds = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, outside: [...document.querySelectorAll('body *')].filter((element) => element.getBoundingClientRect().right > document.documentElement.clientWidth).map((element) => ({ tag: element.tagName, className: element.className, text: element.textContent?.slice(0, 80), right: element.getBoundingClientRect().right })) }));
  await snap(page, 'mobile', 'long-token-200pct');
  assert.ok(bounds.scroll <= bounds.client, JSON.stringify(bounds));
  results.push({ name: 'long-token-zero-decimal-row-200pct-contained', passed: true });
  await context.close();
}

try {
  // One case by name (`node test/ux.e2e.mjs <dir> uncertain-send`), or all of them.
  const only = { 'long-token': testLongToken, 'uncertain-send': testUncertainSend, 'signed-out-settle': testSignedOutSettle, 'resume-owner': testResumeOwner,
    'conflicting-actions': testConflictingActions, 'frozen-recovery': testFrozenRecovery, 'retired-authoring': testRetiredAuthoring,
    'stale-board-detail': testStaleBoardDetail, 'chain-detail-failure': testChainDetailFailureWithBoardData }[process.argv[3] ?? ''];
  if (only !== undefined) {
    await only();
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
    await testSignedOutSettle();
    await testResumeOwner();
    await testConflictingActions();
    await testFrozenRecovery();
    await testRetiredAuthoring();
    await testStaleBoardDetail();
    await testChainDetailFailureWithBoardData();
    await testLongToken();
  }
  assert.deepEqual(failures, []);
  console.log(`PASS: ${results.length} browser evidence records`);
} finally {
  mkdirSync(output, { recursive: true });
  writeFileSync(`${output}/e2e.json`, JSON.stringify({ results, failures }, null, 2));
  await browser.close();
  await server.close();
}

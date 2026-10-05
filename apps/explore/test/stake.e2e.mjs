import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

// Mocked Chromium only: the real SDK reads encoded responses from a test-only RPC transport.
const directory = fileURLToPath(new URL('.', import.meta.url));
const output = process.argv[2] ?? '/tmp/hireling-delegation-evidence';
const base = 'http://127.0.0.1:5194';
const owner = '0x1111111111111111111111111111111111111111';
const agentWallet = '0x2222222222222222222222222222222222222222';
const other = '0x3333333333333333333333333333333333333333';
const contracts = { factory: '0xf000000000000000000000000000000000000001', vault: '0xf000000000000000000000000000000000000002', feeSchedule: '0xf000000000000000000000000000000000000003', distributor: '0xf000000000000000000000000000000000000004', miningReserve: '0xf000000000000000000000000000000000000005', holding: '0xf000000000000000000000000000000000000006', evaluator: '0xf000000000000000000000000000000000000007', safe: '0xf000000000000000000000000000000000000008' };
const agent = { chainId: 10143, identityRegistry: contracts.factory, agentId: '1942', wallet: agentWallet, profile: { name: 'My worker', description: 'Fixture worker', services: [] }, profileSource: 'operator-supplied', agentURI: '', enrolled: true, ownership: 'verified', presence: { freshness: 'fresh', state: 'available', accepting: true, lastSeenBucket: null }, ads: [], observedAt: 100, projectionAt: 100, revision: 1 };
const errors = [];
const results = [];
process.env.PRIVY_APP_ID = 'fixture-privy-app-id';
const server = await createServer({ envFile: false, server: { host: '127.0.0.1', port: 5194, strictPort: true }, plugins: [{ name: 'delegation-fixtures', enforce: 'pre', resolveId(source) {
  if (source === 'wagmi') return `${directory}stake-wagmi.mjs`;
  if (source === 'wagmi/actions') return `${directory}wagmi-actions.mjs`;
  if (source.endsWith('/stake-context.ts')) return `${directory}stake-chain.mjs`;
  if (source.endsWith('/Privy.tsx')) return `${directory}privy.mjs`;
  if (source === '@privy-io/react-auth') return `${directory}privy-react-auth.mjs`;
}, transform(source, id) {
  if (id.endsWith('/src/hireling.ts')) return source.replace(/export const hireling: HirelingContracts \| null =[\s\S]*?(\n\n|\n?$)/, 'export const hireling: HirelingContracts | null = (window as { __hireling?: HirelingContracts | null }).__hireling ?? null$1');
} }] });
await server.listen();
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/home/kristjan/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome' });
mkdirSync(output, { recursive: true });

async function fixture(viewport, options = {}) {
  const context = await browser.newContext({ viewport, hasTouch: viewport.width === 390, isMobile: viewport.width === 390 });
  await context.addInitScript(({ owner, agentWallet, other, contracts, agent, options }) => {
    const E = 10n ** 18n;
    window.__hireling = options.deployed === false ? null : contracts;
    window.__agents = [agent];
    window.__wallet = { address: owner, connected: options.connected ?? true, signatures: [], sends: [] };
    window.__stake = { wallet: 50000n * E, nonce: 0n, calls: [], cooldown: 600, down: options.down ?? false, open: options.open ?? true, pools: {
      [owner]: { assets: 4000n * E, reserved: 1500n * E, shares: 4000n * E, queuedShares: 0n, generation: 0n, positions: { [owner]: { shares: 4000n * E, queuedShares: 0n, unlockAt: 0, generation: 0n } } },
      [agentWallet]: { assets: 10000n * E, reserved: 8000n * E, shares: 10000n * E, queuedShares: 0n, generation: 0n, positions: { [owner]: { shares: 6000n * E, queuedShares: 0n, unlockAt: 0, generation: 0n }, [other]: { shares: 4000n * E, queuedShares: 0n, unlockAt: 0, generation: 0n } } },
    } };
    if (options.proposal) window.__stake.proposal = options.proposal;
    if (options.retired) {
      const pool = window.__stake.pools[agentWallet];
      Object.assign(pool, { assets: 0n, reserved: 0n, shares: 0n, queuedShares: 0n, generation: 1n });
      window.__stake.historical = { [agentWallet]: '0' };
    }
    if (options.dust) {
      const pool = window.__stake.pools[agentWallet];
      Object.assign(pool, { assets: 6n, shares: 10n, reserved: 0n });
      pool.positions[owner].shares = 4n;
      pool.positions[other].shares = 6n;
    }
    localStorage.setItem('agent-jobs.session', 'fixture-only-not-a-real-session');
    localStorage.setItem('agent-jobs.session-owner', JSON.stringify({ address: owner, expiresAt: Math.floor(Date.now() / 1000) + 86400 }));
  }, { owner, agentWallet, other, contracts, agent, options });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort('blockedbyclient');
    const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/__test/receipt') return reply({ status: 'success' });
    if (url.pathname === '/data/directory') return reply({ ok: true, agents: [agent], nextCursor: null, observedAt: 100, chainId: 10143, identityRegistry: contracts.factory, scope: 'fixture' });
    if (url.pathname === '/data/directory/1942') return reply({ ok: true, agent });
    if (url.pathname === '/data/agents/1942') return reply({ ok: false, message: 'Fixture has no job history' }, 404);
    if (url.pathname === '/api/agents/managed') return reply({ ok: true, result: { allowances: [], grants: [], revocation: {} } });
    if (url.pathname === '/api/agents/managed/recovery') return reply({ ok: true, result: { grants: [] } });
    if (url.pathname === '/api/agents' && route.request().method() === 'POST') return reply({ ok: true, result: { id: 'managed', name: 'My worker', address: agentWallet, agent_id: '1942', state: 'active' } });
    if (url.pathname === '/api/agents') return reply({ ok: true, result: { agents: [{ id: 'managed', name: 'My worker', address: agentWallet, agent_id: '1942', state: 'active' }] } });
    if (url.pathname === '/data/delegations' || url.pathname.startsWith('/data/backing/')) {
      const down = await page.evaluate(() => window.__stake.down);
      if (down) return reply({ ok: false, message: 'Fixture index unavailable' }, 503);
      const snapshot = await page.evaluate(({ account, wallet }) => window.__stakingSnapshot(account, wallet), {
        account: url.pathname.startsWith('/data/backing/') ? url.pathname.split('/').at(-1) : undefined,
        wallet: url.searchParams.get('wallet') ?? undefined,
      });
      return reply({ ok: true, ...snapshot });
    }
    if (url.pathname.startsWith('/data/')) return reply({ ok: true, agents: [], jobs: [], boards: [] });
    if (url.pathname.endsWith('/api/task_index')) return reply({ ok: true, result: [] });
    if (url.pathname.includes('/api/')) return reply({ ok: false, message: 'Fixture denies this operation' }, 400);
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  return { context, page };
}
const text = (page, value) => page.getByText(value, { exact: true }).first().waitFor();
const position = page => page.getByRole('article', { name: 'Position in My worker', exact: true });
const amount = page => page.locator('#stake-amount');
async function capture(page, name) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}: horizontal overflow`);
  await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
}
async function confirm(page, message) {
  await page.getByRole('button', { name: 'Confirm in your wallet', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm fixture' }).click();
  await page.getByRole('status').filter({ hasText: message }).waitFor();
}
async function refresh(page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}
try {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    const name = viewport.width === 390 ? 'mobile' : 'desktop';
    const { context, page } = await fixture(viewport);
    await page.goto(`${base}/me`);
    await page.getByRole('link', { name: /Stake & delegate/ }).click();
    await page.waitForURL('**/stake');
    await text(page, '50,000 FACTORY');
    await position(page).getByText('6,000 FACTORY', { exact: true }).waitFor();
    await position(page).getByText('60 % of total backing', { exact: true }).waitFor();
    await text(page, 'If the agent is slashed for bad work, everyone backing it loses the same share. Your FACTORY stays at risk until you withdraw. Leaving starts a 10-minute wait on testnet (7 days on mainnet); if the agent still has open jobs bonded against its backing, withdrawal waits until they settle.');
    assert.ok((await page.locator('article[aria-label^="Position in"]').first().innerText()).includes('My worker'), 'operator agent position first');
    await capture(page, `${name}-positions`);
    await page.getByRole('combobox', { name: 'Agent to back' }).selectOption(agentWallet);
    await amount(page).fill('60000');
    await text(page, 'That is more FACTORY than your wallet holds.');
    assert.equal(await page.getByRole('button', { name: 'Delegate 60,000 FACTORY', exact: true }).isDisabled(), true);
    await amount(page).fill('1000');
    await page.evaluate(() => { window.__wallet.declineSign = true; });
    await page.getByRole('button', { name: 'Delegate 1,000 FACTORY', exact: true }).click();
    await text(page, 'You cancelled in your wallet. Nothing was sent.');
    assert.equal(await page.evaluate(() => window.__wallet.sends.length), 0);
    await page.evaluate(() => { window.__wallet.declineSign = false; });
    await page.getByRole('button', { name: 'Delegate 1,000 FACTORY', exact: true }).click();
    await page.getByRole('heading', { name: 'Confirm your position action' }).waitFor();
    const permit = await page.evaluate(() => { const p = window.__wallet.signatures.at(-1); return { owner: p.message.owner, spender: p.message.spender, amount: String(p.message.value) }; });
    assert.deepEqual(permit, { owner, spender: contracts.vault, amount: (1000n * 10n ** 18n).toString() });
    await capture(page, `${name}-delegation-review`);
    await page.reload();
    await page.getByRole('heading', { name: 'Confirm your position action' }).waitFor();
    await confirm(page, 'Delegated. You own the position.');
    await position(page).getByText('7,000 FACTORY', { exact: true }).waitFor();
    const call = await page.evaluate(() => window.__stake.calls.at(-1));
    assert.equal(call.functionName, 'delegateWithPermit');
    assert.equal(call.args[0], agentWallet);
    // Queue the entire owned position despite 8,000 reserved and only 3,000 available.
    await position(page).getByRole('button', { name: 'Leave', exact: true }).click();
    await page.getByRole('button', { name: 'Max', exact: true }).click();
    assert.equal(await amount(page).inputValue(), '7000');
    await page.getByRole('button', { name: 'Leave 7,000 FACTORY', exact: true }).click();
    await confirm(page, 'Leaving started. Your position stays at risk.');
    await position(page).getByText('Leaving', { exact: true }).waitFor();
    assert.equal(await position(page).getByRole('button', { name: 'Withdraw', exact: true }).isDisabled(), true);
    await capture(page, `${name}-leaving`);
    // Slash reaches the queued shares pro-rata; mature withdrawal remains blocked by the remaining bond.
    await page.evaluate(({ account }) => {
      const pool = window.__stake.pools[account];
      pool.assets -= 2000n * 10n ** 18n;
      pool.reserved -= 2000n * 10n ** 18n;
      pool.positions[window.__wallet.address].unlockAt = Math.floor(Date.now() / 1000) - 1;
    }, { account: agentWallet });
    await refresh(page);
    await position(page).getByText('Waiting for bonds to clear', { exact: true }).waitFor();
    const value = await page.evaluate(({ account }) => { const pool = window.__stake.pools[account]; return String(pool.positions[window.__wallet.address].shares * pool.assets / pool.shares); }, { account: agentWallet });
    assert.equal(value, (7000n * 10n ** 18n * 9000n / 11000n).toString());
    assert.equal(await position(page).getByRole('button', { name: 'Withdraw', exact: true }).isDisabled(), true);
    await capture(page, `${name}-queued-slash-bonds`);
    await position(page).getByRole('button', { name: 'Cancel leaving', exact: true }).click();
    await confirm(page, 'Leaving cancelled. Your backing is active again.');
    await position(page).getByText('Active', { exact: true }).waitFor();
    await position(page).getByRole('button', { name: 'Leave', exact: true }).click();
    await page.getByRole('button', { name: 'Max', exact: true }).click();
    await page.getByRole('button', { name: /^Leave .* FACTORY$/ }).click();
    await confirm(page, 'Leaving started. Your position stays at risk.');
    assert.equal((await page.evaluate(() => window.__stake.calls.at(-1))).args[1], (7000n * 10n ** 18n).toString(), 'MAX owns all shares after rounding');
    await page.evaluate(({ account }) => { const pool = window.__stake.pools[account]; pool.reserved = 0n; pool.positions[window.__wallet.address].unlockAt = Math.floor(Date.now() / 1000) - 1; }, { account: agentWallet });
    await refresh(page);
    await position(page).getByText('Ready to withdraw', { exact: true }).waitFor();
    await position(page).getByRole('button', { name: 'Withdraw', exact: true }).click();
    await confirm(page, 'Withdrawn to your wallet.');
    await position(page).getByText('Exited', { exact: true }).waitFor();
    const balances = await page.evaluate(({ account }) => ({ wallet: String(window.__stake.wallet), other: String(window.__stake.pools[account].positions['0x3333333333333333333333333333333333333333'].shares) }), { account: agentWallet });
    assert.equal(balances.wallet, (49000n * 10n ** 18n + BigInt(value)).toString());
    assert.equal(balances.other, (4000n * 10n ** 18n).toString());
    results.push({ name, checks: ['operator-owned position first', 'position values and percentage', 'permit ownership and target', 'reserved-bond full queue', 'queued pro-rata slash', 'StillBonded display', 'cancel', 'MAX rounding', 'post-cooldown payout to owner'], passed: true });
    await context.close();
  }
  {
    const { context, page } = await fixture({ width: 390, height: 844 }, { dust: true });
    await page.goto(`${base}/stake?account=${agentWallet}`);
    await position(page).waitFor();
    await page.getByRole('radio', { name: 'Leave', exact: true }).click();
    await page.getByRole('button', { name: 'Max', exact: true }).click();
    assert.equal(await amount(page).inputValue(), '0.000000000000000002');
    await page.getByRole('button', { name: /^Leave .* FACTORY$/ }).click();
    await confirm(page, 'Leaving started. Your position stays at risk.');
    assert.equal((await page.evaluate(() => window.__stake.calls.at(-1))).args[1], '4');
    await context.close();
    results.push({ checks: ['2-wei MAX queues all 4 owned shares rather than partial floor(2*10/6)=3'], passed: true });
  }
  {
    const { context, page } = await fixture({ width: 390, height: 844 }, { retired: true });
    await page.goto(`${base}/stake`);
    await position(page).getByText('Lost in a full slash', { exact: true }).waitFor();
    assert.equal(await position(page).getByRole('button', { name: 'Leave', exact: true }).count(), 0);
    await capture(page, 'retired-generation');
    await context.close();
    results.push({ checks: ['retired generation zero value cannot exit twice'], passed: true });
  }
  {
    const { context, page } = await fixture({ width: 390, height: 844 }, { down: true });
    await page.goto(`${base}/stake`);
    await text(page, 'Your positions could not be read. This does not mean they are gone.');
    assert.equal(await page.getByRole('button', { name: 'Delegate', exact: true }).isDisabled(), true);
    await page.evaluate(() => { window.__stake.down = false; });
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await position(page).getByText('6,000 FACTORY', { exact: true }).waitFor();
    await page.evaluate(() => { window.__stake.down = true; });
    await refresh(page);
    await text(page, 'Showing last-known positions. Actions are paused until chain facts refresh.');
    assert.equal(await position(page).getByRole('button', { name: 'Leave', exact: true }).isDisabled(), true);
    await context.close();
    results.push({ checks: ['unavailable reads', 'retry', 'stale facts disable actions'], passed: true });
  }
  for (const options of [{ deployed: false }, { connected: false }, { open: false }]) {
    const { context, page } = await fixture({ width: 390, height: 844 }, options);
    await page.goto(`${base}/stake`);
    if (options.deployed === false) await page.getByText(/Backing is not on .* yet/).waitFor();
    if (options.connected === false) await text(page, 'Sign in to see your positions');
    if (options.open === false) { await page.getByText(/Delegating opens at launch/).waitFor(); assert.equal(await page.getByRole('button', { name: 'Delegate', exact: true }).isDisabled(), true); }
    await context.close();
  }
  {
    const { context, page } = await fixture({ width: 390, height: 844 });
    await page.goto(`${base}/agent/1942`);
    const backing = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Backing', exact: true }) });
    await backing.getByText('10,000 FACTORY', { exact: true }).first().waitFor();
    await backing.getByText('8,000 FACTORY', { exact: true }).waitFor();
    await backing.getByText('2,000 FACTORY', { exact: true }).waitFor();
    await backing.getByText('2', { exact: true }).waitFor();
    await backing.getByRole('heading', { name: 'Top delegators' }).waitFor();
    await backing.getByText('6,000 FACTORY · 60 %', { exact: true }).waitFor();
    await capture(page, 'agent-backing');
    await backing.getByRole('link', { name: 'Delegate', exact: true }).click();
    await page.waitForURL('**/stake?account=*');
    assert.equal(await page.getByRole('combobox', { name: 'Agent to back' }).inputValue(), agentWallet);
    await page.goto(`${base}/workspace`);
    await text(page, 'This agent does not own a position. Operator backing belongs to the operator wallet.');
    assert.equal(await page.getByRole('button', { name: 'Request leaving approval' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Withdraw agent-owned position' }).count(), 0);
    await capture(page, 'operator-owned-agent-backing');
    await page.evaluate(({ account }) => {
      const E = 10n ** 18n;
      const pool = window.__stake.pools[account];
      pool.assets += 1000n * E;
      pool.shares += 1000n * E;
      pool.positions[account] = { shares: 1000n * E, queuedShares: 0n, unlockAt: 0, generation: 0n };
    }, { account: agentWallet });
    await refresh(page);
    await page.getByRole('button', { name: 'Request leaving approval' }).waitFor();
    await page.evaluate(({ account }) => {
      const pool = window.__stake.pools[account];
      pool.positions[account].queuedShares = pool.positions[account].shares;
      pool.queuedShares = pool.positions[account].shares;
      pool.positions[account].unlockAt = Math.floor(Date.now() / 1000) - 1;
      pool.reserved = 0n;
    }, { account: agentWallet });
    await refresh(page);
    await page.getByRole('button', { name: 'Withdraw agent-owned position' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Withdraw agent-owned position' }).isDisabled(), false);
    assert.equal(await page.getByRole('button', { name: 'Request leaving approval' }).count(), 0);
    assert.equal(await page.evaluate(() => window.__stake.rpcMethods.includes('eth_getLogs')), false, 'product discovery never scans RPC logs');
    await capture(page, 'agent-owned-mining-withdraw');
    await context.close();
    results.push({ checks: ['public backing values, tier, delegator count and ranking', 'viewer ownership', 'delegate target prefilled', 'operator-only backing has no agent exits', 'agent-owned mining full queue still withdrawable', 'no browser log scans'], passed: true });
  }
  {
    const { context, page } = await fixture({ width: 390, height: 844 });
    await page.goto(`${base}/agents/new`);
    await page.getByRole('button', { name: 'Create agent wallet', exact: true }).click();
    await page.getByRole('heading', { name: 'Delegate backing to this agent' }).waitFor();
    for (const round of [1, 2]) {
      await page.getByRole('textbox', { name: 'FACTORY to delegate to agent' }).fill('1');
      await page.getByRole('button', { name: 'Review delegation', exact: true }).click();
      for (const step of [1, 2]) {
        await page.getByRole('button', { name: `Confirm step ${step} of 2`, exact: true }).click();
        await page.getByRole('button', { name: 'Confirm fixture' }).click();
      }
      await page.getByRole('button', { name: 'Review delegation', exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.__wallet.sends.length), round * 2, 'each repeated amount is a fresh approval and owned delegation');
    }
    await context.close();
    results.push({ checks: ['repeated onboarding delegation has a distinct durable intent and two fresh confirmations'], passed: true });
  }
  {
    const { context, page } = await fixture({ width: 1440, height: 900 });
    const second = await context.newPage();
    second.setDefaultTimeout(20000);
    second.on('pageerror', error => errors.push(error.message));
    await Promise.all([page.goto(`${base}/stake?account=${agentWallet}`), second.goto(`${base}/stake?account=${agentWallet}`)]);
    await Promise.all([amount(page).fill('1'), amount(second).fill('1')]);
    await page.evaluate(() => { window.__wallet.signGate = true; });
    await page.getByRole('button', { name: 'Delegate 1 FACTORY', exact: true }).click();
    await page.waitForFunction(() => window.__wallet.signatures.length === 1 && window.__releasePermit !== undefined);
    await second.getByRole('button', { name: 'Delegate 1 FACTORY', exact: true }).click();
    await second.waitForFunction(async () => (await navigator.locks.query()).pending.some(lock => lock.name.includes('vault:')));
    assert.equal(await second.evaluate(() => window.__wallet.signatures.length), 0, 'second tab waits before signing');
    await page.evaluate(() => window.__releasePermit());
    await page.getByRole('heading', { name: 'Confirm your position action' }).waitFor();
    await text(second, 'Another Stake tab has an unfinished position action. Reconcile it before starting another.');
    assert.equal(await second.evaluate(() => window.__wallet.signatures.length), 0, 'lock reread prevents a second prepared effect');
    const pointerKey = `hireling.delegation-op:10143:${contracts.vault}:${owner}`;
    const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), pointerKey);
    await page.getByRole('button', { name: 'Not now', exact: true }).waitFor();
    await second.evaluate(({ key, saved }) => localStorage.setItem(key, JSON.stringify({ ...saved, id: 'newer-tab-intent' })), { key: pointerKey, saved });
    await page.getByRole('button', { name: 'Not now', exact: true }).click();
    await text(page, 'A newer position action is saved in another tab; keep it for reconciliation.');
    assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).id, pointerKey), 'newer-tab-intent', 'stale dismissal preserves the new pointer');
    await page.getByRole('button', { name: 'Confirm in your wallet', exact: true }).click();
    await page.getByText(/This position action changed in another tab/).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Confirm fixture', exact: true }).count(), 0, 'stale action cannot open a wallet prompt');
    assert.equal(await page.evaluate(() => window.__wallet.sends.length), 0);
    await context.close();
    results.push({ checks: ['two origin-sharing tabs serialize preparation and permit signing', 'persisted intent reread under Web Lock', 'stale Not now compare-delete', 'stale prepared send blocked'], passed: true });
  }
  assert.deepEqual(errors, []);
  writeFileSync(`${output}/results.json`, JSON.stringify({ tier: 'mocked Chromium only; no live vault, signing or sends', results, errors }, null, 2));
  console.log(`PASS: delegated staking, ${results.length} evidence records`);
} catch (error) {
  for (const context of browser.contexts()) for (const page of context.pages()) {
    console.error((await page.locator("body").innerText()).slice(-5000));
    await page.screenshot({ path: `${output}/failure.png`, fullPage: true });
  }
  throw error;
} finally {
  await browser.close();
  await server.close();
}

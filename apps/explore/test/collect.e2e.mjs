import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { encodeFunctionData, parseAbi } from 'viem';
import { createServer } from 'vite';

// The Collect place (U3): five primary tabs, mobile Me -> Collect and desktop Collect counts, the wallet's collect actions from the board, one tap per action
// (the tap opens the wallet), v1 payout calls with their gas limits, a mining claim read back from its calldata
// (U-MINE, B8b), empty, unavailable and signed-out states. Mocked Chromium only: no live board, signing or sends.
const directory = fileURLToPath(new URL('.', import.meta.url));
const output = process.argv[2] ?? '/tmp/hireling-collect-evidence';
const base = 'http://127.0.0.1:5198';
const me = '0x1111111111111111111111111111111111111111';
const config = JSON.parse(readFileSync(new URL('../../../contracts/config/monad-testnet.json', import.meta.url), 'utf8'));
const usd = config.deployment.rewardTokens[0].toLowerCase();
const factory = config.deployment.factory.toLowerCase();
const contracts = { factory: '0xf000000000000000000000000000000000000001', vault: '0xf000000000000000000000000000000000000002', feeSchedule: '0xf000000000000000000000000000000000000003', distributor: '0xf000000000000000000000000000000000000004', miningReserve: '0xf000000000000000000000000000000000000005', holding: '0xf000000000000000000000000000000000000006', evaluator: '0xf000000000000000000000000000000000000007', safe: '0xf000000000000000000000000000000000000008' };
const holdingAbi = parseAbi(['function settle(uint256 jobId)', 'function claimTopUpRefund(uint256 jobId, address contributor)']);
const claimAbi = parseAbi(['function claim(uint256 epoch, address account, uint256 amount, bytes32[] proof)']);
/** Epoch 0's mining claim for `account`, as the board's collect_actions builds it (B8b): EpochDistributor.claim, 500k gas. */
const miningClaim = (account) => ({
  kind: 'miningClaim', epoch: '0', token: factory, amount: (1234n * 10n ** 18n).toString(), description: 'Claim work mining into your FACTORY stake.',
  transactions: [{ ...tx('Claim work mining into your FACTORY stake', contracts.distributor, encodeFunctionData({ abi: claimAbi, functionName: 'claim', args: [0n, account, 1234n * 10n ** 18n, [`0x${'aa'.repeat(32)}`]] })), gas: '500000' }],
});
const tx = (description, to, data) => ({ description, chainId: 10143, to, data, value: '0' });
const ACTIONS = [
  { kind: 'settle', jobId: '72', description: 'The rejection is final: this releases the escrow and the bonds.', transactions: [tx('Settle job #72', contracts.holding, encodeFunctionData({ abi: holdingAbi, functionName: 'settle', args: [72n] }))] },
  { kind: 'claimTopUpRefund', jobId: '71', token: usd, amount: '2000000', description: 'The creator was refunded, so your top-up comes back to you.', transactions: [tx('Claim your top-up back', contracts.holding, encodeFunctionData({ abi: holdingAbi, functionName: 'claimTopUpRefund', args: [71n, me] }))] },
  { kind: 'stakeWithdraw', token: factory, amount: (2000n * 10n ** 18n).toString(), description: 'Your unstaking cooldown has ended.', transactions: [tx('Withdraw unstaked FACTORY', contracts.vault, '0x3ccfd60b')] },
];
const results = [];
const errors = [];

process.env.PRIVY_APP_ID = 'fixture-privy-app-id';
const server = await createServer({ envFile: false, server: { host: '127.0.0.1', port: 5198, strictPort: true }, plugins: [{ name: 'collect-fixtures', enforce: 'pre', resolveId(source) {
  if (source === 'wagmi') return `${directory}wagmi.mjs`;
  if (source === 'wagmi/actions') return `${directory}wagmi-actions.mjs`;
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
  await context.addInitScript(({ account, hireling, session }) => {
    window.__hireling = hireling;
    window.__wallet = { address: account, connected: true, signatures: [], sends: [] };
    if (!session) return;
    localStorage.setItem('agent-jobs.session', 'fixture-only-not-a-real-session');
    localStorage.setItem('agent-jobs.session-owner', JSON.stringify({ address: account, expiresAt: Math.floor(Date.now() / 1000) + 86400 }));
  }, { account: me, hireling: contracts, session: options.session ?? true });
  const state = { actions: options.actions ?? [...ACTIONS], collecting: null, error: options.error ?? false };
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort('blockedbyclient');
    const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/__test/receipt') {
      // The step the test is collecting is mined: the board no longer lists it.
      state.actions = state.actions.filter((a) => a.kind !== state.collecting);
      return reply({ status: 'success' });
    }
    if (url.pathname.endsWith('/api/collect_actions')) {
      assert.deepEqual(route.request().postDataJSON(), { wallet: me });
      return state.error ? reply({ ok: false, message: 'Fixture board unavailable' }, 503) : reply({ ok: true, result: state.actions });
    }
    if (url.pathname === '/data/jobs') return reply({ ok: true, jobs: [], index: { next_block: 100, updated_at: Math.floor(Date.now() / 1000) } });
    if (url.pathname === '/data/stats') return reply({ ok: true, jobs: 0, completed: 0, agents: 0, activity: { demo: 0, unclassified: 0, independent: null }, accounting: {} });
    if (url.pathname.startsWith('/data/')) return reply({ ok: true, agents: [], jobs: [], boards: [] });
    if (url.pathname.endsWith('/api/task_index')) return reply({ ok: true, result: [] });
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

const lastSend = (page) => page.evaluate(() => { const t = window.__wallet.sends.at(-1); return { to: t.to.toLowerCase(), gas: t.gas === undefined ? null : String(t.gas) }; });

try {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    const device = viewport.width === 390 ? 'mobile' : 'desktop';
    const { context, page, state } = await fixture(viewport);
    await page.goto(`${base}/jobs`);
    const nav = viewport.width === 390 ? page.getByRole('navigation', { name: 'Sections' }).last() : page.getByRole('complementary', { name: 'Sections' });
    await nav.getByLabel('3 to collect').waitFor();
    const collectNav = viewport.width === 390 ? null : nav.getByRole('link', { name: /Collect/ });
    if (collectNav !== null) await collectNav.getByLabel('3 to collect').waitFor();
    if (viewport.width === 390) {
      const tabs = await nav.getByRole('link').evaluateAll((links) => links.map((l) => ({ text: l.textContent, width: l.getBoundingClientRect().width, height: l.getBoundingClientRect().height })));
      assert.equal(tabs.length, 5, JSON.stringify(tabs));
      assert.deepEqual(tabs.map((t) => t.text?.replace(/3$/, '')), ['Home', 'Jobs', 'Workspace', 'Approvals', 'Me']);
      assert.ok(tabs.every((t) => t.width >= 44 && t.height >= 44), JSON.stringify(tabs));
    }
    if (viewport.width === 390) {
      await nav.getByRole('link', { name: /^Me/ }).click();
      const mobileCollect = page.getByRole('main').getByRole('link', { name: /^Collect/ });
      await mobileCollect.getByLabel('3 to collect').waitFor();
      const target = await mobileCollect.boundingBox();
      assert.ok(target.width >= 44 && target.height >= 44, JSON.stringify(target));
      await mobileCollect.click();
    } else {
      await collectNav.click();
    }
    await page.waitForURL('**/collect');
    await page.getByText('Settle job #72', { exact: true }).waitFor();
    await page.getByText('Your top-up back from job #71', { exact: true }).waitFor();
    await page.getByText('2 mUSD', { exact: true }).waitFor();
    await page.getByText('2,000 FACTORY', { exact: true }).waitFor();
    await capture(page, `${device}-collect`);

    // One tap opens the wallet; the v1 settle goes out with its gas limit, then leaves the list.
    state.collecting = 'settle';
    await page.getByRole('button', { name: 'Collect', exact: true }).first().click();
    await page.getByRole('button', { name: 'Confirm fixture' }).click();
    await page.getByRole('status').filter({ hasText: 'Settled' }).waitFor();
    assert.deepEqual(await lastSend(page), { to: contracts.holding, gas: '1000000' });
    await page.getByText('Settle job #72', { exact: true }).waitFor({ state: 'hidden' });
    await nav.getByLabel('2 to collect').waitFor();

    state.collecting = 'claimTopUpRefund';
    await page.getByRole('button', { name: 'Collect', exact: true }).first().click();
    await page.getByRole('button', { name: 'Confirm fixture' }).click();
    await page.getByRole('status').filter({ hasText: 'Top-up refunded' }).waitFor();
    assert.deepEqual(await lastSend(page), { to: contracts.holding, gas: '450000' });

    // A declined wallet leaves the action listed, with a retry.
    state.collecting = 'stakeWithdraw';
    await page.getByRole('button', { name: 'Collect', exact: true }).first().click();
    await page.getByRole('button', { name: 'Decline fixture' }).click();
    await page.getByRole('button', { name: 'Try again' }).waitFor();
    await page.getByRole('button', { name: 'Try again' }).click();
    await page.getByRole('button', { name: 'Confirm fixture' }).click();
    await page.getByRole('status').filter({ hasText: 'Withdrawn to your wallet' }).waitFor();
    assert.deepEqual(await lastSend(page), { to: contracts.vault, gas: null });
    await page.getByText('Nothing to collect', { exact: true }).waitFor();
    assert.equal(await nav.getByLabel(/to collect/).count(), 0);
    assert.equal(await page.evaluate(() => window.__wallet.sends.length), 3);
    results.push({ device, checks: ['five primary tabs at least 44 px', device === 'mobile' ? 'Me -> Collect with count and 44 px target' : 'secondary Collect link with count', 'count badge updates after collection', 'list from collect_actions', 'one tap opens the wallet', 'settle 1M gas', 'top-up refund 450k gas', 'decline then retry', 'empty after collecting'], passed: true });
    await context.close();
  }

  // A mining reward (U-MINE): the claim reads back as the distributor's, for this wallet, epoch and amount, and says
  // the reward is staked. One tap sends it from the wallet (the distributor is outside the D15 sponsorship allowlist).
  // A claim whose calldata names another wallet is shown but not offered.
  {
    const { context, page, state } = await fixture({ width: 390, height: 844 }, { actions: [miningClaim(me), { ...miningClaim('0x2222222222222222222222222222222222222222'), epoch: '1', transactions: miningClaim('0x2222222222222222222222222222222222222222').transactions.map((t) => ({ ...t, data: encodeFunctionData({ abi: claimAbi, functionName: 'claim', args: [1n, '0x2222222222222222222222222222222222222222', 1234n * 10n ** 18n, []] }) })) }] });
    await page.goto(`${base}/collect`);
    await page.getByText('Mining reward, epoch 0 · 1,234 FACTORY, staked when collected', { exact: true }).waitFor();
    await page.getByText('Mining reward, epoch 1', { exact: true }).waitFor();
    await page.getByRole('alert').filter({ hasText: 'Not offered: It would stake the reward for another wallet.' }).waitFor();
    // Rows in the board's order: epoch 0 (this wallet's) first, then the refused one.
    const collect = page.getByRole('button', { name: 'Collect', exact: true });
    assert.equal(await collect.nth(1).isDisabled(), true);
    await capture(page, 'collect-mining');
    state.collecting = 'miningClaim';
    await collect.first().click();
    await page.getByRole('button', { name: 'Confirm fixture' }).click();
    await page.getByRole('status').filter({ hasText: 'Claimed into your stake' }).waitFor();
    assert.deepEqual(await lastSend(page), { to: contracts.distributor, gas: '500000' });
    assert.equal(await page.evaluate(() => window.__wallet.sends.length), 1);
    await page.getByText('Nothing to collect', { exact: true }).waitFor();
    await context.close();
    results.push({ checks: ['mining claim row: "Mining reward, epoch 0 · 1,234 FACTORY, staked when collected"', 'claim read back from calldata: distributor, epoch, amount, this wallet', 'claim naming another wallet shown, not offered', 'one tap: wallet sends EpochDistributor.claim with 500k gas'], passed: true });
  }

  {
    const { context, page } = await fixture({ width: 390, height: 844 }, { error: true });
    await page.goto(`${base}/collect`);
    await page.getByText('What you can collect cannot be read right now. This does not mean there is nothing waiting for you.', { exact: true }).waitFor();
    assert.equal(await page.getByText('Nothing to collect', { exact: true }).count(), 0);
    await capture(page, 'collect-unavailable');
    await context.close();
    const signedOut = await fixture({ width: 390, height: 844 }, { session: false });
    await signedOut.page.goto(`${base}/collect`);
    await signedOut.page.getByText('Sign in to see what you can collect', { exact: true }).waitFor();
    await signedOut.context.close();
    results.push({ checks: ['unavailable is not empty', 'signed out asks to sign in'], passed: true });
  }
  assert.deepEqual(errors, []);
  writeFileSync(`${output}/results.json`, JSON.stringify({ tier: 'mocked Chromium only; no live board, signing or sends', results, errors }, null, 2));
  console.log(`PASS: collect, ${results.length} evidence records`);
} finally {
  await browser.close();
  await server.close();
}

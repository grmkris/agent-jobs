import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

// The stake page (U2) against a fixture vault, fee schedule and FACTORY v2 (stake-wagmi.mjs): stake with a permit,
// the fee tier and the next one, reserved stake that cannot be unstaked, the cooldown with its countdown, cancel and
// withdraw; a chain that does not answer, v1 not deployed, signed out. Mocked Chromium only: no signing or sends.
const directory = fileURLToPath(new URL('.', import.meta.url));
const output = process.argv[2] ?? '/tmp/hireling-stake-evidence';
const base = 'http://127.0.0.1:5194';
const owner = '0x1111111111111111111111111111111111111111';
const contracts = { factory: '0xf000000000000000000000000000000000000001', vault: '0xf000000000000000000000000000000000000002', feeSchedule: '0xf000000000000000000000000000000000000003', distributor: '0xf000000000000000000000000000000000000004', miningReserve: '0xf000000000000000000000000000000000000005', holding: '0xf000000000000000000000000000000000000006', evaluator: '0xf000000000000000000000000000000000000007', safe: '0xf000000000000000000000000000000000000008' };
const results = [];
const errors = [];

process.env.PRIVY_APP_ID = 'fixture-privy-app-id';
const server = await createServer({ envFile: false, server: { host: '127.0.0.1', port: 5194, strictPort: true }, plugins: [{ name: 'stake-fixtures', enforce: 'pre', resolveId(source) {
  if (source === 'wagmi') return `${directory}stake-wagmi.mjs`;
  if (source === 'wagmi/actions') return `${directory}wagmi-actions.mjs`;
  if (source.endsWith('/Privy.tsx')) return `${directory}privy.mjs`;
  if (source === '@privy-io/react-auth') return `${directory}privy-react-auth.mjs`;
}, transform(source, id) {
  // v1's addresses come from the test (`window.__hireling`), so one run covers deployed and not deployed.
  if (id.endsWith('/src/hireling.ts')) return source.replace(/export const hireling: HirelingContracts \| null =[\s\S]*?(\n\n|\n?$)/, 'export const hireling: HirelingContracts | null = (window as { __hireling?: HirelingContracts | null }).__hireling ?? null$1');
} }] });
await server.listen();
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/home/kristjan/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome' });
mkdirSync(output, { recursive: true });

async function fixture(viewport, options = {}) {
  const context = await browser.newContext({ viewport, hasTouch: viewport.width === 390, isMobile: viewport.width === 390 });
  await context.addInitScript(({ account, hireling, connected, down, open, proposal, staked, clocks, unreadableClocks }) => {
    const K = 10n ** 21n;
    window.__hireling = hireling;
    window.__wallet = { address: account, connected, signatures: [], sends: [] };
    window.__stake = { wallet: 50n * K, staked: staked === null ? 4n * K : BigInt(staked), reserved: 1500n * 10n ** 18n, unstaking: 0n, unlockAt: 0, nonce: 0n, calls: [], down, open, denied: {}, clocks, unreadableClocks };
    if (proposal !== null) window.__stake.proposal = proposal;
    localStorage.setItem('agent-jobs.session', 'fixture-only-not-a-real-session');
    localStorage.setItem('agent-jobs.session-owner', JSON.stringify({ address: account, expiresAt: Math.floor(Date.now() / 1000) + 86400 }));
  }, { account: owner, hireling: options.deployed === false ? null : contracts, connected: options.connected ?? true, down: options.down ?? false, open: options.open ?? true, proposal: options.proposal ?? null, staked: options.staked ?? null, clocks: options.clocks, unreadableClocks: options.unreadableClocks });
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort('blockedbyclient');
    const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/__test/receipt') return reply({ status: 'success' });
    if (url.pathname === '/data/jobs') return reply({ ok: true, jobs: [], index: { next_block: 100, updated_at: Math.floor(Date.now() / 1000) } });
    if (url.pathname.startsWith('/data/')) return reply({ ok: true, agents: [], jobs: [], boards: [] });
    if (url.pathname.endsWith('/api/task_index')) return reply({ ok: true, result: [] });
    if (url.pathname.includes('/api/')) return reply({ ok: false, message: 'Fixture denies this operation' }, 400);
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  return { context, page };
}

async function capture(page, name) {
  const width = await page.evaluate(() => ({ actual: document.documentElement.scrollWidth, expected: innerWidth }));
  assert.ok(width.actual <= width.expected, `${name}: horizontal overflow`);
  await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
}

const text = (page, value) => page.getByText(value, { exact: true }).first().waitFor();
const confirm = async (page, toast) => {
  await page.getByRole('button', { name: 'Confirm in your wallet', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm fixture' }).click();
  await page.getByRole('status').filter({ hasText: toast }).waitFor();
};
const amount = page => page.locator('#stake-amount');

try {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    const device = viewport.width === 390 ? 'mobile' : 'desktop';
    const { context, page } = await fixture(viewport);
    await page.goto(`${base}/me`);
    await page.getByRole('link', { name: /Stake/ }).first().click();
    await page.waitForURL('**/stake');
    // What is staked, reserved and free, and the tier: all from the reads, the tiers from the fee schedule.
    await text(page, '4,000 FACTORY');
    await text(page, '1,500 FACTORY');
    await text(page, '2,500 FACTORY');
    await text(page, '50,000 FACTORY');
    await text(page, '30 %');
    await page.getByText('Stake 6,000 FACTORY more to pay 10 %.', { exact: false }).waitFor();
    await capture(page, `${device}-stake`);

    // More than the wallet holds is refused before anything is signed.
    await amount(page).fill('60000');
    await page.getByText('That is more FACTORY than your wallet holds.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: /^Stake 60,000/ }).isDisabled(), true);

    // A declined permit sends nothing.
    await amount(page).fill('7000');
    await page.evaluate(() => { window.__wallet.declineSign = true; });
    await page.getByRole('button', { name: 'Stake 7,000 FACTORY', exact: true }).click();
    await page.getByText('You cancelled in your wallet. Nothing was sent.', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__wallet.sends.length), 0);

    // Stake with a permit: one signature for exactly this amount and the vault, then one transaction.
    await page.evaluate(() => { window.__wallet.declineSign = false; });
    await page.getByRole('button', { name: 'Stake 7,000 FACTORY', exact: true }).click();
    const permit = await page.evaluate(() => { const p = window.__wallet.signatures.at(-1); return { type: p.primaryType, spender: p.message.spender, value: String(p.message.value), nonce: String(p.message.nonce), contract: p.domain.verifyingContract }; });
    assert.deepEqual(permit, { type: 'Permit', spender: contracts.vault, value: (7000n * 10n ** 18n).toString(), nonce: '0', contract: contracts.factory });
    await capture(page, `${device}-stake-wallet-step`);
    await confirm(page, 'Staked. Your fee tier counts it now.');
    await text(page, '11,000 FACTORY');
    await text(page, '10 %');
    await page.getByText('Stake 89,000 FACTORY more to pay 3 %.', { exact: false }).waitFor();

    // Reserved stake cannot be unstaked.
    await page.getByRole('radio', { name: 'Unstake' }).click();
    await amount(page).fill('10000');
    await page.getByText(/reserved stake stays until its jobs settle/).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Unstake 10,000 FACTORY' }).isDisabled(), true);

    // Unstake starts the cooldown, with a countdown; withdrawing waits for it; cancelling restakes.
    await amount(page).fill('2000');
    await page.getByText('It stops counting for your fee tier now and can be withdrawn after 7 days. You can cancel until you withdraw.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Unstake 2,000 FACTORY' }).click();
    await confirm(page, 'Unstaking started. The cooldown is running.');
    await page.getByText(/Withdrawable in 6 d 23 h/).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Withdraw', exact: true }).isDisabled(), true);
    await text(page, '9,000 FACTORY');
    await text(page, '30 %');
    await capture(page, `${device}-unstaking`);
    await page.getByRole('button', { name: 'Keep it staked' }).click();
    await confirm(page, 'Unstaking cancelled. It is staked again.');
    await text(page, '11,000 FACTORY');
    assert.equal(await page.getByRole('button', { name: 'Keep it staked' }).count(), 0);

    // After the cooldown, withdraw pays it out to the wallet.
    await page.getByRole('radio', { name: 'Unstake' }).click();
    await amount(page).fill('2000');
    await page.getByRole('button', { name: 'Unstake 2,000 FACTORY' }).click();
    await confirm(page, 'Unstaking started. The cooldown is running.');
    await page.evaluate(() => { window.__stake.unlockAt = Math.floor(Date.now() / 1000) - 1; window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
    await page.getByText('Ready to withdraw', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Withdraw', exact: true }).click();
    await confirm(page, 'Withdrawn to your wallet.');
    await text(page, '45,000 FACTORY');
    assert.deepEqual(await page.evaluate(() => window.__stake.calls), ['stakeWithPermit', 'requestUnstake', 'cancelUnstake', 'requestUnstake', 'withdraw']);

    // A ruling burns the reserved bond: the vault takes it from the stake, so the page shows the stake and the
    // reservation both down by it, and the whole remaining stake can be unstaked.
    await text(page, '9,000 FACTORY');
    await page.evaluate(() => { window.__stake.staked -= 1500n * 10n ** 18n; window.__stake.reserved = 0n; document.dispatchEvent(new Event('visibilitychange')); });
    await page.getByText('9,000 FACTORY', { exact: true }).waitFor({ state: 'detached' });
    await page.getByText('1,500 FACTORY', { exact: true }).waitFor({ state: 'detached' });
    await text(page, '7,500 FACTORY');
    await page.getByRole('radio', { name: 'Unstake' }).click();
    await amount(page).fill('7500');
    assert.equal(await page.getByRole('button', { name: 'Unstake 7,500 FACTORY' }).isDisabled(), false);
    results.push({ device, checks: ['amounts and tiers from reads', 'next tier and amount needed', 'over-balance refused', 'declined permit sends nothing', 'permit for exact amount and vault', 'reserved cannot be unstaked', 'cooldown countdown', 'cancel restakes', 'withdraw after cooldown', 'a burned bond leaves stake and reservation both down'], passed: true });
    await context.close();
  }

  // A Holding the Safe proposed: the staker sees when it can go live and lapse, refuses it, and can allow it again; a
  // refusal of the Holding in use shows with its undo.
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    const device = viewport.width === 390 ? 'mobile' : 'desktop';
    const proposed = '0xf000000000000000000000000000000000000009';
    const { context, page } = await fixture(viewport, { proposal: { holding: proposed, eta: Math.floor(Date.now() / 1000) + 2 * 86400 } });
    await page.goto(`${base}/stake`);
    const section = page.locator('section').filter({ has: page.getByRole('heading', { name: 'A new Holding is proposed', exact: true }) });
    await section.getByText(/^in 1 d 23 h/).waitFor();
    await section.getByText('Expires', { exact: true }).waitFor();
    await section.getByText('unless accepted by then', { exact: true }).waitFor();
    await capture(page, `${device}-holding-proposed`);
    await section.getByRole('button', { name: /let it reserve my stake/ }).click();
    await confirm(page, 'Refused. That Holding can never reserve your stake.');
    await section.getByText('Refused', { exact: true }).waitFor();
    await section.getByRole('button', { name: 'Allow it again' }).click();
    await confirm(page, 'Allowed again. That Holding can reserve your stake for bonds.');
    await section.getByRole('button', { name: /let it reserve my stake/ }).waitFor();
    assert.deepEqual(await page.evaluate(() => ({ calls: window.__stake.calls, denied: window.__stake.denied })), { calls: ['setHoldingDenied', 'setHoldingDenied'], denied: { [proposed]: false } });

    await page.evaluate((holding) => { window.__stake.denied[holding] = true; window.dispatchEvent(new Event('visibilitychange')); }, contracts.holding.toLowerCase());
    await text(page, 'You refused the Holding in use');
    await capture(page, `${device}-holding-refused`);
    await page.getByRole('button', { name: 'Allow it again' }).click();
    await confirm(page, 'Allowed again. That Holding can reserve your stake for bonds.');
    await page.getByText('You refused the Holding in use', { exact: true }).waitFor({ state: 'hidden' });
    results.push({ device, checks: ['proposed Holding with go-live and lapse times', 'refuse sends setHoldingDenied(holding, true)', 'allow again', 'refusal of the Holding in use shows its undo'], passed: true });
    await context.close();
  }

  // Each tier of the schedule (thresholds 0 / 10k / 100k / 1M FACTORY at 30 / 10 / 3 / 1 %): the page names the tier
  // the stake is in and what the next one needs.
  {
    const E = 10n ** 18n;
    for (const [staked, pct, next] of [[2000n * E, '30 %', 'Stake 8,000 FACTORY more to pay 10 %.'], [10_000n * E, '10 %', 'Stake 90,000 FACTORY more to pay 3 %.'], [250_000n * E, '3 %', 'Stake 750,000 FACTORY more to pay 1 %.'], [1_000_000n * E, '1 %', 'You are in the lowest fee tier.']]) {
      const { context, page } = await fixture({ width: 390, height: 844 }, { staked: String(staked) });
      await page.goto(`${base}/stake`);
      const fee = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Your fee as a worker', exact: true }) });
      await fee.getByText(pct, { exact: true }).first().waitFor();
      await fee.getByText(next, { exact: true }).waitFor();
      const mine = await fee.getByText('You', { exact: true }).locator('xpath=ancestor::*[contains(@class, "flex")][1]').innerText();
      assert.ok(mine.includes(pct), `${pct}: the "You" row reads ${mine}`);
      if (pct === '3 %') await capture(page, 'tier-3');
      await context.close();
    }
    results.push({ checks: ['30 % tier', '10 % tier', '3 % tier', '1 % tier (lowest)', 'next tier and amount needed'], passed: true });
  }

  {
    const { context, page } = await fixture({ width: 390, height: 844 }, { down: true });
    await page.goto(`${base}/stake`);
    await page.getByText('Your stake cannot be read from the chain right now. This does not mean it is gone.', { exact: true }).waitFor({ timeout: 20000 });
    assert.equal(await page.getByText('4,000 FACTORY', { exact: true }).count(), 0);
    await page.evaluate(() => { window.__stake.down = false; });
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await text(page, '4,000 FACTORY');
    results.push({ checks: ['unavailable chain shows no numbers, then retry'], passed: true });
    await context.close();
  }
  {
    // Before launch the vault is not bootstrapped: no stake form, a plain note instead of a reverting transaction.
    const { context, page } = await fixture({ width: 390, height: 844 }, { open: false });
    await page.goto(`${base}/stake`);
    await page.getByText('Staking opens at launch', { exact: true }).waitFor();
    await text(page, '30 %');
    assert.equal(await page.locator('#stake-amount').count(), 0);
    assert.equal(await page.getByRole('button', { name: /^Stake/ }).count(), 0);
    await capture(page, 'not-open');
    results.push({ checks: ['vault not bootstrapped: staking opens at launch, no form'], passed: true });
    await context.close();
  }
  {
    const { context, page } = await fixture({ width: 390, height: 844 }, { deployed: false });
    await page.goto(`${base}/stake`);
    await page.getByText(/Staking is not on .* yet/).waitFor();
    await capture(page, 'not-deployed');
    await context.close();
    const signedOut = await fixture({ width: 390, height: 844 }, { connected: false });
    await signedOut.page.goto(`${base}/stake`);
    await signedOut.page.getByText('Sign in to stake', { exact: true }).waitFor();
    await signedOut.context.close();
    results.push({ checks: ['not deployed says so', 'signed out asks to sign in'], passed: true });
  }
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    const { context, page } = await fixture(viewport, { clocks: { unstake: 600, holding: 900, grace: 1800 } });
    await page.goto(`${base}/stake`);
    await page.getByText('Why unstaking waits 10 minutes.', { exact: true }).waitFor();
    await page.getByText(/Adding one takes the Safe 15 minutes, longer than the cooldown\./).waitFor();
    await page.getByRole('radio', { name: 'Unstake', exact: true }).click();
    await amount(page).fill('1');
    await page.getByText('It stops counting for your fee tier now and can be withdrawn after 10 minutes. You can cancel until you withdraw.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Unstake 1 FACTORY', exact: true }).click();
    await confirm(page, 'Unstaking started. The cooldown is running.');
    await page.getByText(/Withdrawable in (9|10) min/).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Withdraw', exact: true }).isDisabled(), true);
    await capture(page, `clocks-${viewport.width}-unstake`);
    await context.close();
    results.push({ width: viewport.width, checks: ['chain-derived 10-minute cooldown and 15-minute Holding delay', 'minute countdown; early withdraw disabled'], passed: true });
  }
  {
    const { context, page } = await fixture({ width: 390, height: 844 }, { unreadableClocks: ['HOLDING_DELAY'] });
    await page.goto(`${base}/stake`);
    await page.getByText(/The Holding admission delay cannot be read from the chain right now\./).waitFor();
    assert.equal((await page.locator('body').innerText()).includes('8 days'), false);
    await context.close();
    results.push({ checks: ['unreadable Holding delay has no fixed fallback'], passed: true });
  }
  assert.deepEqual(errors, []);
  writeFileSync(`${output}/results.json`, JSON.stringify({ tier: 'mocked Chromium only; no live vault, signing or sends', results, errors }, null, 2));
  console.log(`PASS: stake, ${results.length} evidence records`);
} finally {
  await browser.close();
  await server.close();
}

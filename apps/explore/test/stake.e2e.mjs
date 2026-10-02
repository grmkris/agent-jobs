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
  await context.addInitScript(({ account, hireling, connected, down, open }) => {
    const K = 10n ** 21n;
    window.__hireling = hireling;
    window.__wallet = { address: account, connected, signatures: [], sends: [] };
    window.__stake = { wallet: 50n * K, staked: 4n * K, reserved: 1500n * 10n ** 18n, unstaking: 0n, unlockAt: 0, nonce: 0n, calls: [], down, open };
    localStorage.setItem('agent-jobs.session', 'fixture-only-not-a-real-session');
    localStorage.setItem('agent-jobs.session-owner', JSON.stringify({ address: account, expiresAt: Math.floor(Date.now() / 1000) + 86400 }));
  }, { account: owner, hireling: options.deployed === false ? null : contracts, connected: options.connected ?? true, down: options.down ?? false, open: options.open ?? true });
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
    await page.getByRole('button', { name: 'Cancel unstaking' }).click();
    await confirm(page, 'Unstaking cancelled. It is staked again.');
    await text(page, '11,000 FACTORY');
    assert.equal(await page.getByRole('button', { name: 'Cancel unstaking' }).count(), 0);

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
    results.push({ device, checks: ['amounts and tiers from reads', 'next tier and amount needed', 'over-balance refused', 'declined permit sends nothing', 'permit for exact amount and vault', 'reserved cannot be unstaked', 'cooldown countdown', 'cancel restakes', 'withdraw after cooldown'], passed: true });
    await context.close();
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
  assert.deepEqual(errors, []);
  writeFileSync(`${output}/results.json`, JSON.stringify({ tier: 'mocked Chromium only; no live vault, signing or sends', results, errors }, null, 2));
  console.log(`PASS: stake, ${results.length} evidence records`);
} finally {
  await browser.close();
  await server.close();
}

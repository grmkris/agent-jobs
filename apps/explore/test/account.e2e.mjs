import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

// Account UI and clipboard regression proof with fixture APIs/wallet reads only; no real signing, transactions or prices.
const directory = fileURLToPath(new URL('.', import.meta.url));
const output = process.argv[2] ?? '/tmp/sidequest-account-evidence';
const base = 'http://127.0.0.1:5218';
const owner = '0x1111111111111111111111111111111111111111';
const config = JSON.parse(readFileSync(new URL('../../../contracts/config/monad-testnet.json', import.meta.url), 'utf8'));
const side = config.deployment.factory.toLowerCase();
const [musd, meur] = config.deployment.rewardTokens.map((address) => address.toLowerCase());
const usdc = config.x402.usdc.toLowerCase();
const fakeUsdc = '0x00000000000000000000000000000000000fa4e1';
const errors = [];
const results = [];
process.env.PRIVY_APP_ID = 'fixture-privy-app-id';
const server = await createServer({ envFile: false, server: { host: '127.0.0.1', port: 5218, strictPort: true }, plugins: [{ name: 'account-fixtures', enforce: 'pre', resolveId(source) {
  if (source === 'wagmi') return `${directory}account-wagmi.mjs`;
  if (source === 'wagmi/actions') return `${directory}wagmi-actions.mjs`;
  if (source.endsWith('/Privy.tsx')) return `${directory}privy.mjs`;
  if (source === '@privy-io/react-auth') return `${directory}privy-react-auth.mjs`;
} }] });
await server.listen();
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/home/kristjan/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome' });
mkdirSync(output, { recursive: true });

try {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    const device = viewport.width === 390 ? 'mobile' : 'desktop';
    const context = await browser.newContext({ viewport, hasTouch: viewport.width === 390, isMobile: viewport.width === 390 });
    await context.addInitScript(({ address }) => {
      window.__wallet = { address, connected: true, signatures: [], sends: [] };
      window.__walletBalances = { loading: true, native: null, tokens: {} };
      window.__copied = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => window.__copied.push(text) } });
      localStorage.setItem('sidequest.session', 'fixture-only-not-a-real-session');
      localStorage.setItem('sidequest.session-owner', JSON.stringify({ address, expiresAt: Math.floor(Date.now() / 1000) + 86400 }));
    }, { address: owner });
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== base) return route.abort('blockedbyclient');
      const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (url.pathname === '/data/boards') return reply({ ok: true, boards: [{ id: 'public', tokens: [{ address: usdc, symbol: 'USDC', decimals: 6 }, { address: fakeUsdc, symbol: 'USDC', decimals: 6 }] }] });
      if (url.pathname === '/data/jobs') return reply({ ok: true, jobs: [], index: { next_block: 100, updated_at: Math.floor(Date.now() / 1000) } });
      if (url.pathname.startsWith('/data/')) return reply({ ok: true, agents: [], jobs: [], nextCursor: null });
      if (url.pathname === '/__test/token') return reply({ symbol: url.searchParams.get('address') === usdc ? 'USDC' : 'TOKEN', decimals: 6 });
      if (url.pathname.endsWith('/api/collect_actions')) return reply({ ok: true, result: [] });
      if (url.pathname.endsWith('/api/telegram_status')) return reply({ ok: true, result: { linked: false, username: null, linkedAt: null } });
      if (url.pathname.endsWith('/api/task_index')) return reply({ ok: true, result: [] });
      if (url.pathname.includes('/api/')) return reply({ ok: false, message: 'Fixture operation unavailable' }, 503);
      return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${base}/jobs`);
    const nav = viewport.width === 390 ? page.getByRole('navigation', { name: 'Sections' }).last() : page.getByRole('complementary', { name: 'Sections' });
    await nav.getByRole('link', { name: /^Account/ }).click();
    await page.waitForURL('**/account');
    assert.equal(await page.getByRole('menuitem').count(), 0);
    const wallet = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Wallet', exact: true }) }).first();
    await wallet.getByText(owner, { exact: true }).waitFor();
    assert.equal(await wallet.locator('summary').count(), 0, 'wallet details are visible without a disclosure');
    assert.ok(await wallet.getByText('…', { exact: true }).count() >= 4, 'initial pending balances are visibly loading');
    await wallet.getByRole('button', { name: 'Copy address', exact: true }).click();
    await wallet.getByRole('status').getByText('Copied', { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__copied), [owner]);

    await page.evaluate(({ factory, usd, eur, realUsdc, fake }) => {
      window.__walletBalances = { loading: false, native: null, tokens: { [factory]: '0', [usd]: '2500000', [eur]: null, [realUsdc]: '1250000', [fake]: '3000000' } };
      window.dispatchEvent(new Event('fixture-balances-change'));
    }, { factory: side, usd: musd, eur: meur, realUsdc: usdc, fake: fakeUsdc });
    await wallet.getByText('0 SIDE', { exact: true }).waitFor();
    await wallet.getByText('2.5 mUSD', { exact: true }).waitFor();
    await wallet.getByText('1.25 USDC', { exact: true }).waitFor();
    assert.equal(await wallet.getByText('Unavailable', { exact: true }).count(), 2);
    assert.equal(await wallet.locator(`img[src="/tokens/10143/${usdc}.png"]`).count(), 1);
    const fakeChip = wallet.getByText('3 USDC', { exact: true }).locator('..');
    assert.equal(await fakeChip.locator('img').count(), 0, 'a fake USDC uses no trusted logo');
    assert.equal(await fakeChip.locator('[data-label="U"]').count(), 1);
    await page.getByRole('heading', { name: 'Collect', exact: true }).waitFor();
    await page.getByRole('heading', { name: 'Notifications', exact: true }).waitFor();
    await page.getByRole('heading', { name: 'My backing positions', exact: true }).waitFor();
    await page.getByRole('link', { name: /Gas sponsorship/ }).waitFor();
    await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
    await wallet.getByRole('button', { name: 'Get test tokens', exact: true }).waitFor();
    if (config.deployment.market !== undefined) await wallet.getByRole('button', { name: 'Buy SIDE', exact: true }).waitFor();

    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Fixture clipboard refused'); } } }));
    await wallet.getByRole('button', { name: /^Copy address/ }).click();
    await wallet.getByRole('status').getByText('Copy failed', { exact: true }).waitFor();
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
    await wallet.getByRole('button', { name: /^Copy address/ }).click();
    await wallet.getByRole('status').getByText('Copy failed', { exact: true }).waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${device}: horizontal overflow`);
    await page.screenshot({ path: `${output}/${device}-account.png`, fullPage: true });
    results.push({ device, passed: true, checks: ['direct Account navigation', 'full address and exact copy', 'clipboard refusal and missing API', 'loading, zero and per-token unavailable', 'address-based token icons', 'inline Collect and Notifications', 'backing and Settings reachable', 'faucet and market controls retained', 'no horizontal overflow'] });
    await context.close();
  }
  assert.deepEqual(errors, []);
  writeFileSync(`${output}/results.json`, JSON.stringify({ tier: 'fixture Chromium only; no real signing, transactions or prices', results, errors }, null, 2));
  console.log(`PASS: account, ${results.length} evidence records`);
} finally {
  await browser.close();
  await server.close();
}

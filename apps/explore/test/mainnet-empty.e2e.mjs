import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { build, preview } from 'vite';

// U-MAINNET-EMPTY: the production mainnet build with contracts/config/monad-mainnet.json as it is before launch day
// promotes it (an empty `deployment`). No fixture modules: Explore's own wagmi, release flag and SDK loader. Every route
// renders by URL without throwing, the launch gate shows ("Launching soon", the testnet link), no request reaches a
// Monad RPC (no contract reads), and /release.json reports writes closed. Only the board and the data API are answered.
//   heavy node test/mainnet-empty.e2e.mjs [/tmp/hireling-mainnet-empty-evidence]
const output = process.argv[2] ?? '/tmp/hireling-mainnet-empty-evidence';
const outDir = '/tmp/hireling-mainnet-empty-build';
const base = 'http://127.0.0.1:5211';
const config = JSON.parse(readFileSync(new URL('../../../contracts/config/monad-mainnet.json', import.meta.url), 'utf8'));
// This test is about the empty block; once launch day promotes it, the routes are covered by the other e2e suites.
if (Object.keys(config.deployment ?? {}).length > 0) {
  console.log('SKIP: monad-mainnet.json has a deployment; this test covers the empty one');
  process.exit(0);
}
const me = '0x1111111111111111111111111111111111111111';
const results = [];
mkdirSync(output, { recursive: true });

process.env.AGENT_JOBS_NETWORK = 'monad-mainnet';
delete process.env.HIRELING_PROD_PRIVY_APP_ID;
await build({ envFile: false, logLevel: 'error', build: { outDir, emptyOutDir: true } });
const server = await preview({ envFile: false, logLevel: 'silent', preview: { host: '127.0.0.1', port: 5211, strictPort: true }, build: { outDir } });
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/home/kristjan/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome' });

// Every route, by URL, as a visitor (signed out) and with a wallet session in storage.
const ROUTES = [
  '/', '/job/12', '/publish', '/quotes', '/quotes/req-1', '/agent/1942', '/agents', '/connect', '/account', '/backing', '/admin',
  '/collect', '/telegram', '/sponsorship', '/boards', '/boards/new', '/b/acme', '/b/acme/job/12', '/b/acme/publish',
  '/b/acme/quotes', '/b/acme/quotes/req-1', '/b/acme/agent/1942', '/embed/acme', '/embed/acme?view=publish', '/no-such-page',
];

async function open(session) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  if (session) {
    await context.addInitScript((account) => {
      localStorage.setItem('agent-jobs.session', 'fixture-only-not-a-real-session');
      localStorage.setItem('agent-jobs.session-owner', JSON.stringify({ address: account, expiresAt: Math.floor(Date.now() / 1000) + 86400 }));
    }, me);
  }
  const blocked = [];
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.origin !== base) {
      // A Monad RPC, or anything else off the page's origin: recorded, never answered.
      blocked.push(`${url.origin}${route.request().method() === 'POST' ? ` ${route.request().postData()?.slice(0, 80) ?? ''}` : ''}`);
      return route.abort('blockedbyclient');
    }
    if (url.pathname.endsWith('/api/task_index')) return reply({ ok: true, result: [] });
    if (url.pathname.endsWith('/api/get_board')) return reply({ ok: true, result: { board: { id: 'acme', name: 'Acme', allowedOrigins: [] } } });
    if (url.pathname.includes('/api/')) return reply({ ok: false, code: 'not-found', message: 'Fixture has nothing here' }, 404);
    if (url.pathname === '/data/jobs') return reply({ ok: true, jobs: [], index: { next_block: 100, updated_at: Math.floor(Date.now() / 1000) } });
    if (url.pathname.startsWith('/data/')) return reply({ ok: false, message: 'Not indexed' }, 404);
    return route.continue();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { context, page, errors, blocked };
}

try {
  const release = await (await fetch(`${base}/release.json`)).json();
  assert.deepEqual(release, { network: 'monad-mainnet', mainnetLive: false, writesOpen: false });
  results.push({ check: '/release.json', passed: true, value: release });

  for (const session of [false, true]) {
    const { context, page, errors, blocked } = await open(session);
    for (const path of ROUTES) {
      await page.goto(`${base}${path}`);
      await page.waitForLoadState('networkidle');
      // Rendered, not the router's error screen; the launch banner on every page but the embed (it has its own gate).
      assert.equal(await page.getByText('Something went wrong', { exact: false }).count(), 0, `${path}: the error screen`);
      if (!path.startsWith('/embed')) await page.getByRole('note').filter({ hasText: 'Launching soon.' }).first().waitFor({ timeout: 10_000 });
      assert.ok((await page.locator('body').innerText()).trim().length > 0, `${path}: blank`);
      if (['/backing', '/admin', '/collect', '/publish', '/telegram', '/sponsorship', '/boards/new', '/b/acme/publish'].includes(path)) {
        await page.getByRole('status').filter({ hasText: 'Hireling on mainnet opens soon' }).waitFor({ timeout: 10_000 });
        await page.getByRole('link', { name: 'Try it on testnet' }).first().waitFor();
      }
      assert.deepEqual(errors, [], `${path}: ${errors.join(' | ')}`);
      if (['/', '/backing', '/job/12', '/account'].includes(path)) await page.screenshot({ path: `${output}/${session ? 'session' : 'visitor'}${path.replaceAll('/', '-') || '-home'}.png`, fullPage: true });
    }
    const rpc = blocked.filter((b) => /monad|rpc/i.test(b));
    assert.deepEqual(rpc, [], `requests to a Monad RPC: ${rpc.join(' | ')}`);
    results.push({ check: `${ROUTES.length} routes ${session ? 'with a wallet session' : 'as a visitor'}: rendered, launch gate, no page error, no RPC request`, passed: true, offOrigin: [...new Set(blocked)] });
    await context.close();
  }
} finally {
  await browser.close();
  await server.close();
}
writeFileSync(`${output}/results.json`, JSON.stringify({ tier: 'production mainnet build, current empty deployment config; board and data API answered, everything else blocked', results }, null, 2));
console.log(`PASS: mainnet with no deployment, ${results.length} evidence records`);

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const directory = fileURLToPath(new URL('.', import.meta.url));
const output = process.argv[2] ?? '/tmp/hireling-directory-evidence';
const base = 'http://127.0.0.1:5191';
const owner = '0x1111111111111111111111111111111111111111';
// AGENT_JOBS_NETWORK=monad-mainnet runs the same checks on the mainnet config: its chain and ERC-8004 registry.
const network = process.env.AGENT_JOBS_NETWORK ?? 'monad-testnet';
const readConfig = (name) => JSON.parse(readFileSync(new URL(`../../../contracts/config/${name}.json`, import.meta.url), 'utf8'));
const config = readConfig(network);
const registry = config.erc8004.identity;
const { chainId } = config;
// Until a network is deployed its config has no deployment block and Explore cannot load. The directory reads only the
// ERC-8004 registry, so the run borrows testnet's deployment block for the contracts it never touches, and says so.
const borrowed = config.deployment.core === undefined;
const now = Math.floor(Date.now() / 1000);
const ad = { serviceId: 'review-code', name: 'Independent code review', description: 'Test fixture only, not a live worker.', inputs: 'A repository and acceptance criteria', outputs: 'A ranked, evidence-backed review', turnaroundSeconds: 3600, price: { model: 'quote', amountBaseUnits: '0', token: owner }, adHash: `0x${'00'.repeat(32)}`, expiresAt: now + 86400 };
const agent = (id, fresh = true) => ({ agentId: id, chainId, identityRegistry: registry, wallet: owner, profile: { name: `Fixture worker ${id}`, description: 'Mocked test identity', services: ['Code review'] }, profileSource: 'operator-supplied', agentURI: '', enrolled: true, ownership: 'verified', presence: { freshness: fresh ? 'fresh' : 'stale', state: 'available', accepting: fresh, lastSeenBucket: now - now % 60 }, ads: [ad], observedAt: now, projectionAt: now, revision: 1 });
const results = [];
const errors = [];
const server = await createServer({ envFile: false, server: { host: '127.0.0.1', port: 5191, strictPort: true }, plugins: [{ name: 'directory-wallet-fixtures', enforce: 'pre', resolveId(source) {
  if (source === 'wagmi') return `${directory}directory-wagmi.mjs`;
  if (source === 'wagmi/actions') return `${directory}wagmi-actions.mjs`;
  if (source.endsWith('/Privy.tsx')) return `${directory}privy.mjs`;
}, transform(source, id) {
  if (borrowed && id.endsWith(`/contracts/config/${network}.json`)) return JSON.stringify({ ...JSON.parse(source), deployment: readConfig('monad-testnet').deployment });
  // Joining the directory writes, so on mainnet it opens only with the launch (D16): the mainnet run is the launch-day
  // build. launch.e2e.mjs covers the build before it.
  if (network === 'monad-mainnet' && id.endsWith('/src/release.ts')) return source.replace('export const MAINNET_LIVE = false', 'export const MAINNET_LIVE = true');
} }] });
await server.listen();
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/home/kristjan/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome' });
mkdirSync(output, { recursive: true });

async function fixture(viewport) {
  const context = await browser.newContext({ viewport, hasTouch: viewport.width === 390, isMobile: viewport.width === 390 });
  await context.addInitScript(({ address, chain }) => { window.__wallet = { address, chainId: chain, connected: true, signatures: [], sends: [] }; }, { address: owner, chain: chainId });
  const state = { failDirectory: false, loseEnrollmentReply: false, calls: [], submitted: [], pageAfter: [] };
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort('blockedbyclient');
    const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/__test/token') return reply({ symbol: 'TEST', decimals: 6 });
    if (url.pathname === '/data/directory') {
      if (state.failDirectory) return reply({ ok: false, message: 'Directory unavailable' }, 503);
      const after = url.searchParams.get('after');
      state.pageAfter.push(after);
      return reply({ ok: true, agents: after === null ? [agent('7001'), agent('7002', false)] : [agent('7003')], nextCursor: after === null ? '7002' : null, observedAt: now, chainId, identityRegistry: registry, scope: 'opted-in Hireling directory' });
    }
    if (url.pathname.startsWith('/data/directory/')) return reply({ ok: true, agent: agent(url.pathname.split('/').at(-1)) });
    if (url.pathname.startsWith('/data/agents/')) return reply({ ok: false, code: 'not-found', message: 'fixture has no job history' }, 404);
    if (url.pathname === '/data/stats') return reply({ ok: true, jobs: 0, completed: 0, agents: 0, paidOut: {}, inEscrow: {} });
    if (url.pathname.startsWith('/data/')) return reply({ ok: true, agents: [], jobs: [], boards: [] });
    if (url.pathname.includes('/api/')) {
      const name = url.pathname.split('/').at(-1);
      const args = route.request().postDataJSON();
      state.calls.push(name);
      if (name === 'task_index') return reply({ ok: true, result: [] });
      if (name.startsWith('prepare_')) {
        const kind = name === 'prepare_directory_enrollment' ? 'Enrollment' : name === 'prepare_service_ad' ? 'ServiceAd' : 'Heartbeat';
        return reply({ ok: true, result: { version: 1, kind, chainId, identityRegistry: registry, audience: base, agentId: args.agentId, wallet: owner, generation: 1, nonce: 1, issuedAt: now, expiresAt: now + 60, payload: args.payload } });
      }
      if (['enroll_directory', 'publish_service_ad', 'post_heartbeat'].includes(name)) {
        state.submitted.push(args);
        if (name === 'enroll_directory' && state.loseEnrollmentReply) {
          state.loseEnrollmentReply = false;
          return reply({ ok: false, message: 'Fixture response lost after commit' }, 503);
        }
        return reply({ ok: true, result: { agent: agent(args.record.agentId) } });
      }
      return reply({ ok: false, message: 'Fixture denies operation' }, 400);
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  return { context, page, state };
}

async function screenshot(page, name) {
  const metrics = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth }));
  assert.ok(metrics.scrollWidth <= metrics.width, `${name}: horizontal overflow`);
  await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
  results.push({ name, ...metrics });
}

async function prepareForm(page) {
  await page.goto(`${base}/agents`);
  await page.getByRole('button', { name: 'Join worker directory' }).click();
  await page.getByLabel('Import a confirmed ERC-8004 agent ID', { exact: false }).fill('7001');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Directory display name').fill('Test-only operator');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Stable service ID').fill('code-review');
  await page.getByLabel('Service name').fill('Code review');
  await page.getByLabel('Inputs required').fill('Source repository');
  await page.getByLabel('Outputs delivered').fill('Ranked findings');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Review wallet signatures' }).click();
  await page.waitForFunction(() => document.querySelectorAll('dialog[open]').length === 0);
}

try {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    const device = viewport.width === 390 ? 'mobile' : 'desktop';
    const { context, page, state } = await fixture(viewport);
    await page.goto(base);
    await page.getByText('Independent code review', { exact: true }).first().waitFor();
    await screenshot(page, `${device}-showcase`);
    await page.goto(`${base}/agents`);
    await page.getByText('Fixture worker 7001', { exact: true }).waitFor();
    await page.getByText('Heartbeat expired', { exact: true }).first().waitFor();
    await screenshot(page, `${device}-directory-zero-jobs`);
    await page.getByRole('button', { name: /more workers/i }).click();
    await page.getByText('Fixture worker 7003', { exact: true }).waitFor();
    assert.ok(state.pageAfter.includes('7002'));
    await page.goto(`${base}/agent/7001`);
    await page.getByText('Independent code review', { exact: true }).waitFor();
    await page.getByText('This agent has not taken a job here yet', { exact: true }).waitFor();
    await screenshot(page, `${device}-profile-ad`);
    await prepareForm(page);
    state.loseEnrollmentReply = true;
    await page.getByRole('button', { name: 'Sign enrollment', exact: true }).click();
    await page.getByText('Fixture response lost after commit', { exact: true }).first().waitFor();
    await page.getByRole('button', { name: 'Sign enrollment', exact: true }).click();
    await page.getByRole('button', { name: 'Sign service ad', exact: true }).waitFor();
    assert.deepEqual(state.submitted[0], state.submitted[1]);
    assert.equal(state.calls.filter((name) => name === 'prepare_directory_enrollment').length, 1);
    await page.getByRole('button', { name: 'Sign service ad', exact: true }).click();
    await page.getByRole('button', { name: 'Sign one heartbeat', exact: true }).click();
    await page.getByText(/Heartbeat confirmed for up to 60 seconds/).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__wallet.signatures), ['Enrollment', 'ServiceAd', 'Heartbeat']);
    assert.equal(await page.evaluate(() => window.__wallet.sends.length), 0);
    await screenshot(page, `${device}-onboarding-signed`);
    results.push({ device, test: 'onboarding signatures and same-record uncertain retry', passed: true });
    await context.close();
  }
  const rotated = await fixture({ width: 390, height: 844 });
  await prepareForm(rotated.page);
  await rotated.page.evaluate(() => { window.__wallet.rotate = true; });
  await rotated.page.getByRole('button', { name: 'Sign enrollment', exact: true }).click();
  await rotated.page.getByText('Wallet changed during signing. No signed record was submitted.', { exact: true }).first().waitFor();
  assert.equal(rotated.state.submitted.length, 0);
  results.push({ test: 'wallet rotation during signing prevents submit', passed: true });
  await rotated.context.close();
  assert.deepEqual(errors, []);
  writeFileSync(`${output}/results.json`, JSON.stringify({ tier: 'mocked Chromium only; no real wallets or live registration', network, chainId, registry, borrowedDeployment: borrowed, results, errors }, null, 2));
  console.log(`PASS: ${results.length} browser checks/captures on ${network}${borrowed ? ' (deployment block borrowed from testnet)' : ''}; no real signing or sends`);
} finally {
  await browser.close();
  await server.close();
}

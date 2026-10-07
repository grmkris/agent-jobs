import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createPublicClient, http, parseAbi } from 'viem';
import { monadTestnet } from 'viem/chains';
import { build, preview } from 'vite';

// Opt-in G1 check: real promoted config, real wagmi/SDK/chain responses and public hosted API.
// Only Privy's login is replaced with the existing injected-wallet bridge. The provider cannot sign/send;
// a local display session is never sent to the hosted board. This does not test Privy login or live paid work.
// From apps/explore: SIDEQUEST_LIVE_READONLY=1 heavy node test/g1-readonly.e2e.mjs [evidence-dir]
if (process.env.SIDEQUEST_LIVE_READONLY !== '1') {
  console.log('SKIP: set SIDEQUEST_LIVE_READONLY=1 for live read-only testnet checks');
  process.exit(0);
}

const directory = fileURLToPath(new URL('.', import.meta.url));
const config = JSON.parse(readFileSync(new URL('../../../contracts/config/monad-testnet.json', import.meta.url), 'utf8'));
const h = config.deployment.sidequest;
const contracts = { ...h, holding: config.deployment.main.holding, evaluator: config.deployment.main.evaluator, core: config.deployment.core };
assert.equal(config.deployment.main.kind, 'sidequest-v1');
const rpcUrl = monadTestnet.rpcUrls.default.http[0];
const origin = 'https://dev.sidequest.exchange';
const base = 'http://127.0.0.1:5212';
const output = process.argv[2] ?? '/tmp/sidequest-g1-readonly';
const outDir = `${output}/build`;
const client = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });
const rpcMethods = new Set(['eth_call', 'eth_chainId', 'eth_blockNumber', 'eth_getCode', 'eth_getBalance', 'eth_getBlockByNumber', 'eth_getTransactionCount']);
const readTools = new Set(['task_index', 'get_task', 'collect_actions', 'sponsor_status', 'telegram_status', 'get_board', 'list_applications']);
const results = [];
const errors = [];
const refused = [];
const rpcCalls = [];
const api = [];
mkdirSync(output, { recursive: true });

const read = (address, signature, args = []) => client.readContract({ address, abi: parseAbi([signature]), args });
assert.equal(await client.getChainId(), 10143);
for (const name of ['factory', 'vault', 'feeSchedule', 'holding', 'evaluator', 'distributor', 'miningReserve', 'safe', 'core']) {
  assert.ok((await client.getCode({ address: contracts[name] }))?.length > 2, `${name}: no code at promoted address`);
}
const owners = await read(h.safe, 'function getOwners() view returns (address[])');
const me = owners.find((a) => a.toLowerCase() === '0xb9970a6371358f6c74dfb15a7cb2653e3ae3e471');
assert.ok(me, 'Kris is not a Safe owner');
assert.equal(await read(h.safe, 'function getThreshold() view returns (uint256)'), 1n);
const pending = await read(h.feeSchedule, 'function pending() view returns ((uint256[4] thresholds, uint16[4] bps, address treasury), uint48)');
const arbitrator = await read(contracts.holding, 'function defaultArbitrator() view returns (address)');
assert.equal(arbitrator.toLowerCase(), config.sidequest.defaultArbitrator.toLowerCase());
const jobs = await (await fetch(`${origin}/data/jobs`, { signal: AbortSignal.timeout(20_000) })).json();
assert.equal(jobs.ok, true);
const v1Job = jobs.jobs.find((j) => j.kind === 'sidequest-v1' && j.published_block >= h.block);
const legacyJob = jobs.jobs.find((j) => j.kind !== 'sidequest-v1');

process.env.PRIVY_APP_ID = 'g1-readonly-wallet-bridge';
process.env.SIDEQUEST_NETWORK = 'monad-testnet';
await build({ envFile: false, logLevel: 'error', plugins: [{ name: 'readonly-wallet-bridge', enforce: 'pre', resolveId(source) {
  if (source.endsWith('/Privy.tsx')) return `${directory}real/devwallet.mjs`;
  if (source === '@privy-io/react-auth') return `${directory}privy-react-auth.mjs`;
} }], build: { outDir, emptyOutDir: true } });
const server = await preview({ envFile: false, logLevel: 'silent', preview: { host: '127.0.0.1', port: 5212, strictPort: true }, build: { outDir } });
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/home/kristjan/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome' });
try {
  assert.deepEqual(await (await fetch(`${base}/release.json`)).json(), { network: 'monad-testnet', mainnetLive: false, writesOpen: true });
  for (const width of [390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } });
    await context.addInitScript((address) => {
      window.__readonlyMethods = [];
      window.ethereum = { request: async ({ method }) => {
        window.__readonlyMethods.push(method);
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [address];
        if (method === 'eth_chainId') return '0x279f';
        if (method === 'wallet_requestPermissions') return [];
        throw new Error(`Read-only wallet refuses ${method}`);
      }, on() {}, removeListener() {} };
      localStorage.setItem('sidequest.session', 'local-display-only');
      localStorage.setItem('sidequest.session-owner', JSON.stringify({ address, expiresAt: Math.floor(Date.now() / 1000) + 86400 }));
    }, me);
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === new URL(rpcUrl).origin) {
        const body = request.postDataJSON();
        const calls = Array.isArray(body) ? body : [body];
        if (calls.some((call) => !rpcMethods.has(call.method))) {
          refused.push(...calls.map((call) => call.method));
          return route.abort('blockedbyclient');
        }
        rpcCalls.push(...calls.map((call) => ({ method: call.method, to: call.params?.[0]?.to ?? null })));
        const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
        return route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
      }
      if (url.origin !== base) return route.abort('blockedbyclient');
      if (url.pathname.startsWith('/data/') || url.pathname.includes('/api/')) {
        const tool = url.pathname.split('/api/')[1];
        if (request.method() !== 'GET' && !(request.method() === 'POST' && readTools.has(tool))) {
          refused.push(`${request.method()} ${url.pathname}`);
          return route.abort('blockedbyclient');
        }
        const response = await fetch(`${origin}${url.pathname}${url.search}`, {
          method: request.method(), headers: { 'content-type': 'application/json' },
          ...(request.method() === 'POST' ? { body: request.postData() } : {}), signal: AbortSignal.timeout(20_000),
        });
        api.push({ path: url.pathname, status: response.status });
        return route.fulfill({ status: response.status, contentType: response.headers.get('content-type') ?? 'application/json', body: await response.text() });
      }
      return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    const capture = async (name) => page.screenshot({ path: `${output}/${name}-${width}.png`, fullPage: true });

    await page.goto(`${base}/account`);
    await page.getByRole('heading', { name: 'Your fee as a worker', exact: true }).waitFor({ timeout: 60_000 });
    await capture('stake');
    results.push({ page: '/account#backing', width, passed: true, vault: h.vault });

    await page.goto(`${base}/admin`);
    await page.getByText('Safe owns it', { exact: true }).nth(5).waitFor({ timeout: 60_000 });
    await page.getByRole('heading', { name: 'Fee schedule', exact: true }).waitFor();
    await page.getByRole('heading', { name: 'Mining', exact: true }).waitFor();
    assert.equal(await page.getByText(/The Safe is not the core's admin/).count(), 0);
    await capture('admin');
    results.push({ page: '/admin', width, passed: true, safe: h.safe, feeEta: Number(pending[1]) });

    await page.goto(`${base}/account`);
    await page.getByText(/What you can collect cannot be read right now|Nothing to collect|Mining reward/).first().waitFor({ timeout: 60_000 });
    const collectText = await page.locator('main').innerText();
    await capture('collect');
    results.push({ page: '/account#collect', width, passed: true, state: collectText.includes('cannot be read') ? 'live board unavailable without a real session' : 'live board answered' });

    await page.goto(`${base}/jobs`);
    await page.getByText('AI agents post work here and other agents bid on it.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Copy the instruction', exact: true }).waitFor();
    await capture('post-hint');
    results.push({ page: '/jobs', width, passed: true, state: 'posting is an instruction to copy to your agent; no create button' });

    const jobId = v1Job?.job_id ?? '74';
    await page.goto(`${base}/job/${jobId}`);
    if (v1Job === undefined) await page.getByText(/Chain job details are unavailable|Job #74 is not indexed yet/).first().waitFor({ timeout: 60_000 });
    else await page.getByRole('heading', { level: 1 }).waitFor({ timeout: 60_000 });
    await capture('job');
    results.push({ page: `/job/${jobId}`, width, passed: true, state: v1Job === undefined ? 'no G1 job indexed; truthful unavailable page' : 'live v1 job indexed' });
    if (legacyJob !== undefined) {
      await page.goto(`${base}/job/${legacyJob.job_id}`);
      await page.getByText(`Job #${legacyJob.job_id} is on an earlier contract`, { exact: true }).waitFor({ timeout: 60_000 });
      await capture('legacy-job');
      results.push({ page: `/job/${legacyJob.job_id}`, width, passed: true, state: 'pre-v1 job refused' });
    }
    assert.deepEqual(await page.evaluate(() => window.__readonlyMethods.filter((method) => !['eth_accounts', 'eth_requestAccounts', 'eth_chainId', 'wallet_requestPermissions'].includes(method))), []);
    await context.close();
  }
  assert.deepEqual(refused, []);
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
  writeFileSync(`${output}/results.json`, JSON.stringify({
    tier: 'production testnet build with promoted addresses; live read-only RPC/public API; injected display wallet, no Privy authentication',
    configBlock: h.block, contracts, arbitrator, feeEta: Number(pending[1]), v1Job: v1Job?.job_id ?? null, results, rpcCalls, api, refused, errors,
  }, null, 2));
}
console.log(`PASS: ${results.length} real-address page checks; no signatures or transactions; ${v1Job === undefined ? 'G1 job not yet indexed' : `v1 job ${v1Job.job_id}`}`);

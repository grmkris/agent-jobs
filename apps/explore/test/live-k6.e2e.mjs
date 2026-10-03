import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createPublicClient, http } from 'viem';
import { monadTestnet } from 'viem/chains';
import { injectWallet, patchPrivy } from './live-ui-bridge.mjs';
import { atomic, loadAccount, liveWallet } from './live-ui-wallet.mjs';
import { sha256, validateReady, verifyReadyChain } from './live-ui-ready.mjs';
import { drivePlan } from './live-ui-plan.mjs';

// LIVE-UI: hosted staging smoke and K6 harness. Read-only is the default. The browser receives a real EIP-1193
// provider backed by a viem local account in this Node process; the private key is read internally from .env.local and
// never enters page scripts, screenshots, logs or evidence. The hosted bundle's Privy boundary is patched by AST,
// while every board/indexer request remains same-origin and every chain read uses Monad testnet.
//
// Read-only preparation:
//   node test/live-k6.e2e.mjs /tmp/hireling-live-ui/read-only
// A send run additionally requires the coordinator's G1b release/funding card and an explicit row:
//   LIVE_UI_SEND=1 LIVE_UI_ALLOW_SEND=1 GAS_FIX_CONFIRMED=1 STAGING_RELEASE_CONFIRMED=1 \
//   G1B_RELEASE_CONFIRMED=1 FACTORY_V2_FUNDED=1 LIVE_UI_SEND_AUTHORIZED=1 \
//   LIVE_UI_READY_JSON=/path/card.json LIVE_UI_PLAN_JSON=/path/steps.json LIVE_UI_ROW=K6-01 \
//     node test/live-k6.e2e.mjs /tmp/hireling-live-ui/k6
// No send mode is run by default. This file never prints the key.

const origin = 'https://testnet.hireling.xyz';
const output = process.argv[2] ?? '/tmp/hireling-live-ui/read-only';
const mode = process.env.LIVE_UI_SEND === '1' ? 'send' : 'read';
const sendRequested = mode === 'send';
const allowSend = sendRequested && process.env.LIVE_UI_ALLOW_SEND === '1' && process.env.GAS_FIX_CONFIRMED === '1' &&
  process.env.STAGING_RELEASE_CONFIRMED === '1' && process.env.G1B_RELEASE_CONFIRMED === '1' && process.env.FACTORY_V2_FUNDED === '1' && process.env.LIVE_UI_SEND_AUTHORIZED === '1';
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const envPath = `${repo}.env.local`;
const envStat = statSync(envPath);
assert.equal(envStat.mode & 0o777, 0o600, '.env.local must be mode 600');
const account = loadAccount(envPath);
const configPath = `${repo}contracts/config/monad-testnet.json`;
const configText = readFileSync(configPath, 'utf8');
const config = JSON.parse(configText);
const rpcUrl = process.env.MONAD_TESTNET_RPC_URL ?? monadTestnet.rpcUrls.default.http[0];
const publicClient = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });
const results = [];
const errors = [];
const blocked = [];
mkdirSync(output, { recursive: true });
const row = process.env.LIVE_UI_ROW ?? 'read-only';
assert.match(row, /^[a-zA-Z0-9_-]+$/, 'invalid row name');
let ready;
let plan;
const release = await (await fetch(`${origin}/release.json`, { signal: AbortSignal.timeout(20_000) })).json();
assert.equal(release.network, 'monad-testnet');
assert.equal(release.writesOpen, true);
assert.equal(await publicClient.getChainId(), 10143);
const protocolEnvelope = await (await fetch(`${origin}/api/protocol_info`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(20_000),
})).json();
assert.equal(protocolEnvelope.ok, true);
const protocol = protocolEnvelope.result;
if (sendRequested) {
  assert.ok(allowSend, 'live sends are held: require release, funding and later coordinator send authorization');
  assert.ok(process.env.LIVE_UI_READY_JSON && process.env.LIVE_UI_PLAN_JSON, 'session card and reviewed step plan are required');
  ready = JSON.parse(readFileSync(process.env.LIVE_UI_READY_JSON, 'utf8'));
  const planText = readFileSync(process.env.LIVE_UI_PLAN_JSON, 'utf8');
  assert.equal(sha256(planText), ready.planSha256, 'reviewed row plan changed');
  plan = JSON.parse(planText);
  const archive = JSON.parse(readFileSync(`${repo}contracts/config/archive/monad-testnet-g1.json`, 'utf8'));
  validateReady({ ready, config, configText, archive, address: account.address, row });
  results.push({ readiness: await verifyReadyChain({ reads: publicClient, config, address: account.address, protocol, rewardToken: ready.rewardToken }) });
  const html = await (await fetch(origin, { signal: AbortSignal.timeout(20_000) })).text();
  const asset = html.match(/<script[^>]+src="([^"]+)"/)?.[1];
  assert.ok(asset, 'released module asset is missing');
  const body = await (await fetch(new URL(asset, origin), { signal: AbortSignal.timeout(20_000) })).text();
  assert.equal(sha256(body), ready.assetSha256, 'released asset changed');
  assert.ok(patchPrivy(body), 'released Privy boundary was not found');
}
const wallet = liveWallet({ account, config, stateDir: `${output}/wallet`, enabled: allowSend, rpcUrl,
  onTransaction: (tx) => {
    results.push({ tx: 'testnet', hash: tx.hash, row: tx.row, status: tx.status });
    if (tx.status === 'success') console.log(`TX testnet ${tx.hash} ${tx.row}`);
  } });
wallet.setRow(allowSend ? row : 'read-only');
process.once('exit', () => { wallet.close(); });

const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/home/kristjan/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome' });
const browserState = `${output}/browser.json`;
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true,
  ...(allowSend && existsSync(browserState) ? { storageState: browserState } : {}) });
await injectWallet(context, { address: account.address, request: wallet.request, authorize: wallet.authorize, origin });
await context.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  if (url.origin === new URL(rpcUrl).origin) return route.continue();
  if (url.origin !== origin) {
    blocked.push(url.origin);
    return route.abort('blockedbyclient');
  }
  if (url.pathname.endsWith('.js') && url.pathname.includes('/assets/')) {
    const response = await route.fetch();
    const body = await response.text();
    const patched = patchPrivy(body);
    if (patched !== null && allowSend) assert.equal(patched.originalSha256, ready.assetSha256, 'released asset changed during the session');
    if (patched !== null) results.push({ asset: url.pathname, originalSha256: patched.originalSha256, patchedSha256: patched.patchedSha256, edits: patched.edits });
    if (patched === null) return route.fulfill({ response, body });
    const headers = { ...response.headers() };
    delete headers['content-length'];
    return route.fulfill({ response, headers, body: patched.body });
  }
  return route.continue();
});
const page = await context.newPage();
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });

const jobs = await (await fetch(`${origin}/data/jobs`, { signal: AbortSignal.timeout(20_000) })).json();
assert.equal(jobs.ok, true);
const liveJob = jobs.jobs.find((job) => job.kind === 'hireling-v1');
const pages = [
  ['/stake', /Stake|Your fee as a worker/],
  ['/publish', /Post|Direct hire|Request quotes/],
  ['/collect', /Collect|Nothing to collect|cannot be read/],
  ['/sponsorship', /Gas sponsorship|Sign in/],
  [liveJob === undefined ? '/job/65' : `/job/${liveJob.job_id}`, /Job #|not indexed|unavailable/],
];
try {
  if (allowSend) {
    await drivePlan({ page, origin, steps: plan.steps, capture: async (name) => {
      await page.screenshot({ path: `${output}/${row}-${name}.png`, fullPage: true });
    } });
    await wallet.wait();
    atomic(browserState, await context.storageState());
  } else {
    for (const [path, text] of pages) {
      await page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded' });
      await page.getByText(text).first().waitFor({ timeout: 60_000 });
      await page.screenshot({ path: `${output}/${path.replaceAll('/', '_')}.png`, fullPage: true });
      results.push({ path, live: true, mode, account: account.address });
    }
    assert.deepEqual(wallet.publicTransactions(), [], 'read-only preparation sent a transaction');
    assert.deepEqual(wallet.signatures(), [], 'read-only preparation signed a message');
  }
  assert.deepEqual(errors, [], 'hosted staging page errors');
  assert.deepEqual(blocked, [], 'unexpected cross-origin requests');
  assert.ok(results.some((r) => r.asset), 'Privy boundary was not patched');
  console.log(`PASS: hosted staging ${mode}; injected wallet only, Privy login unverified`);
} finally {
  if (allowSend) atomic(browserState, await context.storageState());
  atomic(`${output}/results.json`, { mode, account: account.address, protocolContracts: protocol.contracts,
    results, errors, blocked, transactions: wallet.publicTransactions(), signatures: wallet.signatures() });
  wallet.close();
  await browser.close();
}

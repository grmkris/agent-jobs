import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

// The Safe console (U5) against a fixture Safe and Hireling v1 (admin-wagmi.mjs): owner-only gating, accepting
// ownership, pausing the core, a fee schedule proposal with its 3-day timelock (refused rules, cancel, execute by
// anyone), a vault Holding proposal refused before 8 days and a revocation, an epoch root and its funding. Every
// action is reviewed as the decoded call before the wallet opens. Mocked Chromium only: no signing or sends.
const directory = fileURLToPath(new URL('.', import.meta.url));
const output = process.argv[2] ?? '/tmp/hireling-admin-evidence';
const base = 'http://127.0.0.1:5196';
const owner = '0x1111111111111111111111111111111111111111';
const stranger = '0x5555555555555555555555555555555555555555';
const deployer = '0x7777777777777777777777777777777777777777';
const c = { factory: '0xf000000000000000000000000000000000000001', vault: '0xf000000000000000000000000000000000000002', feeSchedule: '0xf000000000000000000000000000000000000003', distributor: '0xf000000000000000000000000000000000000004', miningReserve: '0xf000000000000000000000000000000000000005', holding: '0xf000000000000000000000000000000000000006', evaluator: '0xf000000000000000000000000000000000000007', safe: '0xf000000000000000000000000000000000000008' };
const results = [];
const errors = [];

process.env.PRIVY_APP_ID = 'fixture-privy-app-id';
const server = await createServer({ envFile: false, server: { host: '127.0.0.1', port: 5196, strictPort: true }, plugins: [{ name: 'admin-fixtures', enforce: 'pre', resolveId(source) {
  if (source === 'wagmi') return `${directory}admin-wagmi.mjs`;
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
  await context.addInitScript(({ account, contracts, owners, previousOwner }) => {
    const K = 10n ** 21n;
    window.__hireling = contracts;
    window.__wallet = { address: account, connected: true, signatures: [], sends: [] };
    localStorage.setItem('agent-jobs.session', 'fixture-only-not-a-real-session');
    localStorage.setItem('agent-jobs.session-owner', JSON.stringify({ address: account, expiresAt: Math.floor(Date.now() / 1000) + 86400 }));
    if (contracts === null) return;
    const owned = [contracts.vault, contracts.holding, contracts.evaluator, contracts.miningReserve, contracts.distributor].map((a) => a.toLowerCase());
    window.__admin = {
      safe: contracts.safe, owners, threshold: 1n,
      owner: Object.fromEntries([...owned.map((a) => [a, contracts.safe]), [contracts.feeSchedule.toLowerCase(), previousOwner]]),
      pendingOwner: { [contracts.feeSchedule.toLowerCase()]: contracts.safe },
      paused: false, safeIsAdmin: true,
      schedule: { thresholds: [0n, 10n * K, 100n * K, 1000n * K], bps: [3000, 1000, 300, 100], treasury: contracts.safe },
      pending: null, bootstrapped: true, pendingHolding: null, holdings: [contracts.holding],
      currentEpoch: 2n, totalFunded: 0n, available: 0n, genesis: Math.floor(Date.now() / 1000) - 3 * 604800, roots: {}, calls: [], down: false,
    };
  }, { account: options.account ?? owner, contracts: options.contracts === undefined ? c : options.contracts, owners: [owner, '0x2222222222222222222222222222222222222222'], previousOwner: deployer });
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

const section = (page, title) => page.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
const send = async (page, done) => {
  await page.getByRole('button', { name: 'Confirm in your wallet', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm fixture' }).click();
  await page.getByRole('status').filter({ hasText: `${done}: done` }).waitFor();
};
const last = (page) => page.evaluate(() => { const call = window.__admin.calls.at(-1); return { via: call.via, to: call.to.toLowerCase(), functionName: call.functionName, signatures: call.signatures }; });
const preValidated = `0x${owner.slice(2).padStart(64, '0')}${'0'.repeat(64)}01`;

try {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    const device = viewport.width === 390 ? 'mobile' : 'desktop';
    const { context, page } = await fixture(viewport);
    await page.goto(`${base}/me`);
    await page.getByRole('link', { name: /Admin/ }).click();
    await page.waitForURL('**/admin');

    // Ownership: the FeeSchedule is pending to the Safe; the Safe accepts it, reviewed as the decoded call first.
    const ownership = section(page, 'Ownership');
    assert.equal(await ownership.getByText('Safe owns it', { exact: true }).count(), 5);
    await ownership.getByRole('button', { name: 'Accept ownership' }).click();
    await page.getByText('Accept ownership of FeeSchedule', { exact: true }).waitFor();
    await page.getByText('acceptOwnership()', { exact: true }).waitFor();
    await page.getByText(preValidated, { exact: true }).waitFor();
    await capture(page, `${device}-review-accept-ownership`);
    await send(page, 'Accept ownership of FeeSchedule');
    assert.deepEqual(await last(page), { via: 'safe', to: c.feeSchedule, functionName: 'acceptOwnership', signatures: preValidated });
    await ownership.getByText('Safe owns it', { exact: true }).nth(5).waitFor();

    // Core: pause, then the button offers unpause.
    await section(page, 'Core').getByRole('button', { name: 'Pause the core' }).click();
    await page.getByText('pause()', { exact: true }).waitFor();
    await send(page, 'Pause the core');
    await section(page, 'Core').getByText('Paused', { exact: true }).waitFor();
    await section(page, 'Core').getByRole('button', { name: 'Unpause the core' }).waitFor();

    // Fee schedule: a proposal the contract would refuse is refused here; a valid one waits 3 days; cancel; execute.
    const fees = section(page, 'Fee schedule');
    await fees.getByRole('textbox', { name: 'Tier 3 fee' }).fill('12');
    await fees.getByText('A bigger stake may not pay a higher fee.', { exact: true }).waitFor();
    assert.equal(await fees.getByRole('button', { name: 'Review the proposal' }).isDisabled(), true);
    await fees.getByRole('textbox', { name: 'Tier 3 fee' }).fill('3');
    await fees.getByRole('textbox', { name: 'Tier 2 fee' }).fill('8');
    await fees.getByRole('button', { name: 'Review the proposal' }).click();
    await page.getByText(/bps: \[3000, 800, 300, 100\]/).waitFor();
    await send(page, 'Propose a new fee schedule');
    await fees.getByText(/Executable in 2 d 23 h/).waitFor();
    assert.equal(await fees.getByRole('button', { name: 'Execute', exact: true }).isDisabled(), true);
    await capture(page, `${device}-fee-proposed`);
    await fees.getByRole('button', { name: 'Cancel proposal' }).click();
    await send(page, 'Cancel the proposed fee schedule');
    await fees.getByText('Proposed', { exact: true }).waitFor({ state: 'hidden' });
    await fees.getByRole('button', { name: 'Review the proposal' }).click();
    await send(page, 'Propose a new fee schedule');
    await page.evaluate(() => { window.__admin.pending.eta = Math.floor(Date.now() / 1000) - 1; window.dispatchEvent(new Event('visibilitychange')); });
    await fees.getByText('Executable now, by anyone.', { exact: true }).waitFor();
    await fees.getByRole('button', { name: 'Execute', exact: true }).click();
    await page.getByText('Anyone may send this call; it goes straight from your wallet, not through the Safe.', { exact: true }).waitFor();
    await send(page, 'Execute the proposed fee schedule');
    assert.deepEqual(await last(page), { via: 'direct', to: c.feeSchedule, functionName: 'execute', signatures: null });
    await fees.getByText('8 %', { exact: true }).waitFor();

    // Vault Holdings: a proposal cannot be accepted before 8 days; revoking is instant.
    const holdings = section(page, 'Stake vault Holdings');
    await holdings.getByRole('textbox', { name: 'Holding to propose' }).fill('0xf000000000000000000000000000000000000009');
    await holdings.getByRole('button', { name: 'Review the proposal' }).click();
    await send(page, 'Propose a Holding');
    await holdings.getByText(/Acceptable in 7 d 23 h/).waitFor();
    assert.equal(await holdings.getByRole('button', { name: 'Accept', exact: true }).isDisabled(), true);
    await holdings.getByRole('button', { name: 'Review the revocation' }).click();
    await page.getByText('revokeHolding(holding)', { exact: true }).waitFor();
    await send(page, 'Revoke a Holding');
    await holdings.getByText('Not authorized', { exact: true }).waitFor();
    await capture(page, `${device}-holdings`);

    // Mining: the root for the last ended epoch, then its funding.
    const mining = section(page, 'Mining');
    assert.equal(await mining.getByRole('textbox', { name: 'Epoch', exact: true }).inputValue(), '1');
    const root = `0x${'ab'.repeat(32)}`;
    await mining.getByRole('textbox', { name: 'Merkle root' }).fill(root);
    await mining.getByRole('textbox', { name: 'Epoch total' }).fill('5000');
    await mining.getByRole('textbox', { name: 'Data hash' }).fill(`0x${'cd'.repeat(32)}`);
    await mining.getByRole('button', { name: 'Review the root' }).click();
    await page.getByText('setRoot(epoch, root, total, dataHash)', { exact: true }).waitFor();
    await send(page, 'Post the root of epoch 1');
    await mining.getByText(root, { exact: true }).waitFor();
    await mining.getByRole('textbox', { name: 'Amount to fund' }).fill('5000');
    await mining.getByRole('button', { name: 'Review funding' }).click();
    await send(page, 'Fund epoch 1');
    await mining.getByText(/5,000 FACTORY available/).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__admin.calls.map((call) => `${call.via}:${call.functionName}`)), [
      'safe:acceptOwnership', 'safe:pause', 'safe:propose', 'safe:cancel', 'safe:propose', 'direct:execute', 'safe:proposeHolding', 'safe:revokeHolding', 'safe:setRoot', 'safe:fund',
    ]);
    await capture(page, `${device}-mining`);
    results.push({ device, checks: ['owner sees Admin in Me', 'acceptOwnership via Safe with pre-validated signature', 'pause', 'fee proposal refused rules', 'fee timelock countdown', 'cancel', 'execute direct by anyone', 'Holding refused before 8 days', 'revoke', 'setRoot', 'fund', 'decoded review before every send'], passed: true });
    await context.close();
  }

  {
    const { context, page } = await fixture({ width: 390, height: 844 }, { account: stranger });
    await page.goto(`${base}/me`);
    await page.getByRole('link', { name: /Stake/ }).waitFor();
    assert.equal(await page.getByRole('link', { name: /Admin/ }).count(), 0);
    await page.goto(`${base}/admin`);
    await page.getByText("Only the Safe's owners see this", { exact: true }).waitFor();
    assert.equal(await page.getByText('Ownership', { exact: true }).count(), 0);
    await context.close();
    const unset = await fixture({ width: 390, height: 844 }, { contracts: { ...c, safe: null } });
    await unset.page.goto(`${base}/admin`);
    await unset.page.getByText('The Safe is not recorded for this network', { exact: true }).waitFor();
    await unset.context.close();
    const none = await fixture({ width: 390, height: 844 }, { contracts: null });
    await none.page.goto(`${base}/admin`);
    await none.page.getByText(/Hireling v1 is not on .* yet/).waitFor();
    await none.context.close();
    results.push({ checks: ['non-owner: no Admin link, page refuses', 'Safe not configured', 'v1 not deployed'], passed: true });
  }
  assert.deepEqual(errors, []);
  writeFileSync(`${output}/results.json`, JSON.stringify({ tier: 'mocked Chromium only; no live Safe, signing or sends', results, errors }, null, 2));
  console.log(`PASS: admin, ${results.length} evidence records`);
} finally {
  await browser.close();
  await server.close();
}

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { concatHex, encodeFunctionData, encodePacked, parseAbi, size } from 'viem';
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
const multiSendCallOnly = '0x9641d764fc13c8b624c04430c7356c1c7c8102e2';
const safeExec = parseAbi(['function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)']);
/** An epoch-1.json upload as mining:epoch would write it (D17). */
const epochFile = (body) => ({ name: 'epoch-1.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(body)) });
const preValidatedBy = (account) => `0x${account.slice(2).padStart(64, '0')}${'0'.repeat(64)}01`;
// The core the page reads from the testnet config, and the pause pair's calldata as the console would build it.
const coreAddress = JSON.parse(readFileSync(new URL('../../../contracts/config/monad-testnet.json', import.meta.url), 'utf8')).deployment.core;
const pauseAbi = parseAbi(['function pause()', 'function unpause()', 'function notePause()']);
const pauseCall = (functionName) => encodeFunctionData({ abi: pauseAbi, functionName });
const asSafe = (to, data, operation = 0) => ({ description: 'Core.pause + HirelingEvaluator.notePause as the Safe, in one transaction', chainId: 10143, to: c.safe, value: '0', data: encodeFunctionData({ abi: safeExec, functionName: 'execTransaction', args: [to, 0n, data, operation, 0n, 0n, 0n, '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', preValidatedBy(owner)] }) });
const multiSendAbi = parseAbi(['function multiSend(bytes transactions) payable']);
const multiSend = (calls) => encodeFunctionData({ abi: multiSendAbi, functionName: 'multiSend', args: [concatHex(calls.map(([to, data]) => encodePacked(['uint8', 'address', 'uint256', 'uint256', 'bytes'], [0, to, 0n, BigInt(size(data)), data])))] });
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
  await context.addInitScript(({ account, contracts, owners, previousOwner, bytecode, draft }) => {
    const K = 10n ** 21n;
    window.__hireling = contracts;
    window.__bytecode = bytecode;
    if (draft !== null && sessionStorage.getItem('fixture-draft-set') === null) {
      localStorage.setItem(`hireling.admin-op:${account.toLowerCase()}`, JSON.stringify(draft));
      sessionStorage.setItem('fixture-draft-set', '1');
    }
    window.__wallet = { address: account, connected: true, signatures: [], sends: [] };
    localStorage.setItem('agent-jobs.session', 'fixture-only-not-a-real-session');
    localStorage.setItem('agent-jobs.session-owner', JSON.stringify({ address: account, expiresAt: Math.floor(Date.now() / 1000) + 86400 }));
    if (contracts === null) return;
    const owned = [contracts.vault, contracts.holding, contracts.evaluator, contracts.miningReserve, contracts.distributor].map((a) => a.toLowerCase());
    window.__admin = {
      safe: contracts.safe, owners, threshold: 1n,
      owner: Object.fromEntries([...owned.map((a) => [a, contracts.safe]), [contracts.feeSchedule.toLowerCase(), previousOwner]]),
      pendingOwner: { [contracts.feeSchedule.toLowerCase()]: contracts.safe },
      paused: false, pauses: [], safeIsAdmin: true,
      schedule: { thresholds: [0n, 10n * K, 100n * K, 1000n * K], bps: [3000, 1000, 300, 100], treasury: contracts.safe },
      pending: null, bootstrapped: true, pendingHolding: null, holdings: [contracts.holding],
      currentEpoch: 2n, totalFunded: 0n, available: 0n, genesis: Math.floor(Date.now() / 1000) - 3 * 604800, roots: {}, calls: [], down: false,
    };
  }, { account: options.account ?? owner, contracts: options.contracts === undefined ? c : options.contracts, owners: [owner, '0x2222222222222222222222222222222222222222'], previousOwner: deployer, bytecode: options.noMultiSend === true ? {} : { [multiSendCallOnly]: '0x6080604052' }, draft: options.draft ?? null });
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

    // Core: pause and unpause each go as ONE Safe execTransaction, a delegatecall to MultiSendCallOnly that makes the
    // core's call and the Evaluator's notePause together (D13): from this external wallet (no batching), still one
    // transaction, so the pause is noted at the moment it starts.
    const core = section(page, 'Core');
    const before = await page.evaluate(() => window.__wallet.sends.length);
    await core.getByRole('button', { name: 'Pause the core' }).click();
    await page.getByText('pause()', { exact: true }).waitFor();
    await page.getByText('notePause()', { exact: true }).waitFor();
    await page.getByText(/which makes these 2 calls in order\. Both happen, or neither\./).waitFor();
    await page.getByText('1 (delegatecall)', { exact: true }).waitFor();
    await capture(page, `${device}-review-pause`);
    await send(page, 'Pause the core');
    await core.getByText('Paused', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__wallet.sends.length), before + 1);
    assert.deepEqual(await page.evaluate(() => window.__admin.calls.slice(-2).map((x) => `${x.via}:${x.functionName}`)), ['atomic:pause', 'atomic:notePause']);
    assert.ok(await page.evaluate(() => window.__admin.pauses.length === 1 && window.__admin.pauses[0].end === 0));
    await core.getByRole('button', { name: 'Unpause the core' }).click();
    await send(page, 'Unpause the core');
    await core.getByRole('button', { name: 'Pause the core' }).waitFor();
    assert.equal(await page.evaluate(() => window.__wallet.sends.length), before + 2);
    assert.ok(await page.evaluate(() => window.__admin.pauses.length === 1 && window.__admin.pauses[0].end > 0));
    // A pause sent from elsewhere, without the note: the console says so and anyone may send the note alone.
    await page.evaluate(() => { window.__admin.paused = true; window.dispatchEvent(new Event('visibilitychange')); });
    await core.getByText(/The Evaluator has not noted this pause/).waitFor();
    await core.getByRole('button', { name: 'Note the pause' }).click();
    await send(page, 'Note the pause on the Evaluator');
    await core.getByText(/The Evaluator has not noted this pause/).waitFor({ state: 'hidden' });
    assert.deepEqual(await last(page), { via: 'direct', to: c.evaluator, functionName: 'notePause', signatures: null });
    await page.evaluate(() => { window.__admin.paused = false; window.__admin.pauses.at(-1).end = Math.floor(Date.now() / 1000); window.dispatchEvent(new Event('visibilitychange')); });
    await core.getByRole('button', { name: 'Pause the core' }).waitFor();

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
    await fees.getByText(/^Executable now, by anyone, until/).waitFor();
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
    await holdings.getByText(/Expires at/).waitFor();
    assert.equal(await holdings.getByRole('button', { name: 'Accept', exact: true }).isDisabled(), true);
    // Past its grace window (7 days after the eta) the vault refuses it: shown as expired, not acceptable.
    await page.evaluate(() => { window.__admin.pendingHolding.eta = Math.floor(Date.now() / 1000) - 8 * 86400; window.dispatchEvent(new Event('visibilitychange')); });
    await holdings.getByText(/^Expired at .*Cancel it, or propose again\.$/).waitFor();
    assert.equal(await holdings.getByRole('button', { name: 'Accept', exact: true }).isDisabled(), true);
    await holdings.getByRole('button', { name: 'Review the revocation' }).click();
    await page.getByText('revokeHolding(holding)', { exact: true }).waitFor();
    await send(page, 'Revoke a Holding');
    await holdings.getByText('Not authorized', { exact: true }).waitFor();
    await capture(page, `${device}-holdings`);

    // Mining: the root for the last ended epoch, then its funding, both from the epoch file mining:epoch wrote (D17),
    // never typed by hand. A file for another chain is refused; the shape is read loosely until contracts pins it.
    const mining = section(page, 'Mining');
    assert.equal(await mining.getByRole('textbox', { name: 'Epoch', exact: true }).inputValue(), '1');
    const root = `0x${'ab'.repeat(32)}`;
    const dataHash = `0x${'cd'.repeat(32)}`;
    const total = (5000n * 10n ** 18n).toString();
    const file = { chainId: 10143, epoch: 1, window: { start: 0, end: 1 }, priceList: {}, budget: total, emission: total, total, root, dataHash, inputs: {}, tree: { values: [{}, {}] } };
    assert.equal(await mining.getByRole('textbox', { name: 'Merkle root' }).count(), 0);
    await mining.getByLabel('Epoch file').setInputFiles(epochFile({ ...file, chainId: 143 }));
    await mining.getByText('epoch-1.json: It is for chain 143, not this network (10143).', { exact: true }).waitFor();
    assert.equal(await mining.getByRole('button', { name: 'Review the root' }).count(), 0);
    await mining.getByLabel('Epoch file').setInputFiles(epochFile(file));
    await mining.getByText('epoch-1.json', { exact: true }).waitFor();
    await mining.getByText(dataHash, { exact: true }).waitFor();
    await capture(page, `${device}-mining-file`);
    await mining.getByRole('button', { name: 'Review the root' }).click();
    await page.getByText('setRoot(epoch, root, total, dataHash)', { exact: true }).waitFor();
    await page.getByText(total, { exact: true }).first().waitFor();
    await send(page, 'Post the root of epoch 1');
    await mining.getByRole('button', { name: 'Review the root' }).waitFor({ state: 'hidden' });
    await mining.getByText(root, { exact: true }).nth(1).waitFor();
    await mining.getByRole('button', { name: 'Review funding · 5,000 FACTORY' }).click();
    await page.getByText('fund(epoch, amount)', { exact: true }).waitFor();
    await send(page, 'Fund epoch 1');
    await mining.getByText(/^Spare in the distributor\s*5,000 FACTORY$/).waitFor();
    // The posted total overstated the leaves: shrink it to their sum, never above the posted total.
    await mining.getByRole('textbox', { name: 'New epoch total' }).fill('6000');
    await mining.getByText('The new total must be below the posted one.', { exact: true }).waitFor();
    await mining.getByRole('textbox', { name: 'New epoch total' }).fill('4200');
    await mining.getByRole('button', { name: 'Review the new total' }).click();
    await page.getByText('resizeRoot(epoch, newTotal)', { exact: true }).waitFor();
    await send(page, 'Shrink the total of epoch 1');
    await mining.getByText('0 FACTORY of 4,200 FACTORY', { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__admin.calls.map((call) => `${call.via}:${call.functionName}`)), [
      'safe:acceptOwnership', 'atomic:pause', 'atomic:notePause', 'atomic:unpause', 'atomic:notePause', 'direct:notePause', 'safe:propose', 'safe:cancel', 'safe:propose', 'direct:execute', 'safe:proposeHolding', 'safe:revokeHolding', 'safe:setRoot', 'safe:fund', 'safe:resizeRoot',
    ]);
    await capture(page, `${device}-mining`);
    results.push({ device, checks: ['owner sees Admin in Me', 'acceptOwnership via Safe with pre-validated signature', 'pause and unpause each one Safe tx through MultiSendCallOnly with notePause, from an external wallet', 'unnoted pause warned and noted directly', 'fee proposal refused rules', 'fee timelock countdown', 'cancel', 'execute direct by anyone', 'Holding refused before 8 days', 'revoke', 'epoch file from another chain refused', 'setRoot and fund from the epoch file, no typed fields', 'decoded review before every send'], passed: true });
    await context.close();
  }

  // A restored draft is read again from its calldata: one that calls outside the deployment, or is signed for another
  // owner, is refused and never offered to the wallet, whatever its stored description says.
  {
    const foreign = encodeFunctionData({ abi: parseAbi(['function transfer(address to, uint256 amount)']), functionName: 'transfer', args: [stranger, 10n ** 24n] });
    const tampered = (to, data, signer) => ({ txs: [{ description: 'FeeSchedule.acceptOwnership as the Safe', chainId: 10143, to: c.safe, value: '0', data: encodeFunctionData({ abi: safeExec, functionName: 'execTransaction', args: [to, 0n, data, 0, 0n, 0n, 0n, '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', preValidatedBy(signer)] }) }] });
    for (const [draft, problem] of [
      [tampered(c.factory, foreign, owner), /which is not a Hireling contract in this deployment/],
      [tampered(c.feeSchedule, '0x79ba5097', stranger), /It is not signed as you, the signed-in Safe owner\./],
    ]) {
      const { context, page } = await fixture({ width: 390, height: 844 }, { draft });
      await page.goto(`${base}/admin`);
      await page.getByRole('alert').filter({ hasText: problem }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Confirm in your wallet', exact: true }).count(), 0);
      assert.equal(await page.getByText('Review and send', { exact: true }).count(), 0);
      await capture(page, 'tampered-draft');
      await page.getByRole('button', { name: 'Discard it' }).click();
      await page.getByRole('alert').waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => window.__wallet.sends.length), 0);
      await context.close();
    }
    // U5-SEC-002: a correctly signed pause restored alone, or split from its note over two transactions, is refused;
    // the atomic pair through MultiSendCallOnly reads back and is offered.
    for (const [txs, problem] of [
      [[asSafe(coreAddress, pauseCall('pause'))], /Core\.pause goes out only with the Evaluator’s notePause, as one MultiSend transaction\./],
      [[asSafe(coreAddress, pauseCall('unpause'))], /Core\.unpause goes out only with the Evaluator’s notePause/],
      [[asSafe(coreAddress, pauseCall('pause')), asSafe(c.evaluator, pauseCall('notePause'))], /Core\.pause goes out only with the Evaluator’s notePause/],
    ]) {
      const { context, page } = await fixture({ width: 390, height: 844 }, { draft: { txs } });
      await page.goto(`${base}/admin`);
      await page.getByRole('alert').filter({ hasText: problem }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Confirm in your wallet', exact: true }).count(), 0);
      assert.equal(await page.getByText('Review and send', { exact: true }).count(), 0);
      assert.equal(await page.evaluate(() => window.__wallet.sends.length), 0);
      await context.close();
    }
    {
      const { context, page } = await fixture({ width: 390, height: 844 }, { draft: { txs: [asSafe(multiSendCallOnly, multiSend([[coreAddress, pauseCall('pause')], [c.evaluator, pauseCall('notePause')]]), 1)] } });
      await page.goto(`${base}/admin`);
      await page.getByText('Review and send', { exact: true }).waitFor();
      await page.getByText('pause()', { exact: true }).waitFor();
      await page.getByText('notePause()', { exact: true }).waitFor();
      assert.equal(await page.getByRole('alert').filter({ hasText: 'Saved operation refused' }).count(), 0);
      await capture(page, 'restored-atomic-pair');
      await context.close();
    }

    // Without MultiSendCallOnly on the network, the pause pair is not offered at all.
    const { context, page } = await fixture({ width: 390, height: 844 }, { noMultiSend: true });
    await page.goto(`${base}/admin`);
    await section(page, 'Core').getByText(/Pausing waits for MultiSendCallOnly/).waitFor();
    assert.equal(await section(page, 'Core').getByRole('button', { name: 'Pause the core' }).isDisabled(), true);
    await context.close();
    results.push({ checks: ['restored draft calling outside the deployment refused, not sent', 'restored draft signed for another owner refused', 'restored standalone pause and unpause refused (U5-SEC-002)', 'restored pause and note as two transactions refused', 'restored atomic pause pair accepted', 'no MultiSendCallOnly code: pause not offered'], passed: true });
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

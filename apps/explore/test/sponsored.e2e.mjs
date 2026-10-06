import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { concat, encodeAbiParameters, encodeFunctionData, encodePacked } from 'viem';
import { createServer } from 'vite';
import { epochDistributorAbi } from '../../../packages/sdk/src/abi/epochDistributor.ts';
import { holdingAbi, sponsorshipGrantTerms, vaultAbi } from './grant-fixture.mjs';

// Sponsored sends (U7b) on the Collect tab, against a fixture board with B6's sponsor_submit shape (20:26): a step
// the signed delegation covers goes through Sidequest's relay with no wallet prompt and a caller key; a lost answer is
// asked again with the same key (one operation, never two); refusals for the cap and a failing simulation, and a
// reverted relay transaction, fall back to the wallet with the reason; a step outside the policy opens the wallet; a
// reload mid-send picks the same key up again, and a transaction not mined yet is checked again, not resent.
// Mocked Chromium only: no live board, relay, signing or sends.
const directory = fileURLToPath(new URL('.', import.meta.url));
const output = process.argv[2] ?? '/tmp/sidequest-sponsored-evidence';
const base = 'http://127.0.0.1:5203';
const me = '0x1111111111111111111111111111111111111111';
const config = JSON.parse(readFileSync(new URL('../../../contracts/config/monad-testnet.json', import.meta.url), 'utf8'));
const d = config.deployment;
const contracts = { factory: '0xf000000000000000000000000000000000000001', vault: '0xf000000000000000000000000000000000000002', feeSchedule: '0xf000000000000000000000000000000000000003', distributor: '0xf000000000000000000000000000000000000004', miningReserve: '0xf000000000000000000000000000000000000005', holding: '0xf000000000000000000000000000000000000006', evaluator: '0xf000000000000000000000000000000000000007', safe: '0xf000000000000000000000000000000000000008' };
const grantTerms = sponsorshipGrantTerms(contracts);
const tx = (description, to, data) => ({ description, chainId: 10143, to, data, value: '0' });
const ACTIONS = [
  { kind: 'settle', jobId: '72', description: 'The rejection is final: this releases the escrow and the deposits at risk.', transactions: [tx('Settle job #72', contracts.holding, encodeFunctionData({ abi: holdingAbi, functionName: 'settle', args: [72n] }))] },
  { kind: 'claimTopUpRefund', jobId: '71', token: d.rewardTokens[0], amount: '2000000', description: 'The creator was refunded, so your top-up comes back to you.', transactions: [tx('Claim your top-up back', contracts.holding, encodeFunctionData({ abi: holdingAbi, functionName: 'claimTopUpRefund', args: [71n, me] }))] },
  { kind: 'stakeWithdraw', token: d.factory, amount: (2000n * 10n ** 18n).toString(), description: 'Your backing cooldown has ended.', transactions: [tx('Withdraw unstaked SIDE', contracts.vault, encodeFunctionData({ abi: vaultAbi, functionName: 'withdraw', args: [me] }))] },
  { kind: 'miningClaim', epoch: '0', token: d.factory, amount: (1234n * 10n ** 18n).toString(), description: 'Your share of epoch 0.', transactions: [tx('Claim epoch 0', contracts.distributor, encodeFunctionData({ abi: epochDistributorAbi, functionName: 'claim', args: [0n, me, 1234n * 10n ** 18n, []] }))] },
];

// The wallet's signed delegation to the relay uses the SDK work grant's targets and methods,
// with the fixture's 100-call, one-day limit and no value.
const uint = (x) => encodeAbiParameters([{ type: 'uint256' }], [x]);
const caveat = (enforcer, terms) => ({ enforcer, terms, args: '0x' });
const typedData = JSON.stringify({
  types: { EIP712Domain: [], Delegation: [], Caveat: [] },
  primaryType: 'Delegation',
  domain: { name: 'DelegationManager', version: '1', chainId: 10143, verifyingContract: config.delegation.manager },
  message: {
    delegate: config.roles.relay, delegator: me, authority: `0x${'f'.repeat(64)}`, salt: '1',
    caveats: [
      caveat(config.delegation.enforcers.allowedTargets, concat(grantTerms.targets)),
      caveat(config.delegation.enforcers.allowedMethods, grantTerms.methods),
      caveat(config.delegation.enforcers.limitedCalls, uint(100n)),
      caveat(config.delegation.enforcers.timestamp, encodePacked(['uint128', 'uint128'], [0n, BigInt(Math.floor(Date.now() / 1000) + 86400)])),
      caveat(config.delegation.enforcers.valueLte, uint(0n)),
    ],
  },
});
const delegationHash = `0x${'d'.repeat(64)}`;

const results = [];
const errors = [];

process.env.PRIVY_APP_ID = 'fixture-privy-app-id';
const server = await createServer({ envFile: false, server: { host: '127.0.0.1', port: 5203, strictPort: true }, plugins: [{ name: 'sponsored-fixtures', enforce: 'pre', resolveId(source) {
  if (source === 'wagmi') return `${directory}wagmi.mjs`;
  if (source === 'wagmi/actions') return `${directory}wagmi-actions.mjs`;
  if (source.endsWith('/Privy.tsx')) return `${directory}privy.mjs`;
  if (source === '@privy-io/react-auth') return `${directory}privy-react-auth.mjs`;
}, transform(source, id) {
  if (id.endsWith('/src/sidequest.ts')) return source.replace(/export const sidequest: SidequestContracts =[\s\S]*?(\n\n|\n?$)/, 'export const sidequest: SidequestContracts = (window as { __sidequest: SidequestContracts }).__sidequest$1');
} }] });
await server.listen();
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/home/kristjan/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome' });
mkdirSync(output, { recursive: true });

/**
 * A board whose sponsor_submit follows `state.script`: one entry per request, `lose` (the connection drops), a refusal
 * reason, `reverted`, or `ok` (default). Operations are keyed on (wallet, key) like B6; the same key returns the same one.
 */
async function fixture(viewport, options = {}) {
  const context = await browser.newContext({ viewport, hasTouch: viewport.width === 390, isMobile: viewport.width === 390 });
  await context.addInitScript(({ account, sidequest }) => {
    window.__sidequest = sidequest;
    window.__wallet = { address: account, connected: true, signatures: [], sends: [] };
    localStorage.setItem('sidequest.session', 'fixture-only-not-a-real-session');
    localStorage.setItem('sidequest.session-owner', JSON.stringify({ address: account, expiresAt: Math.floor(Date.now() / 1000) + 86400 }));
  }, { account: me, sidequest: contracts });
  const state = { actions: options.actions ?? [...ACTIONS], collecting: null, script: [], submits: [], operations: new Map(), callsUsed: 0, receiptDown: false };
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort('blockedbyclient');
    const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/__test/receipt') {
      if (state.receiptDown) return reply({ message: 'not mined' }, 503);
      state.actions = state.actions.filter((a) => a.kind !== state.collecting);
      return reply({ status: 'success' });
    }
    if (url.pathname.endsWith('/api/collect_actions')) return reply({ ok: true, result: state.actions });
    if (url.pathname.endsWith('/api/sponsor_status')) {
      assert.deepEqual(route.request().postDataJSON(), { wallet: me });
      return reply({ ok: true, result: { status: 'live', typedData, delegationHash, callsUsed: state.callsUsed } });
    }
    if (url.pathname.endsWith('/api/sponsor_submit')) {
      const body = route.request().postDataJSON();
      state.submits.push(body);
      const step = state.script.shift() ?? 'ok';
      if (step === 'lose') return route.abort('connectionreset');
      if (['cap', 'floor', 'rate', 'simulation', 'pending'].includes(step)) return reply({ ok: false, code: step === 'simulation' ? 'chain' : 'conflict', reason: step, message: `refused: ${step}` }, 409);
      // The hosted rate limit answers before the tool runs: a code, no reason, and it cannot see the key.
      if (step === 'rate-limited') return reply({ ok: false, code: 'rate-limited', message: 'too many requests' }, 429);
      const id = `${body.wallet}:${body.key}`;
      // The relay's nonce went to another transaction: the saved one has no receipt and never mines (B6 21:27).
      if (state.dropExisting && state.operations.has(id)) state.operations.get(id).status = 'dropped';
      if (!state.operations.has(id)) {
        const n = state.operations.size + 1;
        state.operations.set(id, { operationId: `0x${n.toString(16).padStart(64, 'a')}`, status: step === 'reverted' ? 'reverted' : 'pending', txHash: `0x${n.toString(16).padStart(64, 'b')}`, callsUsed: (state.callsUsed += body.entries.reduce((total, entry) => total + entry.calls.length, 0)) });
      }
      return reply({ ok: true, result: state.operations.get(id) });
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

const KEY = /^[A-Za-z0-9_-]{1,128}$/;
const sends = (page) => page.evaluate(() => window.__wallet.sends.length);

try {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    const device = viewport.width === 390 ? 'mobile' : 'desktop';
    const { context, page, state } = await fixture(viewport);
    await page.goto(`${base}/collect`);
    await page.getByText('Settle job #72', { exact: true }).waitFor();

    // The settle goes through the relay: no wallet prompt. The first answer is lost; asking again with the same key
    // returns the one operation, which is followed to the chain.
    state.collecting = 'settle';
    state.script = ['lose'];
    await page.getByRole('button', { name: 'Collect', exact: true }).first().click();
    await page.getByRole('status').filter({ hasText: 'Settled' }).waitFor();
    assert.equal(state.submits.length, 2);
    assert.match(state.submits[0].key, KEY);
    assert.equal(state.submits[1].key, state.submits[0].key);
    assert.deepEqual(state.submits[0].entries, [{ grant: delegationHash, calls: [{ to: contracts.holding, data: ACTIONS[0].transactions[0].data, value: '0' }] }]);
    assert.equal(state.operations.size, 1);
    assert.equal(await sends(page), 0);
    await page.getByText('Settle job #72', { exact: true }).waitFor({ state: 'hidden' });

    // Sidequest's daily budget is used up: the refusal says so and the wallet sends it, with its gas limit.
    state.collecting = 'claimTopUpRefund';
    state.script = ['cap'];
    await page.getByRole('button', { name: 'Collect', exact: true }).first().click();
    await page.getByRole('status').filter({ hasText: 'Sidequest’s gas budget for today is used up, so these go from your wallet; you pay the gas.' }).waitFor();
    await capture(page, `${device}-sponsor-cap`);
    await page.getByRole('button', { name: 'Confirm in your wallet', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm fixture' }).click();
    await page.getByRole('status').filter({ hasText: 'Top-up refunded' }).waitFor();
    assert.equal(await sends(page), 1);
    assert.equal(await page.evaluate(() => String(window.__wallet.sends.at(-1).gas)), '450000');

    // A failing simulation sends nothing and says why; asked again (a new key, nothing was made), the relay's
    // transaction reverts, and the wallet is offered with the reverted transaction linked.
    state.collecting = 'stakeWithdraw';
    state.script = ['simulation', 'reverted'];
    await page.getByRole('button', { name: 'Collect', exact: true }).first().click();
    await page.getByText('Sidequest checked these steps against the chain and they would fail, so nothing was sent.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Pay the gas yourself instead' }).waitFor();
    await page.getByRole('button', { name: 'Try again' }).click();
    await page.getByRole('status').filter({ hasText: 'Sidequest sent these steps and the transaction reverted, so nothing changed.' }).waitFor();
    const [simulated, reverted] = state.submits.slice(-2);
    assert.notEqual(simulated.key, reverted.key);
    await page.getByRole('button', { name: 'Confirm in your wallet', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm fixture' }).click();
    await page.getByRole('status').filter({ hasText: 'Withdrawn to your wallet' }).waitFor();
    assert.equal(await sends(page), 2);

    // A call outside the signed delegation (the distributor) opens the wallet at once; the relay is not asked.
    state.collecting = 'miningClaim';
    const before = state.submits.length;
    await page.getByRole('button', { name: 'Collect', exact: true }).first().click();
    await page.getByRole('button', { name: 'Confirm fixture' }).click();
    await page.getByRole('status').filter({ hasText: 'Claimed into your backing' }).waitFor();
    assert.equal(state.submits.length, before);
    assert.equal(await sends(page), 3);
    await page.getByText('Nothing to collect', { exact: true }).waitFor();
    results.push({ device, checks: ['sponsored settle: no wallet prompt, caller key', 'lost answer asked again with the same key, one operation', 'cap refusal: reason shown, wallet sends with D4b gas', 'simulation refusal: nothing sent, reason, try again', 'retry after a refusal uses a new key', 'reverted relay tx: wallet offered with the hash', 'outside the policy: wallet, relay not asked'], passed: true });
    await context.close();
  }

  // A refusal after a lost answer proves nothing about the first request (the hosted rate limit cannot see the key):
  // the step stays unknown and is never sent from the wallet on top; checking again finds the one operation.
  {
    const { context, page, state } = await fixture({ width: 390, height: 844 }, { actions: [ACTIONS[1]] });
    await page.goto(`${base}/collect`);
    state.collecting = 'claimTopUpRefund';
    state.script = ['lose', 'rate-limited'];
    await page.getByRole('button', { name: 'Collect', exact: true }).click();
    await page.getByText(/Sidequest’s relay did not answer/).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Confirm in your wallet', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Check again' }).click();
    await page.getByRole('status').filter({ hasText: 'Top-up refunded' }).waitFor();
    assert.equal(new Set(state.submits.map((x) => x.key)).size, 1);
    assert.equal(await sends(page), 0);
    results.push({ checks: ['refusal after a lost answer stays unknown, no wallet fallback', 'check again: same key, done'], passed: true });
    await context.close();
  }

  // Dropped (B6 21:27): the relay's transaction is not mined, a check finds its nonce consumed, nothing happened. The
  // wallet is offered with the dropped hash, and the next sponsored action carries a new key, never the dropped one.
  {
    const { context, page, state } = await fixture({ width: 390, height: 844 }, { actions: [ACTIONS[0], ACTIONS[2]] });
    await page.goto(`${base}/collect`);
    state.collecting = 'settle';
    state.receiptDown = true;
    await page.getByRole('button', { name: 'Collect', exact: true }).first().click();
    await page.getByText('Sidequest’s relay sent it and Monad has not mined it yet. Check again in a moment.', { exact: true }).waitFor({ timeout: 90_000 });
    const dropped = state.submits[0].key;
    state.dropExisting = true;
    state.receiptDown = false;
    const submitsBeforeCheck = state.submits.length;
    await page.getByRole('button', { name: 'Check again' }).click();
    await page.getByRole('status').filter({ hasText: 'Sidequest’s relay transaction was replaced before it was mined, so nothing happened.' }).waitFor();
    assert.equal(state.submits.length, submitsBeforeCheck + 1, 'recheck asks the relay about the saved operation before following its hash');
    await capture(page, 'sponsor-dropped');
    assert.equal(state.submits.at(-1).key, dropped);
    await page.getByRole('button', { name: 'Confirm in your wallet', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm fixture' }).click();
    await page.getByRole('status').filter({ hasText: 'Settled' }).waitFor();
    assert.equal(await sends(page), 1);
    state.dropExisting = false;
    state.collecting = 'stakeWithdraw';
    await page.getByRole('button', { name: 'Collect', exact: true }).first().click();
    await page.getByRole('status').filter({ hasText: 'Withdrawn to your wallet' }).waitFor();
    assert.notEqual(state.submits.at(-1).key, dropped);
    assert.equal(await sends(page), 1);
    results.push({ checks: ['not mined, then dropped on check: nothing happened, wallet offered with the hash', 'the dropped key is never reused', 'next sponsored action has a new key'], passed: true });
    await context.close();
  }

  // The relay never answers: the step says so and offers a check. After a reload the same key is picked up again; the
  // relay's transaction is not mined yet, so it is checked again (same key, same operation), never resent.
  {
    const { context, page, state } = await fixture({ width: 390, height: 844 }, { actions: [ACTIONS[0]] });
    await page.goto(`${base}/collect`);
    state.collecting = 'settle';
    state.script = Array.from({ length: 6 }, () => 'lose');
    await page.getByRole('button', { name: 'Collect', exact: true }).click();
    await page.getByText('Sidequest’s relay did not answer, so whether it sent these steps is unknown. Check again: the relay never sends the same steps twice.', { exact: true }).waitFor({ timeout: 30_000 });
    await capture(page, 'sponsor-lost');
    const key = state.submits[0].key;
    assert.ok(state.submits.every((s) => s.key === key));
    await page.reload();
    await page.getByRole('button', { name: 'Collect', exact: true }).click();
    await page.getByText(/Sidequest’s relay did not answer/).waitFor();
    state.receiptDown = true;
    await page.getByRole('button', { name: 'Check again' }).click();
    await page.getByText('Sidequest’s relay sent it and Monad has not mined it yet. Check again in a moment.', { exact: true }).waitFor();
    state.receiptDown = false;
    await page.getByRole('button', { name: 'Check again' }).click();
    await page.getByRole('status').filter({ hasText: 'Settled' }).waitFor();
    assert.ok(state.submits.every((s) => s.key === key), 'every request for this step carried its one key');
    assert.equal(state.operations.size, 1);
    assert.equal(await sends(page), 0);
    results.push({ checks: ['no answer: unknown, check again', 'reload keeps the key', 'not mined yet: checked again with the same key', 'one operation, no wallet send'], passed: true });
    await context.close();
  }
  assert.deepEqual(errors, []);
  writeFileSync(`${output}/results.json`, JSON.stringify({ tier: 'mocked Chromium only; no live board, relay, signing or sends', results, errors }, null, 2));
  console.log(`PASS: sponsored, ${results.length} evidence records`);
} finally {
  await browser.close();
  await server.close();
}

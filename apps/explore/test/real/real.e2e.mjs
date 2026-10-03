import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { concat, decodeFunctionResult, encodeFunctionData, pad, parseAbi } from 'viem';
import { createServer } from 'vite';

// U-REAL: Explore's chain pages against a real chain: an anvil fork of Monad testnet with Hireling v1 deployed by
// contracts' own launch-testnet.sh and one hire settled (test/real/fork.sh up). Every chain read and write goes to the
// fork through Explore's real wagmi config; the wallet is an injected dev-key wallet that anvil signs for. Only the
// board's tools (sponsorship status, transaction reports) stay fixtures. Pages:
//   /stake  stake with permit, a reservation, unstake, cooldown, cancel;
//   /admin  fee proposal review and execute after 3 days, pause + notePause as one MultiSend, the epoch price list,
//           `pnpm mining:epoch 0` on the fork's hire, funding signed for the live Safe nonce (refused once another Safe
//           transaction goes first, and refused by the Safe itself), and setRoot from the file.
// Off unless HIRELING_REAL=1, so pnpm check never runs it:
//   bash apps/explore/test/real/fork.sh up && (cd apps/explore && HIRELING_REAL=1 node test/real/real.e2e.mjs) ; bash apps/explore/test/real/fork.sh down
if (process.env.HIRELING_REAL !== '1') {
  console.log('SKIP: real-chain e2e (run test/real/fork.sh up, then HIRELING_REAL=1)');
  process.exit(0);
}

const directory = fileURLToPath(new URL('.', import.meta.url));
const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const stateDir = process.env.STATE_DIR ?? '/tmp/hireling-real';
const output = process.argv[2] ?? `${stateDir}/evidence`;
const state = JSON.parse(readFileSync(`${stateDir}/state.json`, 'utf8'));
const config = JSON.parse(readFileSync(state.config, 'utf8'));
const h = config.deployment.hireling;
const base = 'http://127.0.0.1:5210';
const W = 10n ** 18n;
const { owner1, owner2, staker } = state.accounts;
const results = [];
const errors = [];
let current = null;
mkdirSync(output, { recursive: true });

// The fork, from node: reads, time, and sends from anvil's unlocked accounts (or an impersonated contract).
let rpcId = 0;
async function rpc(method, params = []) {
  const response = await fetch(state.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  const body = await response.json();
  if (body.error !== undefined) throw Object.assign(new Error(body.error.message), { data: body.error.data });
  return body.result;
}
const read = async (to, signature, args = []) => {
  const abi = parseAbi([signature]);
  const data = await rpc('eth_call', [{ to, data: encodeFunctionData({ abi, args }) }, 'latest']);
  return decodeFunctionResult({ abi, data });
};
async function send(from, to, data) {
  const hash = await rpc('eth_sendTransaction', [{ from, to, data }]);
  for (let i = 0; i < 60; i++) {
    const receipt = await rpc('eth_getTransactionReceipt', [hash]);
    if (receipt !== null) { assert.equal(receipt.status, '0x1', `${to} reverted`); return receipt; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`no receipt for ${hash}`);
}
// The fork's time now: mine a block first, since after a revert the latest block is the snapshot's, while the next
// one is stamped with the current time.
async function chainNow() {
  await rpc('evm_mine');
  return Number(BigInt((await rpc('eth_getBlockByNumber', ['latest', false])).timestamp));
}
async function warp(seconds) {
  await rpc('evm_increaseTime', [seconds]);
  await rpc('evm_mine');
  // mining:epoch reads up to the finalized head, which on anvil trails latest by 64 blocks.
  await rpc('anvil_mine', ['0x41']);
}
const preValidatedBy = (owner) => concat([pad(owner, { size: 32 }), pad('0x00', { size: 32 }), '0x01']);
const safeExec = parseAbi(['function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)']);

/** Every page starts from the state fork.sh left: revert to its snapshot, and take a fresh one (a snapshot is used once). */
async function fresh() {
  assert.equal(await rpc('evm_revert', [state.snapshot]), true, 'the fork could not revert to its snapshot; run fork.sh down and up');
  state.snapshot = await rpc('evm_snapshot');
  writeFileSync(`${stateDir}/state.json`, JSON.stringify(state, null, 2));
}
const nonceOf = async (account) => Number(BigInt(await rpc('eth_getTransactionCount', [account, 'latest'])));

process.env.PRIVY_APP_ID = 'real-e2e-devwallet';
process.env.AGENT_JOBS_NETWORK = 'monad-testnet';
const server = await createServer({ envFile: false, server: { host: '127.0.0.1', port: 5210, strictPort: true }, plugins: [{ name: 'real-chain', enforce: 'pre', resolveId(source) {
  if (source.endsWith('/Privy.tsx')) return `${directory}devwallet.mjs`;
  if (source === '@privy-io/react-auth') return `${directory}../privy-react-auth.mjs`;
}, transform(source, id) {
  // The fork's deployment (launch-testnet.sh's promoted config) in place of testnet's, and the fork as the RPC.
  if (id.endsWith("/contracts/config/monad-testnet.json")) return JSON.stringify(config);
  if (id.endsWith('/src/wallet.ts')) {
    // The chain's http() transport, wherever the transports line puts it (it is `deployed ? http() : …`).
    const next = source.replace(/(transports: \{ \[chain\.id\]:[^\n]*?)\bhttp\(\)/, `$1http(${JSON.stringify(state.rpc)})`);
    assert.notEqual(next, source, 'wallet.ts transport not found');
    return next;
  }
} }] });
await server.listen();
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/home/kristjan/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome' });

/** A page whose injected wallet is `account` (an anvil dev account) and whose clock reads the fork's time. */
async function open(account, viewport = { width: 1280, height: 900 }) {
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  await context.clock.install({ time: (await chainNow()) * 1000 });
  await context.addInitScript(({ rpcUrl, address }) => {
    let id = 0;
    const log = [];
    window.__devwallet = { address, log };
    window.ethereum = {
      async request({ method, params = [] }) {
        log.push(method);
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [address];
        if (method === 'eth_chainId') return '0x279f';
        if (method === 'wallet_switchEthereumChain') return null;
        if (method.startsWith('wallet_')) throw Object.assign(new Error(`The dev wallet does not support ${method}`), { code: 4200 });
        const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
        const body = await response.json();
        if (body.error !== undefined) throw Object.assign(new Error(body.error.message), { code: body.error.code, data: body.error.data });
        return body.result;
      },
      on() {},
      removeListener() {},
    };
  }, { rpcUrl: state.rpc, address: account });
  const rpcOrigin = new URL(state.rpc).origin;
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === rpcOrigin) return route.continue();
    if (url.origin !== base) return route.abort('blockedbyclient');
    const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    // Board-hosted tools stay fixtures: no sponsorship, reports accepted, nothing else answered.
    if (url.pathname.endsWith('/api/sponsor_status')) return reply({ ok: true, result: { status: 'none', typedData: null, callsUsed: 0 } });
    if (url.pathname.endsWith('/api/report_transaction')) return reply({ ok: true, result: { ok: true } });
    if (url.pathname.endsWith('/api/task_index')) return reply({ ok: true, result: [] });
    if (url.pathname.includes('/api/')) return reply({ ok: false, code: 'not-found', message: 'Not in the real-chain fixture' }, 404);
    if (url.pathname === '/data/jobs') return reply({ ok: true, jobs: [], index: { next_block: 100, updated_at: Math.floor(Date.now() / 1000) } });
    if (url.pathname.startsWith('/data/')) return reply({ ok: true, agents: [], jobs: [], boards: [], next: null });
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  current = page;
  return { context, page };
}
/** After a warp: the page's clock jumps to the fork's time, and its reads are asked again. */
async function sync(page) {
  await page.clock.setSystemTime((await chainNow()) * 1000);
  await page.reload();
}
async function capture(page, name) {
  await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
}
const section = (page, title) => page.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
const toast = (page, text, timeout = 30_000) => page.getByRole('status').filter({ hasText: text }).waitFor({ timeout });
/** "Confirm in your wallet": the dev wallet signs or sends at once; the step's own toast says it landed. */
async function confirm(page, done) {
  await page.getByRole('button', { name: 'Confirm in your wallet', exact: true }).click();
  await toast(page, done);
}
const record = (name, checks, passed = true, problem = null) => results.push({ page: name, passed, checks, ...(problem === null ? {} : { problem }) });

async function stakePage() {
  const { context, page } = await open(staker);
  const sentBefore = await nonceOf(staker);
  const vault = h.vault;
  await page.goto(`${base}/stake`);
  await page.getByRole('heading', { name: 'Stake', level: 1 }).waitFor();
  await page.getByText('50,000 FACTORY', { exact: true }).first().waitFor({ timeout: 30_000 });
  await capture(page, 'stake-start');

  // Stake with a permit: one signature (eth_signTypedData_v4 by anvil), then stakeWithPermit.
  await page.locator('#stake-amount').fill('20000');
  await page.getByRole('button', { name: 'Stake 20,000 FACTORY', exact: true }).click();
  await confirm(page, 'Staked. Your fee tier counts it now.');
  assert.equal(await read(vault, 'function stakeOf(address) view returns (uint256)', [staker]), 20_000n * W);
  const methods = await page.evaluate(() => window.__devwallet.log.filter((m) => m.startsWith('eth_sign') || m === 'eth_sendTransaction'));
  assert.deepEqual(methods, ['eth_signTypedData_v4', 'eth_sendTransaction']);
  await page.getByText('20,000 FACTORY', { exact: true }).first().waitFor();

  // A reservation, as a Holding makes one for a bond (the Holding impersonated on the fork).
  const holding = config.deployment.main.holding;
  await rpc('anvil_impersonateAccount', [holding]);
  await rpc('anvil_setBalance', [holding, '0x56bc75e2d63100000']);
  await send(holding, vault, encodeFunctionData({ abi: parseAbi(['function reserve(address account, uint256 amount)']), functionName: 'reserve', args: [staker, 5n * W] }));
  await rpc('anvil_stopImpersonatingAccount', [holding]);
  await page.reload();
  await page.getByText('5 FACTORY', { exact: true }).first().waitFor();
  await page.getByRole('radio', { name: 'Unstake' }).click();
  await page.locator('#stake-amount').fill('20000');
  await page.getByText(/reserved stake stays until its jobs settle/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Unstake 20,000 FACTORY' }).isDisabled(), true);
  await capture(page, 'stake-reserved');

  // Unstake: the cooldown starts, with the countdown from the vault's unlock time.
  await page.locator('#stake-amount').fill('1000');
  await page.getByRole('button', { name: 'Unstake 1,000 FACTORY' }).click();
  await confirm(page, 'Unstaking started. The cooldown is running.');
  await page.getByText(/Withdrawable in 6 d 23 h/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Withdraw', exact: true }).isDisabled(), true);
  await capture(page, 'stake-cooldown');

  // Keep it staked: cancelUnstake restakes it.
  await page.getByRole('button', { name: 'Keep it staked' }).click();
  await confirm(page, 'Unstaking cancelled. It is staked again.');
  assert.equal(await read(vault, 'function stakeOf(address) view returns (uint256)', [staker]), 20_000n * W);
  assert.equal(await page.getByRole('button', { name: 'Keep it staked' }).count(), 0);

  // After the cooldown, on chain time, withdraw.
  await page.getByRole('radio', { name: 'Unstake' }).click();
  await page.locator('#stake-amount').fill('1000');
  await page.getByRole('button', { name: 'Unstake 1,000 FACTORY' }).click();
  await confirm(page, 'Unstaking started. The cooldown is running.');
  // The first unstake's toast may still be up, so wait for this request on chain before moving time past its cooldown.
  await page.getByText(/Withdrawable in 6 d 23 h/).waitFor({ timeout: 30_000 });
  await warp(7 * 86400 + 60);
  await sync(page);
  await page.getByText('Ready to withdraw', { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Withdraw', exact: true }).click();
  await confirm(page, 'Withdrawn to your wallet.');
  assert.equal(await read(h.factory, 'function balanceOf(address) view returns (uint256)', [staker]), 31_000n * W);
  await capture(page, 'stake-done');
  assert.equal(await nonceOf(staker) - sentBefore, 5, 'five transactions from the staker: stakeWithPermit, requestUnstake, cancelUnstake, requestUnstake, withdraw');
  await context.close();
  record('/stake', ['stake with permit: one eth_signTypedData_v4 then stakeWithPermit; stakeOf 20,000 on chain', 'a Holding reservation of 5 shows; unstaking 20,000 refused', 'unstake 1,000: cooldown countdown from the vault, withdraw disabled', 'keep it staked: cancelUnstake, stakeOf 20,000 again', 'after 7 days of chain time: withdraw, 1,000 back in the wallet']);
}

async function adminPage() {
  const { context, page } = await open(owner1);
  const opKey = `hireling.admin-op:${owner1.toLowerCase()}`;
  await page.goto(`${base}/admin`);
  await page.getByText(/As the Safe/).waitFor({ timeout: 30_000 });
  const ownership = section(page, 'Ownership');
  await ownership.getByText('Safe owns it', { exact: true }).nth(5).waitFor({ timeout: 30_000 });
  await capture(page, 'admin-start');

  // Fee proposal: reviewed from the calldata, sent as the Safe (pre-validated owner signature).
  const fees = section(page, 'Fee schedule');
  await fees.getByRole('textbox', { name: 'Tier 2 fee' }).fill('8');
  await fees.getByRole('button', { name: 'Review the proposal' }).click();
  await page.getByText(/bps: \[[0-9]+, 800, /).waitFor();
  await capture(page, 'admin-fee-review');
  await confirm(page, 'Propose a new fee schedule: done');
  await fees.getByText(/Executable in 2 d 23 h/).waitFor({ timeout: 30_000 });
  const [, eta] = await read(h.feeSchedule, 'function pending() view returns ((uint256[4] thresholds, uint16[4] bps, address treasury), uint48)');
  assert.ok(eta > 0n);

  // Pause and unpause: one Safe transaction each, through MultiSendCallOnly, with the Evaluator's note.
  const core = section(page, 'Core');
  await core.getByRole('button', { name: 'Pause the core' }).click();
  await page.getByText('notePause()', { exact: true }).waitFor();
  await page.getByText('1 (delegatecall)', { exact: true }).waitFor();
  await confirm(page, 'Pause the core: done');
  await core.getByText('Paused', { exact: true }).waitFor({ timeout: 30_000 });
  assert.equal(await read(config.deployment.core, 'function paused() view returns (bool)'), true);
  await core.getByRole('button', { name: 'Unpause the core' }).click();
  await confirm(page, 'Unpause the core: done');
  await core.getByRole('button', { name: 'Pause the core' }).waitFor({ timeout: 30_000 });
  assert.equal(await read(config.deployment.core, 'function paused() view returns (bool)'), false);
  const evaluator = config.deployment.main.evaluator;
  assert.equal(await read(evaluator, 'function pauseCount() view returns (uint256)'), 1n);
  const [start, end] = await read(evaluator, 'function pauseAt(uint256) view returns ((uint48 start, uint48 end))', [0n]).then((p) => [p.start, p.end]);
  assert.ok(start > 0n && end >= start, 'the Evaluator noted the pause and its end');

  // Past epoch 0's end and the fee schedule's 3 days, on chain time.
  const epochEnd = await read(h.miningReserve, 'function epochEnd(uint256) view returns (uint256)', [0n]);
  const now = await chainNow();
  await warp(Math.max(Number(epochEnd), Number(eta)) - now + 120);
  await sync(page);
  await fees.getByText(/^Executable now, by anyone, until/).waitFor({ timeout: 30_000 });
  await fees.getByRole('button', { name: 'Execute', exact: true }).click();
  await page.getByText('Anyone may send this call; it goes straight from your wallet, not through the Safe.', { exact: true }).waitFor();
  await confirm(page, 'Execute the proposed fee schedule: done');
  const schedule = await read(h.feeSchedule, 'function schedule() view returns ((uint256[4] thresholds, uint16[4] bps, address treasury))');
  assert.equal(schedule.bps[1], 800);
  record('/admin fees and pause', ['fee proposal reviewed from calldata, proposed as the Safe; pending eta on chain', 'pause + notePause as one MultiSend Safe tx; paused() true, then unpause; Evaluator pauseCount 1 with an end', 'after 3 days of chain time: executed by the owner directly; bps[1] = 800 on chain']);

  // The epoch price list, signed in the page by the owner's key, then the mining tool on the fork's hire.
  const prices = section(page, 'Mining prices');
  assert.equal(await prices.getByRole('textbox', { name: 'Price list epoch' }).inputValue(), '0');
  await prices.getByRole('textbox', { name: 'USD price of mUSD' }).fill('1');
  await prices.getByRole('textbox', { name: 'FACTORY price in USD' }).fill('0.0001');
  await prices.getByRole('button', { name: 'Sign the price list' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), prices.getByRole('link', { name: 'Download prices-epoch-0.json' }).click()]);
  const pricesFile = `${stateDir}/prices-epoch-0.json`;
  await download.saveAs(pricesFile);
  const mined = `${stateDir}/mining`;
  mkdirSync(mined, { recursive: true });
  const run = spawnSync('bun', ['scripts/mining/epoch.ts', '0', '--network', 'monad-testnet', '--config', state.config, '--rpc', state.rpc, '--prices', pricesFile, '--out', mined], { cwd: repo, encoding: 'utf8' });
  writeFileSync(`${output}/mining-epoch.log`, `${run.stdout}\n${run.stderr}`);
  assert.equal(run.status, 0, `mining:epoch 0 refused the page's price list: ${run.stderr.split('\n').slice(-5).join(' ')}`);
  const epochFile = JSON.parse(readFileSync(`${mined}/epoch-0.json`, 'utf8'));
  assert.equal(epochFile.priceList.signer, owner1.toLowerCase());
  assert.ok(epochFile.root !== null && BigInt(epochFile.total) > 0n, 'the tool counted the hire');
  record('/admin price list → mining:epoch', ['price list signed in the page (eth_signTypedData_v4 by the Safe owner)', `pnpm mining:epoch 0 accepted it: signer is a Safe owner, decimals as on chain; total ${epochFile.total} wei over ${Object.keys(epochFile.claims).length} leaves`]);

  // Funding, signed for the Safe's live nonce (D18). Another Safe transaction first: the page refuses the draft, and
  // so does the Safe (GS026).
  const mining = section(page, 'Mining');
  await mining.getByLabel('Epoch file').setInputFiles(`${mined}/epoch-0.json`);
  const total = BigInt(epochFile.total);
  const review = mining.getByRole('button', { name: /^Review funding · / });
  await review.click();
  await page.getByText('fund(epoch, amount)', { exact: true }).waitFor();
  const nonce = await read(state.safe, 'function nonce() view returns (uint256)');
  const draft = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), opKey);
  assert.equal(draft.guard.nonce, String(nonce));
  await capture(page, 'admin-fund-review');
  await send(owner2, state.safe, encodeFunctionData({ abi: safeExec, functionName: 'execTransaction', args: [state.safe, 0n, encodeFunctionData({ abi: parseAbi(['function changeThreshold(uint256)']), functionName: 'changeThreshold', args: [1n] }), 0, 0n, 0n, 0n, '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', preValidatedBy(owner2)] }));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.getByRole('alert').filter({ hasText: `A Safe transaction has gone through since this funding was signed (Safe nonce ${nonce}, now ${nonce + 1n})` }).waitFor({ timeout: 30_000 });
  assert.equal(await page.getByRole('button', { name: 'Confirm in your wallet', exact: true }).count(), 0);
  await capture(page, 'admin-fund-stale');
  let refusedOnChain = '';
  try {
    await rpc('eth_call', [{ from: owner1, to: state.safe, data: draft.txs[0].data }, 'latest']);
  } catch (error) {
    refusedOnChain = `${error.message} ${JSON.stringify(error.data ?? '')}`;
  }
  assert.match(refusedOnChain, /GS026|4753303236/, `the Safe accepted a stale funding: ${refusedOnChain}`);
  await page.getByRole('button', { name: 'Discard it' }).click();
  await review.click();
  await page.getByText('fund(epoch, amount)', { exact: true }).waitFor();
  await confirm(page, 'Fund epoch 0: done');
  assert.equal(await read(h.miningReserve, 'function totalFunded() view returns (uint256)'), total);
  await mining.getByText(/^Funded: the remaining /).waitFor({ timeout: 30_000 });
  await mining.getByRole('button', { name: 'Review the root' }).click();
  await page.getByText('setRoot(epoch, root, total, dataHash)', { exact: true }).waitFor();
  await confirm(page, 'Post the root of epoch 0: done');
  const root = await read(h.distributor, 'function rootOf(uint256) view returns ((bytes32 root, uint256 total, uint256 claimed, bytes32 dataHash))', [0n]);
  assert.equal(root.root, epochFile.root);
  assert.equal(root.total, total);
  assert.equal(root.dataHash, epochFile.dataHash);
  await mining.getByText('Posted.', { exact: true }).waitFor();
  await capture(page, 'admin-mining-done');
  await context.close();
  record('/admin mining', [`funding signed for Safe nonce ${nonce}; another owner's Safe tx moved it: the page refused the draft, nothing offered`, 'the Safe itself refuses the stale draft (eth_call: GS026)', `re-signed at nonce ${nonce + 1n} and sent: totalFunded = ${total} on chain`, 'setRoot from the file: rootOf(0) root, total and data hash equal the file']);
}

try {
  for (const [name, run] of [['/stake', stakePage], ['/admin', adminPage]]) {
    try {
      await fresh();
      await run();
    } catch (error) {
      record(name, [], false, error.message.split('\n').slice(0, 6).join(' ').slice(0, 900));
      if (current !== null) await current.screenshot({ path: `${output}/FAILED-${name.replaceAll('/', '')}.png`, fullPage: true }).catch(() => {});
    }
  }
} finally {
  await browser.close();
  await server.close();
}
writeFileSync(`${output}/results.json`, JSON.stringify({ tier: 'real chain: anvil fork of Monad testnet, v1 by launch-testnet.sh, dev-key wallet; board tools are fixtures', results, errors }, null, 2));
for (const r of results) console.log(`${r.passed ? 'PASS' : 'FAIL'} ${r.page}${r.problem === undefined ? '' : `: ${r.problem}`}`);
if (results.some((r) => !r.passed) || errors.length > 0) {
  if (errors.length > 0) console.log(`page errors: ${errors.join(' | ')}`);
  process.exit(1);
}
console.log(`PASS: real chain, ${results.length} evidence records`);

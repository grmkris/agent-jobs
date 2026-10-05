import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { output, base, owner, agentWallet, contracts, errors, results, server, browser, fixture } from './stake-fixture.mjs';

const text = (page, value) => page.getByText(value, { exact: true }).first().waitFor();
const position = page => page.getByRole('article', { name: 'Position in My worker', exact: true });
const amount = page => page.locator('#stake-amount');
async function capture(page, name) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}: horizontal overflow`);
  await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
}
async function confirm(page, message) {
  await page.getByRole('button', { name: 'Confirm in your wallet', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm fixture' }).click();
  await page.getByRole('status').filter({ hasText: message }).waitFor();
}
async function refresh(page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}
try {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    const name = viewport.width === 390 ? 'mobile' : 'desktop';
    const { context, page } = await fixture(viewport);
    await page.goto(`${base}/me`);
    await page.getByRole('link', { name: /Stake & delegate/ }).click();
    await page.waitForURL('**/stake');
    await text(page, '50,000 FACTORY');
    await position(page).getByText('6,000 FACTORY', { exact: true }).waitFor();
    await position(page).getByText('60 % of total backing', { exact: true }).waitFor();
    await text(page, 'If the agent is slashed for bad work, everyone backing it loses the same share. Your FACTORY stays at risk until you withdraw. Leaving starts a 10-minute wait on testnet (7 days on mainnet); if the agent still has open jobs bonded against its backing, withdrawal waits until they settle.');
    assert.ok((await page.locator('article[aria-label^="Position in"]').first().innerText()).includes('My worker'), 'operator agent position first');
    await capture(page, `${name}-positions`);
    await page.getByRole('combobox', { name: 'Agent to back' }).selectOption(agentWallet);
    await amount(page).fill('60000');
    await text(page, 'That is more FACTORY than your wallet holds.');
    assert.equal(await page.getByRole('button', { name: 'Delegate 60,000 FACTORY', exact: true }).isDisabled(), true);
    await amount(page).fill('1000');
    await page.evaluate(() => { window.__wallet.declineSign = true; });
    await page.getByRole('button', { name: 'Delegate 1,000 FACTORY', exact: true }).click();
    await text(page, 'You cancelled in your wallet. Nothing was sent.');
    assert.equal(await page.evaluate(() => window.__wallet.sends.length), 0);
    await page.evaluate(() => { window.__wallet.declineSign = false; });
    await page.getByRole('button', { name: 'Delegate 1,000 FACTORY', exact: true }).click();
    await page.getByRole('heading', { name: 'Confirm your position action' }).waitFor();
    const permit = await page.evaluate(() => { const p = window.__wallet.signatures.at(-1); return { owner: p.message.owner, spender: p.message.spender, amount: String(p.message.value) }; });
    assert.deepEqual(permit, { owner, spender: contracts.vault, amount: (1000n * 10n ** 18n).toString() });
    await capture(page, `${name}-delegation-review`);
    await page.reload();
    await page.getByRole('heading', { name: 'Confirm your position action' }).waitFor();
    await confirm(page, 'Delegated. You own the position.');
    await position(page).getByText('7,000 FACTORY', { exact: true }).waitFor();
    const call = await page.evaluate(() => window.__stake.calls.at(-1));
    assert.equal(call.functionName, 'delegateWithPermit');
    assert.equal(call.args[0], agentWallet);
    // Queue the entire owned position despite 8,000 reserved and only 3,000 available.
    await position(page).getByRole('button', { name: 'Leave', exact: true }).click();
    await page.getByRole('button', { name: 'Max', exact: true }).click();
    assert.equal(await amount(page).inputValue(), '7000');
    await page.getByRole('button', { name: 'Leave 7,000 FACTORY', exact: true }).click();
    await confirm(page, 'Leaving started. Your position stays at risk.');
    await position(page).getByText('Leaving', { exact: true }).waitFor();
    assert.equal(await position(page).getByRole('button', { name: 'Withdraw', exact: true }).isDisabled(), true);
    await capture(page, `${name}-leaving`);
    // Slash reaches the queued shares pro-rata; mature withdrawal remains blocked by the remaining bond.
    await page.evaluate(({ account }) => {
      const pool = window.__stake.pools[account];
      pool.assets -= 2000n * 10n ** 18n;
      pool.reserved -= 2000n * 10n ** 18n;
      pool.positions[window.__wallet.address].unlockAt = Math.floor(Date.now() / 1000) - 1;
    }, { account: agentWallet });
    await refresh(page);
    await position(page).getByText('Waiting for bonds to clear', { exact: true }).waitFor();
    const value = await page.evaluate(({ account }) => { const pool = window.__stake.pools[account]; return String(pool.positions[window.__wallet.address].shares * pool.assets / pool.shares); }, { account: agentWallet });
    assert.equal(value, (7000n * 10n ** 18n * 9000n / 11000n).toString());
    assert.equal(await position(page).getByRole('button', { name: 'Withdraw', exact: true }).isDisabled(), true);
    await capture(page, `${name}-queued-slash-bonds`);
    await position(page).getByRole('button', { name: 'Cancel leaving', exact: true }).click();
    await confirm(page, 'Leaving cancelled. Your backing is active again.');
    await position(page).getByText('Active', { exact: true }).waitFor();
    await position(page).getByRole('button', { name: 'Leave', exact: true }).click();
    await page.getByRole('button', { name: 'Max', exact: true }).click();
    await page.getByRole('button', { name: /^Leave .* FACTORY$/ }).click();
    await confirm(page, 'Leaving started. Your position stays at risk.');
    assert.equal((await page.evaluate(() => window.__stake.calls.at(-1))).args[1], (7000n * 10n ** 18n).toString(), 'MAX owns all shares after rounding');
    await page.evaluate(({ account }) => { const pool = window.__stake.pools[account]; pool.reserved = 0n; pool.positions[window.__wallet.address].unlockAt = Math.floor(Date.now() / 1000) - 1; }, { account: agentWallet });
    await refresh(page);
    await position(page).getByText('Ready to withdraw', { exact: true }).waitFor();
    await position(page).getByRole('button', { name: 'Withdraw', exact: true }).click();
    await confirm(page, 'Withdrawn to your wallet.');
    await position(page).getByText('Exited', { exact: true }).waitFor();
    const balances = await page.evaluate(({ account }) => ({ wallet: String(window.__stake.wallet), other: String(window.__stake.pools[account].positions['0x3333333333333333333333333333333333333333'].shares) }), { account: agentWallet });
    assert.equal(balances.wallet, (49000n * 10n ** 18n + BigInt(value)).toString());
    assert.equal(balances.other, (4000n * 10n ** 18n).toString());
    results.push({ name, checks: ['operator-owned position first', 'position values and percentage', 'permit ownership and target', 'reserved-bond full queue', 'queued pro-rata slash', 'StillBonded display', 'cancel', 'MAX rounding', 'post-cooldown payout to owner'], passed: true });
    await context.close();
  }
  {
    const { context, page } = await fixture({ width: 390, height: 844 }, { dust: true });
    await page.goto(`${base}/stake?account=${agentWallet}`);
    await position(page).waitFor();
    await page.getByRole('radio', { name: 'Leave', exact: true }).click();
    await page.getByRole('button', { name: 'Max', exact: true }).click();
    assert.equal(await amount(page).inputValue(), '0.000000000000000002');
    await page.getByRole('button', { name: /^Leave .* FACTORY$/ }).click();
    await confirm(page, 'Leaving started. Your position stays at risk.');
    assert.equal((await page.evaluate(() => window.__stake.calls.at(-1))).args[1], '4');
    await context.close();
    results.push({ checks: ['2-wei MAX queues all 4 owned shares rather than partial floor(2*10/6)=3'], passed: true });
  }
  {
    const { context, page } = await fixture({ width: 390, height: 844 }, { retired: true });
    await page.goto(`${base}/stake`);
    await position(page).getByText('Lost in a full slash', { exact: true }).waitFor();
    assert.equal(await position(page).getByRole('button', { name: 'Leave', exact: true }).count(), 0);
    await capture(page, 'retired-generation');
    await context.close();
    results.push({ checks: ['retired generation zero value cannot exit twice'], passed: true });
  }
  {
    const { context, page } = await fixture({ width: 390, height: 844 }, { down: true });
    await page.goto(`${base}/stake`);
    await text(page, 'Your positions could not be read. This does not mean they are gone.');
    assert.equal(await page.getByRole('button', { name: 'Delegate', exact: true }).isDisabled(), true);
    await page.evaluate(() => { window.__stake.down = false; });
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await position(page).getByText('6,000 FACTORY', { exact: true }).waitFor();
    await page.evaluate(() => { window.__stake.down = true; });
    await refresh(page);
    await text(page, 'Showing last-known positions. Actions are paused until chain facts refresh.');
    assert.equal(await position(page).getByRole('button', { name: 'Leave', exact: true }).isDisabled(), true);
    await context.close();
    results.push({ checks: ['unavailable reads', 'retry', 'stale facts disable actions'], passed: true });
  }
  for (const options of [{ deployed: false }, { connected: false }, { open: false }]) {
    const { context, page } = await fixture({ width: 390, height: 844 }, options);
    await page.goto(`${base}/stake`);
    if (options.deployed === false) await page.getByText(/Backing is not on .* yet/).waitFor();
    if (options.connected === false) await text(page, 'Sign in to see your positions');
    if (options.open === false) { await page.getByText(/Delegating opens at launch/).waitFor(); assert.equal(await page.getByRole('button', { name: 'Delegate', exact: true }).isDisabled(), true); }
    await context.close();
  }
  {
    const { context, page } = await fixture({ width: 390, height: 844 });
    await page.goto(`${base}/agent/1942`);
    const backing = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Backing', exact: true }) });
    await backing.getByText('10,000 FACTORY', { exact: true }).first().waitFor();
    await backing.getByText('8,000 FACTORY', { exact: true }).waitFor();
    await backing.getByText('2,000 FACTORY', { exact: true }).waitFor();
    await backing.getByText('2', { exact: true }).waitFor();
    await backing.getByRole('heading', { name: 'Top delegators' }).waitFor();
    await backing.getByText('6,000 FACTORY · 60 %', { exact: true }).waitFor();
    await capture(page, 'agent-backing');
    await backing.getByRole('link', { name: 'Delegate', exact: true }).click();
    await page.waitForURL('**/stake?account=*');
    assert.equal(await page.getByRole('combobox', { name: 'Agent to back' }).inputValue(), agentWallet);
    await page.goto(`${base}/workspace`);
    await text(page, 'This agent does not own a position. Operator backing belongs to the operator wallet.');
    assert.equal(await page.getByRole('button', { name: 'Request leaving approval' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Withdraw agent-owned position' }).count(), 0);
    await capture(page, 'operator-owned-agent-backing');
    await page.evaluate(({ account }) => {
      const E = 10n ** 18n;
      const pool = window.__stake.pools[account];
      pool.assets += 1000n * E;
      pool.shares += 1000n * E;
      pool.positions[account] = { shares: 1000n * E, queuedShares: 0n, unlockAt: 0, generation: 0n };
    }, { account: agentWallet });
    await refresh(page);
    await page.getByRole('button', { name: 'Request leaving approval' }).waitFor();
    await page.evaluate(({ account }) => {
      const pool = window.__stake.pools[account];
      pool.positions[account].queuedShares = pool.positions[account].shares;
      pool.queuedShares = pool.positions[account].shares;
      pool.positions[account].unlockAt = Math.floor(Date.now() / 1000) - 1;
      pool.reserved = 0n;
    }, { account: agentWallet });
    await refresh(page);
    await page.getByRole('button', { name: 'Withdraw agent-owned position' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Withdraw agent-owned position' }).isDisabled(), false);
    assert.equal(await page.getByRole('button', { name: 'Request leaving approval' }).count(), 0);
    assert.equal(await page.evaluate(() => window.__stake.rpcMethods.includes('eth_getLogs')), false, 'product discovery never scans RPC logs');
    await capture(page, 'agent-owned-mining-withdraw');
    await context.close();
    results.push({ checks: ['public backing values, tier, delegator count and ranking', 'viewer ownership', 'delegate target prefilled', 'operator-only backing has no agent exits', 'agent-owned mining full queue still withdrawable', 'no browser log scans'], passed: true });
  }
  {
    const { context, page } = await fixture({ width: 390, height: 844 });
    await page.goto(`${base}/agents/new`);
    await page.getByRole('button', { name: 'Create agent wallet', exact: true }).click();
    await page.getByRole('heading', { name: 'Delegate backing to this agent' }).waitFor();
    await page.getByRole('option', { name: 'mUSD · test dollar jobs are paid in', exact: true }).waitFor({ state: 'attached' });
    await text(page, 'The most your agent may pull from your wallet each week to hire other agents; anything above it becomes an Approval for you.');
    assert.equal(await page.getByRole('textbox', { name: 'Other allowance token address', exact: true }).isVisible(), false);
    assert.ok((await page.getByRole('link', { name: 'View token contract', exact: true }).getAttribute('href')).startsWith('https://testnet.monadscan.com/address/'));
    const delegate = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Delegate backing to this agent' }) });
    const balances = delegate.getByLabel('Your operator wallet balances');
    await balances.getByText('50,000', { exact: true }).waitFor();
    await balances.getByText('25', { exact: true }).waitFor();
    await balances.getByText('0.5', { exact: true }).waitFor();
    await delegate.getByLabel('This agent’s backing').getByText('8,000 FACTORY', { exact: true }).waitFor();
    await delegate.getByRole('button', { name: 'Max', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: 'FACTORY to delegate to agent' }).inputValue(), '50000');
    assert.equal(await page.evaluate(() => window.__wallet.sends.length), 0, 'Max only fills the operator balance');
    await page.getByRole('textbox', { name: 'FACTORY to delegate to agent' }).fill('1');
    await page.evaluate(() => { window.__wallet.declineSign = true; });
    await page.getByRole('button', { name: 'Review delegation', exact: true }).click();
    await text(page, 'You cancelled in your wallet. Nothing was sent.');
    assert.equal(await page.evaluate(() => window.__wallet.sends.length), 0);
    await page.evaluate(() => { window.__wallet.declineSign = false; });
    for (const round of [1, 2]) {
      await page.getByRole('textbox', { name: 'FACTORY to delegate to agent' }).fill('1.000000000000000001');
      await page.getByRole('button', { name: 'Review delegation', exact: true }).click();
      await text(page, 'Delegate 1.000000000000000001 FACTORY to My worker');
      const permit = await page.evaluate(() => { const p = window.__wallet.signatures.at(-1); return { owner: p.message.owner, spender: p.message.spender, value: String(p.message.value) }; });
      assert.deepEqual(permit, { owner, spender: contracts.vault, value: '1000000000000000001' });
      if (round === 1) {
        await page.reload();
        await page.getByRole('button', { name: 'Create agent wallet', exact: true }).click();
        await text(page, 'Delegate 1.000000000000000001 FACTORY to My worker');
        assert.equal(await page.evaluate(() => window.__wallet.signatures.length), 0, 'reload resumes the saved permit without signing again');
      }
      await page.getByRole('button', { name: 'Confirm in your wallet', exact: true }).click();
      await page.getByRole('button', { name: 'Confirm fixture' }).click();
      await page.getByRole('button', { name: 'Review delegation', exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.__wallet.sends.length), round, 'each delegation needs exactly one transaction');
      const call = await page.evaluate(() => window.__stake.calls.at(-1));
      assert.equal(call.functionName, 'delegateWithPermit');
      assert.equal(call.args[0], agentWallet);
      assert.equal(call.args[1], '1000000000000000001');
      assert.equal(await page.evaluate(() => window.__stake.approvals ?? 0), 0, 'no separate approve transaction');
    }
    await context.close();
    results.push({ checks: ['balances and named token', 'Max fills only', 'refused permit has no effect', 'exact amount permit', 'reload reuses saved permit', 'repeated onboarding delegation has a distinct durable intent and one transaction'], passed: true });
  }
  {
    const { context, page } = await fixture({ width: 390, height: 844 }, { delegated: true });
    await page.goto(`${base}/agents/new`);
    await page.getByRole('button', { name: 'Create agent wallet', exact: true }).click();
    await page.getByRole('textbox', { name: 'FACTORY to delegate to agent' }).fill('100');
    await page.getByRole('button', { name: 'Review delegation', exact: true }).click();
    await text(page, 'Delegate 100 FACTORY to My worker');
    assert.equal(await page.evaluate(() => window.__wallet.signatures.length), 0, 'already-upgraded wallet needs no permit or upgrade signature');
    const code = await page.evaluate(() => window.__stake.code[window.__wallet.address]);
    await page.evaluate(() => { window.__stake.code = {}; });
    await page.getByRole('button', { name: 'Confirm in your wallet', exact: true }).click();
    await page.getByText(/Your wallet's batch delegation changed/).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Confirm fixture', exact: true }).count(), 0);
    await page.evaluate(savedCode => { window.__stake.code[window.__wallet.address] = savedCode; }, code);
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm fixture' }).click();
    await page.getByRole('button', { name: 'Review delegation', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__wallet.sends.length), 1);
    assert.equal(await page.evaluate(() => window.__wallet.sends[0].to), owner);
    const calls = await page.evaluate(() => ({ approval: window.__stake.approvalCalls, delegation: window.__stake.calls.at(-1) }));
    assert.deepEqual(calls.approval, [{ spender: contracts.vault, amount: (100n * 10n ** 18n).toString() }]);
    assert.equal(calls.delegation.functionName, 'delegate');
    assert.equal(calls.delegation.args[0], agentWallet);
    assert.equal(calls.delegation.args[1], (100n * 10n ** 18n).toString());
    await capture(page, 'onboarding-atomic-delegation');
    await context.close();
    results.push({ checks: ['7702 exact approve+delegate in one self-call', 'no permit or upgrade prompt', 'account-code change blocks wallet prompt'], passed: true });
  }
  {
    const { context, page } = await fixture({ width: 1440, height: 900 });
    const second = await context.newPage();
    second.setDefaultTimeout(20000);
    second.on('pageerror', error => errors.push(error.message));
    await Promise.all([page.goto(`${base}/stake?account=${agentWallet}`), second.goto(`${base}/stake?account=${agentWallet}`)]);
    await Promise.all([amount(page).fill('1'), amount(second).fill('1')]);
    await page.evaluate(() => { window.__wallet.signGate = true; });
    await page.getByRole('button', { name: 'Delegate 1 FACTORY', exact: true }).click();
    await page.waitForFunction(() => window.__wallet.signatures.length === 1 && window.__releasePermit !== undefined);
    await second.getByRole('button', { name: 'Delegate 1 FACTORY', exact: true }).click();
    await second.waitForFunction(async () => (await navigator.locks.query()).pending.some(lock => lock.name.includes('vault:')));
    assert.equal(await second.evaluate(() => window.__wallet.signatures.length), 0, 'second tab waits before signing');
    await page.evaluate(() => window.__releasePermit());
    await page.getByRole('heading', { name: 'Confirm your position action' }).waitFor();
    await second.waitForFunction(() => document.body.textContent.includes('Another Stake tab has an unfinished position action.') ||
      Array.from(document.querySelectorAll('h2')).some(heading => heading.textContent === 'Confirm your position action'));
    assert.equal(await second.evaluate(() => window.__wallet.signatures.length), 0, 'lock reread prevents a second prepared effect');
    const pointerKey = `hireling.delegation-op:10143:${contracts.vault}:${owner}`;
    const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), pointerKey);
    assert.equal(await second.evaluate(key => JSON.parse(localStorage.getItem(key)).id, pointerKey), saved.id, 'a remounted tab may resume only the original intent');
    assert.equal(await second.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('hireling.op:delegation:')).length), 1, 'only one prepared journal exists across both tabs');
    await page.getByRole('button', { name: 'Not now', exact: true }).waitFor();
    await second.evaluate(({ key, saved: priorIntent }) => localStorage.setItem(key, JSON.stringify({ ...priorIntent, id: 'newer-tab-intent' })), { key: pointerKey, saved });
    await page.getByRole('button', { name: 'Not now', exact: true }).click();
    await text(page, 'A newer position action is saved in another tab; keep it for reconciliation.');
    assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).id, pointerKey), 'newer-tab-intent', 'stale dismissal preserves the new pointer');
    await page.getByRole('button', { name: 'Confirm in your wallet', exact: true }).click();
    await page.getByText(/This position action changed in another tab/).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Confirm fixture', exact: true }).count(), 0, 'stale action cannot open a wallet prompt');
    assert.equal(await page.evaluate(() => window.__wallet.sends.length), 0);
    await context.close();
    results.push({ checks: ['two origin-sharing tabs serialize preparation and permit signing', 'persisted intent reread under Web Lock', 'stale Not now compare-delete', 'stale prepared send blocked'], passed: true });
  }
  assert.deepEqual(errors, []);
  writeFileSync(`${output}/results.json`, JSON.stringify({ tier: 'mocked Chromium only; no live vault, signing or sends', results, errors }, null, 2));
  console.log(`PASS: delegated staking, ${results.length} evidence records`);
} catch (error) {
  for (const context of browser.contexts()) for (const page of context.pages()) {
    console.error((await page.locator("body").innerText()).slice(-5000));
    await page.screenshot({ path: `${output}/failure.png`, fullPage: true });
  }
  throw error;
} finally {
  await browser.close();
  await server.close();
}

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
  // Out-of-band fixture mutations need a completed fresh read, not a focus event racing an older read.
  await page.evaluate(async () => {
    await Promise.all([
      window.__stakingQueryClient.invalidateQueries({ queryKey: ['delegations'] }),
      window.__stakingQueryClient.invalidateQueries({ queryKey: ['indexed-backing'] }),
    ]);
  });
}
try {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    const name = viewport.width === 390 ? 'mobile' : 'desktop';
    const { context, page } = await fixture(viewport);
    await page.goto(`${base}/account`);
    await page.getByRole('link', { name: /Back an agent/ }).click();
    await page.waitForURL('**/backing');
    await text(page, '50,000 SIDE');
    await position(page).getByText('6,000 SIDE', { exact: true }).waitFor();
    await position(page).getByText('60 % of total backing', { exact: true }).waitFor();
    await text(page, 'If the agent is slashed for bad work, everyone backing it loses the same share. Your SIDE stays at risk until you withdraw. Leaving starts a 10-minute wait on testnet (7 days on mainnet); if the agent still has open jobs secured against its backing, withdrawal waits until they settle.');
    assert.ok((await page.locator('article[aria-label^="Position in"]').first().innerText()).includes('My worker'), 'operator agent position first');
    await capture(page, `${name}-positions`);
    await page.getByRole('combobox', { name: 'Agent to back' }).selectOption(agentWallet);
    await amount(page).fill('60000');
    await text(page, 'That is more SIDE than your wallet holds.');
    assert.equal(await page.getByRole('button', { name: 'Back with 60,000 SIDE', exact: true }).isDisabled(), true);
    await amount(page).fill('1000');
    await page.evaluate(() => { window.__wallet.declineSign = true; });
    await page.getByRole('button', { name: 'Back with 1,000 SIDE', exact: true }).click();
    await text(page, 'You cancelled in your wallet. Nothing was sent.');
    assert.equal(await page.evaluate(() => window.__wallet.sends.length), 0);
    await page.evaluate(() => { window.__wallet.declineSign = false; });
    await page.getByRole('button', { name: 'Back with 1,000 SIDE', exact: true }).click();
    await page.getByRole('heading', { name: 'Confirm your position action' }).waitFor();
    const permit = await page.evaluate(() => { const p = window.__wallet.signatures.at(-1); return { owner: p.message.owner, spender: p.message.spender, amount: String(p.message.value) }; });
    assert.deepEqual(permit, { owner, spender: contracts.vault, amount: (1000n * 10n ** 18n).toString() });
    await capture(page, `${name}-delegation-review`);
    await page.reload();
    await page.getByRole('heading', { name: 'Confirm your position action' }).waitFor();
    await confirm(page, 'Backed. You own the position.');
    await position(page).getByText('7,000 SIDE', { exact: true }).waitFor();
    const call = await page.evaluate(() => window.__stake.calls.at(-1));
    assert.equal(call.functionName, 'delegateWithPermit');
    assert.equal(call.args[0], agentWallet);
    // Queue the entire owned position despite 8,000 reserved and only 3,000 available.
    await position(page).getByRole('button', { name: 'Leave', exact: true }).click();
    await page.getByRole('button', { name: 'Max', exact: true }).click();
    assert.equal(await amount(page).inputValue(), '7000');
    await page.getByRole('button', { name: 'Leave 7,000 SIDE', exact: true }).click();
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
    await position(page).getByText('Waiting for deposits at risk to clear', { exact: true }).waitFor();
    const value = await page.evaluate(({ account }) => { const pool = window.__stake.pools[account]; return String(pool.positions[window.__wallet.address].shares * pool.assets / pool.shares); }, { account: agentWallet });
    assert.equal(value, (7000n * 10n ** 18n * 9000n / 11000n).toString());
    assert.equal(await position(page).getByRole('button', { name: 'Withdraw', exact: true }).isDisabled(), true);
    await capture(page, `${name}-queued-slash-bonds`);
    await position(page).getByRole('button', { name: 'Cancel leaving', exact: true }).click();
    await confirm(page, 'Leaving cancelled. Your backing is active again.');
    await position(page).getByText('Active', { exact: true }).waitFor();
    await position(page).getByRole('button', { name: 'Leave', exact: true }).click();
    await page.getByRole('button', { name: 'Max', exact: true }).click();
    await page.getByRole('button', { name: /^Leave .* SIDE$/ }).click();
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
    await page.goto(`${base}/backing?account=${agentWallet}`);
    await position(page).waitFor();
    await page.getByRole('radio', { name: 'Leave', exact: true }).click();
    await page.getByRole('button', { name: 'Max', exact: true }).click();
    assert.equal(await amount(page).inputValue(), '0.000000000000000002');
    await page.getByRole('button', { name: /^Leave .* SIDE$/ }).click();
    await confirm(page, 'Leaving started. Your position stays at risk.');
    assert.equal((await page.evaluate(() => window.__stake.calls.at(-1))).args[1], '4');
    await context.close();
    results.push({ checks: ['2-wei MAX queues all 4 owned shares rather than partial floor(2*10/6)=3'], passed: true });
  }
  {
    const { context, page } = await fixture({ width: 390, height: 844 }, { retired: true });
    await page.goto(`${base}/backing`);
    await position(page).getByText('Lost in a full slash', { exact: true }).waitFor();
    assert.equal(await position(page).getByRole('button', { name: 'Leave', exact: true }).count(), 0);
    await capture(page, 'retired-generation');
    await context.close();
    results.push({ checks: ['retired generation zero value cannot exit twice'], passed: true });
  }
  {
    const { context, page } = await fixture({ width: 390, height: 844 }, { down: true });
    await page.goto(`${base}/backing`);
    await text(page, 'Your positions could not be read. This does not mean they are gone.');
    assert.equal(await page.getByRole('button', { name: 'Back with SIDE', exact: true }).isDisabled(), true);
    await page.evaluate(() => { window.__stake.down = false; });
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await position(page).getByText('6,000 SIDE', { exact: true }).waitFor();
    await page.evaluate(() => { window.__stake.down = true; });
    await refresh(page);
    await text(page, 'Showing last-known positions. Actions are paused until chain facts refresh.');
    assert.equal(await position(page).getByRole('button', { name: 'Leave', exact: true }).isDisabled(), true);
    await context.close();
    results.push({ checks: ['unavailable reads', 'retry', 'stale facts disable actions'], passed: true });
  }
  for (const options of [{ connected: false }, { open: false }]) {
    const { context, page } = await fixture({ width: 390, height: 844 }, options);
    await page.goto(`${base}/backing`);
    if (options.connected === false) await text(page, 'Sign in to see your positions');
    if (options.open === false) { await page.getByText(/Backing opens at launch/).waitFor(); assert.equal(await page.getByRole('button', { name: 'Back with SIDE', exact: true }).isDisabled(), true); }
    await context.close();
  }
  {
    const { context, page } = await fixture({ width: 390, height: 844 });
    await page.goto(`${base}/agent/1942`);
    const backing = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Backing', exact: true }) });
    // The strip: total, backers and fee; the breakdown and top backers unfold under Details.
    await backing.getByText('10,000 SIDE', { exact: true }).first().waitFor();
    await backing.getByText('2', { exact: true }).waitFor();
    await backing.getByText('Details', { exact: true }).click();
    await backing.getByText('8,000 SIDE', { exact: true }).waitFor();
    await backing.getByText('2,000 SIDE', { exact: true }).waitFor();
    await backing.getByRole('heading', { name: 'Top backers' }).waitFor();
    await backing.getByText('6,000 SIDE · 60 %', { exact: true }).waitFor();
    await capture(page, 'agent-backing');
    await backing.getByRole('link', { name: 'Back this agent', exact: true }).click();
    await page.waitForURL('**/backing?account=*');
    assert.equal(await page.getByRole('combobox', { name: 'Agent to back' }).inputValue(), agentWallet);
    await page.goto(`${base}/agent/1942?tab=manage`);
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
    await page.getByRole('heading', { name: 'Back this agent' }).waitFor();
    await page.getByRole('option', { name: 'mUSD · test dollars jobs are paid in', exact: true }).waitFor({ state: 'attached' });
    await text(page, 'The most your agent may pull from your wallet each week to hire other agents; anything above it becomes an Approval for you.');
    assert.equal(await page.getByRole('textbox', { name: 'Other budget token address', exact: true }).isVisible(), false);
    assert.ok((await page.getByRole('link', { name: 'View token contract', exact: true }).getAttribute('href')).startsWith('https://testnet.monadscan.com/address/'));
    const delegate = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Back this agent' }) });
    const balances = delegate.getByLabel('Your operator wallet balances');
    await balances.getByText('50,000', { exact: true }).waitFor();
    await balances.getByText('25', { exact: true }).waitFor();
    await balances.getByText('0.5', { exact: true }).waitFor();
    await delegate.getByLabel('This agent’s backing').getByText('8,000 SIDE', { exact: true }).waitFor();
    await delegate.getByRole('button', { name: 'Max', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: 'SIDE to back this agent' }).inputValue(), '50000');
    assert.equal(await page.evaluate(() => window.__wallet.sends.length), 0, 'Max only fills the operator balance');
    await page.getByRole('textbox', { name: 'SIDE to back this agent' }).fill('1');
    await page.evaluate(() => { window.__wallet.declineSign = true; });
    await page.getByRole('button', { name: 'Review backing', exact: true }).click();
    await text(page, 'You cancelled in your wallet. Nothing was sent.');
    assert.equal(await page.evaluate(() => window.__wallet.sends.length), 0);
    await page.evaluate(() => { window.__wallet.declineSign = false; });
    for (const round of [1, 2]) {
      await page.getByRole('textbox', { name: 'SIDE to back this agent' }).fill('1.000000000000000001');
      await page.getByRole('button', { name: 'Review backing', exact: true }).click();
      await text(page, 'Back with 1.000000000000000001 SIDE to My worker');
      const permit = await page.evaluate(() => { const p = window.__wallet.signatures.at(-1); return { owner: p.message.owner, spender: p.message.spender, value: String(p.message.value) }; });
      assert.deepEqual(permit, { owner, spender: contracts.vault, value: '1000000000000000001' });
      if (round === 1) {
        await page.reload();
        await page.getByRole('button', { name: 'Create agent wallet', exact: true }).click();
        await text(page, 'Back with 1.000000000000000001 SIDE to My worker');
        assert.equal(await page.evaluate(() => window.__wallet.signatures.length), 0, 'reload resumes the saved permit without signing again');
      }
      await page.getByRole('button', { name: 'Confirm in your wallet', exact: true }).click();
      await page.getByRole('button', { name: 'Confirm fixture' }).click();
      await page.getByRole('button', { name: 'Review backing', exact: true }).waitFor();
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
    await page.getByRole('textbox', { name: 'SIDE to back this agent' }).fill('100');
    await page.getByRole('button', { name: 'Review backing', exact: true }).click();
    await text(page, 'Back with 100 SIDE to My worker');
    assert.equal(await page.evaluate(() => window.__wallet.signatures.length), 0, 'already-upgraded wallet needs no permit or upgrade signature');
    const code = await page.evaluate(() => window.__stake.code[window.__wallet.address]);
    await page.evaluate(() => { window.__stake.code = {}; });
    await page.getByRole('button', { name: 'Confirm in your wallet', exact: true }).click();
    await page.getByText(/Your wallet's batch permission changed/).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Confirm fixture', exact: true }).count(), 0);
    await page.evaluate(savedCode => { window.__stake.code[window.__wallet.address] = savedCode; }, code);
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm fixture' }).click();
    await page.getByRole('button', { name: 'Review backing', exact: true }).waitFor();
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
    const pointerKey = `sidequest.delegation-op:10143:${contracts.vault}:${owner}`;
    const second = await context.newPage();
    second.setDefaultTimeout(20000);
    second.on('pageerror', error => errors.push(error.message));
    await Promise.all([page.goto(`${base}/backing?account=${agentWallet}`), second.goto(`${base}/backing?account=${agentWallet}`)]);
    await Promise.all([amount(page).fill('1'), amount(second).fill('1')]);
    await page.evaluate(() => { window.__wallet.signGate = true; });
    await page.getByRole('button', { name: 'Back with 1 SIDE', exact: true }).click();
    await page.waitForFunction(() => window.__wallet.signatures.length === 1 && window.__releasePermit !== undefined);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), pointerKey), null, 'the permit prompt precedes the prepared pointer, while the vault lock is still held');
    // Reproduce Chromium's stale localStorage renderer cache deterministically:
    // storage events may arrive after the queued Web Lock callback has begun.
    await second.evaluate(key => {
      const getItem = Storage.prototype.getItem;
      window.__restorePointerCache = () => { Storage.prototype.getItem = getItem; };
      Storage.prototype.getItem = function (item) {
        return this === localStorage && item === key ? null : getItem.call(this, item);
      };
    }, pointerKey);
    await second.getByRole('button', { name: 'Back with 1 SIDE', exact: true }).click();
    await second.waitForFunction(async () => (await navigator.locks.query()).pending.some(lock => lock.name.includes('vault:')));
    assert.equal(await second.evaluate(() => window.__wallet.signatures.length), 0, 'second tab waits before signing');
    await page.evaluate(() => window.__releasePermit());
    await page.getByRole('heading', { name: 'Confirm your position action' }).waitFor();
    await second.waitForFunction(() => document.body.textContent.includes('Another tab has an unfinished position action.') ||
      Array.from(document.querySelectorAll('h2')).some(heading => heading.textContent === 'Confirm your position action'));
    assert.equal(await second.evaluate(() => window.__wallet.signatures.length), 0, 'lock reread prevents a second prepared effect');
    const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), pointerKey);
    const checkpointId = await second.evaluate(async key => {
      const { readVaultIntentDurable } = await import('/src/vault-lock.ts');
      return (await readVaultIntentDurable(localStorage, key)).id;
    }, pointerKey);
    assert.equal(checkpointId, saved.id, 'committed checkpoint observes the original intent even with a forced stale null localStorage cache');
    await second.evaluate(() => window.__restorePointerCache());
    await second.waitForFunction(({ key, id }) => JSON.parse(localStorage.getItem(key) ?? 'null')?.id === id, { key: pointerKey, id: saved.id });
    assert.equal(await second.evaluate(key => JSON.parse(localStorage.getItem(key)).id, pointerKey), saved.id, 'a remounted tab may resume only the original intent');
    assert.equal(await second.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('sidequest.op:delegation:')).length), 1, 'only one prepared journal exists across both tabs');
    await page.getByRole('button', { name: 'Not now', exact: true }).waitFor();
    await second.evaluate(async ({ key, saved: priorIntent }) => {
      const { withVaultIntentLock, writeVaultIntent } = await import('/src/vault-lock.ts');
      await withVaultIntentLock(navigator.locks, key, () =>
        writeVaultIntent(localStorage, key, { ...priorIntent, id: 'newer-tab-intent' }));
    }, { key: pointerKey, saved });
    await page.getByRole('button', { name: 'Not now', exact: true }).click();
    await text(page, 'A newer position action is saved in another tab; keep it for reconciliation.');
    assert.equal(await second.evaluate(async key => {
      const { readVaultIntentDurable } = await import('/src/vault-lock.ts');
      return (await readVaultIntentDurable(localStorage, key)).id;
    }, pointerKey), 'newer-tab-intent', 'stale dismissal preserves the new pointer');
    await page.getByRole('button', { name: 'Confirm in your wallet', exact: true }).click();
    await page.getByText(/This position action changed in another tab/).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Confirm fixture', exact: true }).count(), 0, 'stale action cannot open a wallet prompt');
    assert.equal(await page.evaluate(() => window.__wallet.sends.length), 0);
    await context.close();
    results.push({ checks: ['two origin-sharing tabs serialize preparation and permit signing', 'committed checkpoint reread under Web Lock despite forced stale null localStorage', 'one original pointer and journal', 'stale Not now compare-delete', 'stale prepared send blocked'], passed: true });
  }
  for (const surface of ['stake', 'setup']) {
    const { context, page } = await fixture({ width: 1440, height: 900 });
    const pointerKey = `sidequest.delegation-op:10143:${contracts.vault}:${owner}`;
    await context.addInitScript(() => {
      const put = IDBObjectStore.prototype.put;
      window.__rejectVaultWrite = 'all';
      IDBObjectStore.prototype.put = function (value, key) {
        if (this.transaction.db.name === 'sidequest-vault-intents' &&
          (window.__rejectVaultWrite === 'all' || window.__rejectVaultWrite === 'prepared' &&
            typeof value === 'string' && Array.isArray(JSON.parse(value).txs))) {
          this.transaction.abort();
          return undefined;
        }
        return put.call(this, value, key);
      };
    });
    const second = await context.newPage();
    second.setDefaultTimeout(20000);
    second.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/${surface === 'stake' ? `backing?account=${agentWallet}` : 'agents/new'}`);
    if (surface === 'setup') await page.getByRole('button', { name: 'Create agent wallet', exact: true }).click();
    const firstAmount = surface === 'stake' ? amount(page) : page.getByRole('textbox', { name: 'SIDE to back this agent' });
    const review = () => page.getByRole('button', { name: surface === 'stake' ? 'Back with 1 SIDE' : 'Review backing', exact: true });
    await firstAmount.fill('1');
    await second.goto(`${base}/backing?account=${agentWallet}`);
    await amount(second).fill('1');
    await review().click();
    await text(page, 'vault intent write aborted');
    await second.getByRole('button', { name: 'Back with 1 SIDE', exact: true }).click();
    await text(second, 'vault intent write aborted');
    assert.equal(await page.evaluate(() => window.__wallet.signatures.length), 0, 'failed reservation cannot open the first permit prompt');
    assert.equal(await second.evaluate(() => window.__wallet.signatures.length), 0, 'undefined checkpoint and stale null cannot open the second permit prompt when its reservation fails');
    assert.equal(await page.evaluate(key => localStorage.getItem(key), pointerKey), null, 'failed durable writes never expose a local recovery pointer');
    await page.evaluate(() => { window.__rejectVaultWrite = 'prepared'; });
    await second.evaluate(key => {
      window.__rejectVaultWrite = false;
      const getItem = Storage.prototype.getItem;
      Storage.prototype.getItem = function (item) {
        return this === localStorage && item === key ? null : getItem.call(this, item);
      };
    }, pointerKey);
    await review().click();
    await page.getByRole('button', { name: 'Discard interrupted preparation', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__wallet.signatures.length), 1);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), pointerKey), null, 'rejected final pointer write stays unexposed after signing');
    await second.getByRole('button', { name: 'Back with 1 SIDE', exact: true }).click();
    await second.getByRole('button', { name: 'Discard interrupted preparation', exact: true }).waitFor();
    assert.equal(await second.evaluate(() => window.__wallet.signatures.length), 0, 'durable reservation blocks the stale renderer before a second signature');
    await second.reload();
    await amount(second).fill('1');
    await second.getByRole('button', { name: 'Back with 1 SIDE', exact: true }).click();
    await second.getByRole('button', { name: 'Discard interrupted preparation', exact: true }).waitFor();
    assert.equal(await second.evaluate(() => window.__wallet.signatures.length), 0, 'interrupted reservation survives reload');
    await page.evaluate(() => { window.__rejectVaultWrite = false; });
    await page.getByRole('button', { name: 'Discard interrupted preparation', exact: true }).click();
    await page.getByRole('button', { name: 'Discard interrupted preparation', exact: true }).waitFor({ state: 'detached' });
    await review().click();
    await page.getByText('Back with 1 SIDE to My worker', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__wallet.signatures.length), 2, 'explicit discard permits one fresh preparation');
    assert.equal(await page.evaluate(() => window.__wallet.sends.length), 0);
    await context.close();
    results.push({ surface, checks: ['two renderer reservation-write rejection: zero permit prompts', 'final write rejection retains durable reservation', 'stale null renderer and reload cannot sign', 'exact locked discard allows retry', 'no pointer exposed without durable commit'], passed: true });
  }
  {
    const { context, page } = await fixture({ width: 1440, height: 900 }, { delegated: true });
    await page.goto(`${base}/agents/new`);
    await page.getByRole('button', { name: 'Create agent wallet', exact: true }).click();
    await page.getByRole('textbox', { name: 'SIDE to back this agent' }).fill('1');
    await page.getByRole('button', { name: 'Review backing', exact: true }).click();
    await text(page, 'Back with 1 SIDE to My worker');
    const journal = await page.evaluate(() => {
      const key = Object.keys(localStorage).find(item => item.startsWith('sidequest.op:delegation:'));
      return { key, raw: localStorage.getItem(key) };
    });
    const second = await context.newPage();
    second.setDefaultTimeout(20000);
    second.on('pageerror', error => errors.push(error.message));
    await second.goto(`${base}/backing?account=${agentWallet}`);
    await second.getByRole('heading', { name: 'Confirm your position action' }).waitFor();
    await second.evaluate(({ key, raw }) => {
      const getItem = Storage.prototype.getItem;
      const setItem = Storage.prototype.setItem;
      let cached = raw;
      Storage.prototype.getItem = function (item) {
        return this === localStorage && item === key ? cached : getItem.call(this, item);
      };
      Storage.prototype.setItem = function (item, value) {
        setItem.call(this, item, value);
        if (this === localStorage && item === key) cached = value;
      };
    }, journal);
    let releaseReceipt;
    const receiptGate = new Promise(resolve => { releaseReceipt = resolve; });
    await context.route('**/__test/receipt?*', async route => {
      await receiptGate;
      await route.fallback();
    });
    await page.getByRole('button', { name: 'Confirm in your wallet', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm fixture', exact: true }).waitFor();
    const pending = await second.evaluate(async key => {
      const { readTxJournalDurable } = await import('/src/components/txJournal.ts');
      return readTxJournalDurable(localStorage, key, true);
    }, journal.key);
    assert.equal(pending.pending, 0, 'pending journal committed before the first wallet prompt');
    assert.equal(pending.snapshot.nonce, 0);
    await second.getByRole('button', { name: 'Confirm in your wallet', exact: true }).click();
    await second.waitForFunction(async () => (await navigator.locks.query()).pending.some(lock => lock.name.startsWith('sidequest.wallet-step:sidequest.op:')));
    await page.getByRole('button', { name: 'Confirm fixture', exact: true }).click();
    await second.waitForFunction(async key => {
      const { readTxJournalDurable } = await import('/src/components/txJournal.ts');
      return (await readTxJournalDurable(localStorage, key, true)).hashes[0] != null;
    }, journal.key);
    const sends = await page.evaluate(() => window.__wallet.sends);
    await second.evaluate(sent => { window.__wallet.sends = sent; }, sends);
    assert.equal(await second.evaluate(key => JSON.parse(localStorage.getItem(key)).hashes.length, journal.key), 0, 'second renderer retains the empty journal after the first hash commits');
    assert.equal(await second.getByRole('button', { name: 'Confirm fixture', exact: true }).count(), 0);
    releaseReceipt();
    await second.getByRole('status').filter({ hasText: 'Backed. You own the position.' }).waitFor();
    assert.equal(await second.getByRole('button', { name: 'Confirm fixture', exact: true }).count(), 0, 'same-intent stale empty journal reconciles the first hash without another wallet prompt');
    assert.equal(await second.evaluate(() => window.__wallet.sends.length), 1, 'advanced chain nonce cannot cause a duplicate batch');
    assert.equal(await page.evaluate(() => window.__wallet.sends.length), 1);
    const canonical = await second.evaluate(async key => {
      const { readTxJournalDurable } = await import('/src/components/txJournal.ts');
      return readTxJournalDurable(localStorage, key, true);
    }, journal.key);
    assert.equal(canonical.recorded[0], true);
    assert.equal(canonical.pending, null);
    assert.equal(canonical.hashes.length, 1);
    await context.close();
    results.push({ checks: ['same saved 7702 intent in setup and /stake', 'forced valid empty second-renderer send journal', 'pending committed before prompt', 'hash committed before lock transfer', 'nonce advances but one batch only', 'second tab reconciles and records the original hash'], passed: true });
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

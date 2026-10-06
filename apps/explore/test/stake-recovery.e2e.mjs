import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { output, base, owner, agentWallet, contracts, errors, server, browser, fixture } from './stake-fixture.mjs';

const results = [];
const pointerKey = `sidequest.delegation-op:10143:${contracts.vault}:${owner}`;
async function prepare(page) {
  await page.goto(`${base}/agents/new`);
  await page.getByRole('button', { name: 'Create agent wallet', exact: true }).click();
  await page.getByRole('textbox', { name: 'SIDE to back this agent' }).fill('100');
  await page.getByRole('button', { name: 'Review backing', exact: true }).click();
  await page.getByText('Back with 100 SIDE to My worker', { exact: true }).waitFor();
}
try {
  for (const surface of ['setup', 'stake']) {
    const { context, page } = await fixture({ width: 390, height: 844 }, { delegated: true });
    await prepare(page);
    const before = await page.evaluate(key => localStorage.getItem(key), pointerKey);
    if (surface === 'stake') await page.goto(`${base}/backing?account=${agentWallet}`);
    await page.evaluate(() => { window.__stake.code = {}; });
    await page.getByRole('button', { name: 'Confirm in your wallet', exact: true }).click();
    await page.getByText(/Your wallet's batch permission changed/).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Confirm fixture', exact: true }).count(), 0, 'revoked code blocks the resumed wallet prompt');
    assert.equal(await page.evaluate(() => window.__wallet.sends.length), 0);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), pointerKey), before, 'blocked intent is retained');
    assert.equal(await page.getByRole('status').filter({ hasText: 'Backed. You own the position.' }).count(), 0);
    await context.close();
    results.push({ surface, check: 'revoked code before send keeps intent and reports no delegation', passed: true });
  }
  for (const surface of ['setup', 'stake']) {
    const { context, page } = await fixture({ width: 1440, height: 900 }, { delegated: true });
    await prepare(page);
    if (surface === 'stake') await page.goto(`${base}/backing?account=${agentWallet}`);
    await page.getByRole('button', { name: 'Confirm in your wallet', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm fixture', exact: true }).waitFor();
    // Revoke after the guard, while the wallet prompt is open: the chain accepts a successful no-op self-call.
    await page.evaluate(() => { window.__stake.code = {}; });
    await page.getByRole('button', { name: 'Confirm fixture', exact: true }).click();
    await page.getByText(/Not backed: the receipt has no exact Delegated event/).waitFor();
    assert.equal(await page.getByRole('status').filter({ hasText: 'Backed. You own the position.' }).count(), 0);
    const saved = await page.evaluate(key => ({ intent: localStorage.getItem(key), journals: Object.entries(localStorage).filter(([k]) => k.startsWith('sidequest.op:delegation:')).map(([, bytes]) => JSON.parse(bytes)) }), pointerKey);
    assert.ok(saved.intent);
    assert.equal(saved.journals[0].hashes[0], null);
    assert.equal(saved.journals[0].effectFailures.length, 1, 'successful no-effect hash is retained for audit');
    assert.equal(await page.evaluate(() => window.__stake.calls.length), 0, 'no backing effect occurred');
    if (surface === 'stake') {
      // A retained pre-fix journal may have marked this no-op receipt recorded. The flag is not effect proof.
      await page.evaluate(() => {
        const [key, bytes] = Object.entries(localStorage).find(([entry]) => entry.startsWith('sidequest.op:delegation:'));
        const journal = JSON.parse(bytes);
        journal.hashes = [journal.effectFailures[0].hash];
        journal.recorded = [true];
        journal.effectFailures = [];
        localStorage.setItem(key, JSON.stringify(journal));
      });
    }
    // A different surface/reload must retain the failure and offer a retry rather than clear the intent.
    await page.goto(`${base}/backing?account=${agentWallet}`);
    await page.getByText(/Not backed: the receipt has no exact Delegated event/).waitFor();
    assert.ok(await page.evaluate(key => localStorage.getItem(key), pointerKey), 'old recorded flags cannot clear an unproved delegation');
    assert.equal(await page.evaluate(() => window.__wallet.sends.length), 1);
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm fixture' }).click();
    await page.getByRole('status').filter({ hasText: 'Backed. You own the position.' }).waitFor();
    assert.equal(await page.evaluate(key => localStorage.getItem(key), pointerKey), null);
    assert.equal(await page.evaluate(() => window.__wallet.sends.length), 2, 'retry sends once after proven no effect');
    await context.close();
    results.push({ surface, check: 'no-op receipt fails, survives reload and retries only to an exact event', passed: true });
  }
  assert.deepEqual(errors, []);
  writeFileSync(`${output}/results.json`, JSON.stringify({ tier: 'mocked Chromium only; no live signing or sends', results, errors }, null, 2));
  console.log(`PASS: delegation recovery, ${results.length} evidence records`);
} catch (failure) {
  for (const context of browser.contexts()) for (const page of context.pages()) {
    console.error((await page.locator('body').innerText()).slice(-5000));
    await page.screenshot({ path: `${output}/failure.png`, fullPage: true });
  }
  throw failure;
} finally {
  await browser.close();
  await server.close();
}

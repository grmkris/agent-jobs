import assert from 'node:assert/strict';
import { output, owner, base, errors, server, browser, fixture } from './stake-fixture.mjs';

// The testnet "Get test tokens" button and Buy on Account: a wallet with MON sends the claim itself; the board's relay sends
// it for one without; the cooldown and the board's refusals come back as plain messages.
const status = (page, message) => page.getByRole('status').filter({ hasText: message }).waitFor();
try {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    const name = viewport.width === 390 ? 'mobile' : 'desktop';
    const { context, page } = await fixture(viewport);
    await page.goto(`${base}/account`);
    await page.getByText('0x1111…1111', { exact: true }).nth(1).waitFor();
    await page.getByText('1,000 SIDE and 1,000 of each test payment token, once a day. Test tokens have no value.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Get test tokens', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm fixture', exact: true }).click();
    await status(page, 'Test tokens claimed');
    const call = await page.evaluate(() => window.__stake.calls.at(-1));
    assert.deepEqual(call, { functionName: 'drip', args: [owner] });
    await page.getByText(/^Next claim in /).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Get test tokens', exact: true }).isDisabled(), true);
    await page.screenshot({ path: `${output}/${name}-faucet-claimed.png`, fullPage: true });

    await page.evaluate(async () => {
      window.__stake.faucetNext = 0n;
      window.__stake.faucetReply = { ok: true, result: { status: 'sent', txHash: `0x${'cd'.repeat(32)}` } };
      await window.__stakingQueryClient.invalidateQueries();
    });
    await page.getByRole('button', { name: 'Get test tokens', exact: true }).click();
    await status(page, 'Test tokens sent to your wallet');
    assert.equal(await page.evaluate(() => window.__wallet.sends.length), 1, 'the relay path sends nothing from the wallet');

    await page.evaluate(() => { window.__stake.faucetReply = { ok: true, result: { status: 'unavailable', reason: 'the faucet relay is low on MON; get MON from faucet.monad.xyz and claim from your wallet' } }; });
    await page.getByRole('button', { name: 'Get test tokens', exact: true }).click();
    await status(page, 'the faucet relay is low on MON');

    // Buy SIDE with mUSD on the SIDE/mUSD market: live quote, 1% slippage floor, exact approval, then the swap.
    await page.getByRole('button', { name: 'Buy SIDE', exact: true }).click();
    await page.getByText('1 SIDE ≈ 0.000100 mUSD · up to 1% slippage', { exact: true }).waitFor();
    await page.getByRole('textbox', { name: 'mUSD to pay', exact: true }).fill('30');
    await page.getByText('That is more mUSD than your wallet holds.', { exact: true }).waitFor();
    await page.getByRole('textbox', { name: 'mUSD to pay', exact: true }).fill('10');
    await page.getByText('You get about 99,700 SIDE (at least 98,703 SIDE).', { exact: true }).waitFor();
    await page.screenshot({ path: `${output}/${name}-buy-side.png`, fullPage: true });
    await page.getByRole('button', { name: 'Review swap', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm fixture', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm step 2 of 2', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm fixture', exact: true }).click();
    await status(page, 'Bought SIDE');
    const [approval, swap] = await page.evaluate(() => [window.__stake.approvalCalls.at(-1), window.__stake.calls.at(-1)]);
    assert.equal(approval.amount, '10000000');
    assert.deepEqual(swap, { functionName: 'swapExactIn', args: ['true', '10000000', String(99_700n * 10n ** 18n * 99n / 100n)] });
    assert.equal(await page.evaluate(() => String(window.__stake.reward)), '15000000');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}: horizontal overflow`);
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('faucet e2e: PASS');
} finally {
  await browser.close();
  await server.close();
}

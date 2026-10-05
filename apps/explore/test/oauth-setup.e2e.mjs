import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { output, base, errors, server, browser, fixture } from './stake-fixture.mjs';

// Presentation and consent regression only. Wallets and OAuth responses are local test doubles.
const results = [];
try {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    const { context, page } = await fixture(viewport);
    await context.route('**/oauth/**', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, result: {
      request: { clientId: 'fixture', clientName: 'Fixture coding client', redirectUri: `${base}/callback`, resource: `${base}/mcp`, scopes: ['hireling:read', 'hireling:work', 'hireling:hire'], expiresAt: Math.floor(Date.now() / 1000) + 600 }, agents: [],
    } }) }));
    await page.goto(`${base}/connect?oauth_request=fixture`);
    await page.getByRole('button', { name: 'Create a new agent', exact: true }).click();
    await page.getByRole('button', { name: 'Create agent wallet', exact: true }).click();
    await page.getByRole('heading', { name: 'Agent #1942 is registered', exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { level: 2, name: 'Connect your coding agent', exact: true }).count(), 0, 'OAuth already has a connecting client');
    await page.screenshot({ path: `${output}/oauth-${viewport.width}.png`, fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.goto(`${base}/agents/new`);
    await page.getByRole('button', { name: 'Create agent wallet', exact: true }).click();
    await page.getByRole('heading', { level: 2, name: 'Connect your coding agent', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__wallet.signatures.length + window.__wallet.sends.length), 0, 'rendering setup never signs or sends');
    await context.close();
    results.push({ viewport, checks: ['OAuth hides install snippet', 'standalone retains install snippet', 'no wallet actions merely rendering'], passed: true });
  }
  assert.deepEqual(errors, []);
  writeFileSync(`${output}/results.json`, JSON.stringify({ tier: 'mocked Chromium only; no real OAuth, wallet signing or sends', results, errors }, null, 2));
  console.log(`PASS: OAuth agent setup, ${results.length} evidence records`);
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

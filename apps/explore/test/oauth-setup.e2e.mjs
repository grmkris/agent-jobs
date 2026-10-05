import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { output, base, errors, server, browser, fixture } from './stake-fixture.mjs';

// Presentation and consent regression only. Wallets and OAuth responses are local test doubles.
const results = [];
try {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    const { context, page } = await fixture(viewport);
    const decisions = [];
    const permissionCalls = [];
    page.on('request', request => {
      if (request.method() === 'POST' && /allowance|delegate|sponsor/.test(new URL(request.url()).pathname)) permissionCalls.push(request.url());
    });
    await context.route('**/oauth/**', async route => {
      if (route.request().method() === 'POST') {
        decisions.push(route.request().postDataJSON());
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, result: { redirectUrl: `${base}/__test/oauth-complete` } }) });
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, result: {
        request: { clientId: 'fixture', clientName: 'Fixture coding client', redirectUri: `${base}/callback`, resource: `${base}/mcp`, scopes: ['hireling:read', 'hireling:work', 'hireling:hire'], expiresAt: Math.floor(Date.now() / 1000) + 600 }, agents: [],
      } }) });
    });
    await context.route('**/__test/oauth-complete', route => route.fulfill({ contentType: 'text/html', body: '<p>Connected fixture</p>' }));
    await page.goto(`${base}/connect?oauth_request=fixture`);
    await page.getByRole('button', { name: 'Create a new agent', exact: true }).click();
    await page.getByRole('button', { name: 'Create agent wallet', exact: true }).click();
    await page.getByText(/^Agent ID 1942 is registered to your wallet\./).waitFor();
    const use = page.getByRole('button', { name: 'Use this agent for this connection', exact: true });
    assert.equal(await use.isDisabled(), false, 'OAuth setup does not require funding permissions');
    assert.equal(await page.getByText('Optional weekly spending allowance', { exact: true }).count(), 1);
    assert.equal(await page.getByText('Optional FACTORY backing', { exact: true }).count(), 1);
    assert.equal(await page.getByRole('textbox', { name: 'Weekly amount', exact: true }).isVisible(), false, 'optional allowance starts collapsed');
    assert.equal(await page.getByRole('textbox', { name: 'FACTORY to delegate to agent', exact: true }).isVisible(), false, 'optional backing starts collapsed');
    await page.getByText('Optional weekly spending allowance', { exact: true }).click();
    await page.getByRole('textbox', { name: 'Weekly amount', exact: true }).waitFor();
    await page.getByText('Optional weekly spending allowance', { exact: true }).click();
    assert.equal(await page.getByRole('heading', { level: 2, name: 'Connect your coding agent', exact: true }).count(), 0, 'OAuth already has a connecting client');
    await page.screenshot({ path: `${output}/oauth-${viewport.width}.png`, fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await use.click();
    await page.getByRole('heading', { name: 'Connection permissions', exact: true }).waitFor();
    assert.equal(await use.isDisabled(), false, 'selected agent with no allowance can connect');
    assert.equal(await page.getByRole('textbox', { name: 'Weekly amount', exact: true }).isVisible(), false);
    assert.equal(await page.getByRole('textbox', { name: 'FACTORY to delegate to agent', exact: true }).isVisible(), false);
    if (viewport.width === 1440) await page.getByRole('checkbox', { name: 'Hire · post, select, accept and reject' }).uncheck();
    assert.equal(await page.evaluate(() => window.__wallet.signatures.length + window.__wallet.sends.length), 0, 'connection without funding needs no wallet action');
    await use.click();
    await page.waitForURL('**/__test/oauth-complete');
    assert.deepEqual(decisions, [{ decision: 'approve', agentIds: ['managed'], scopes: viewport.width === 1440 ? ['hireling:read', 'hireling:work'] : ['hireling:read', 'hireling:work', 'hireling:hire'] }]);
    assert.deepEqual(permissionCalls, [], 'skipping optional sections requests no funding permissions');
    await page.goto(`${base}/agents/new`);
    await page.getByRole('button', { name: 'Create agent wallet', exact: true }).click();
    await page.getByRole('heading', { level: 2, name: 'Connect your coding agent', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__wallet.signatures.length + window.__wallet.sends.length), 0, 'rendering setup never signs or sends');
    await context.close();
    results.push({ viewport, checks: ['OAuth hides install snippet', 'standalone retains install snippet', 'optional sections collapsed', 'no allowance or backing needed', 'consent redirects with exact selected scopes', 'no funding API or wallet actions when skipped'], passed: true });
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

// VV2-014: an agent's owner tabs and the operator's private decisions exist only while the board session is live.
// C9: the retired /workspace and /approvals redirect, and an agent without an Agent ID resumes its setup.
// WS8: the operator takes the agent's directory listing down from Manage, one ad or the whole entry.
// Mocked Chromium on the delegation fixture, whose operator runs agent 1942. No real wallet, session or chain.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { base, browser, server, fixture, errors, output, agent } from './stake-fixture.mjs';

const results = [];
const owned = async (page) => {
  await page.goto(`${base}/agent/1942`);
  const tabs = page.getByRole('tablist', { name: 'Your agent' });
  await tabs.getByRole('tab', { name: 'Manage' }).click();
  await page.getByRole('button', { name: 'Stop hosted access and revoke' }).waitFor();
  return tabs;
};

try {
  {
    // The board stops honouring the session (expired or revoked): the next read fails, React Query keeps the last
    // list, and the page must not treat it as the operator's any more.
    const { context, page } = await fixture({ width: 1440, height: 900 });
    const tabs = await owned(page);
    await context.route('**/api/agents', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ ok: false, code: 'unauthorized', message: 'Session expired' }) }));
    // A tab returning to the foreground refetches (React Query listens on window); its retries take about 7 s.
    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
    await tabs.waitFor({ state: 'detached', timeout: 40_000 });
    assert.equal(await page.getByRole('button', { name: 'Stop hosted access and revoke' }).count(), 0);
    await page.getByText('My worker', { exact: true }).first().waitFor();
    results.push({ test: 'a failed managed-agents read hides the owner tabs; the public profile stays', passed: true });
    await context.close();
  }
  {
    // Signing out drops the owner tabs, the nested agents and the private decisions without a reload.
    const { context, page } = await fixture({ width: 1440, height: 900 });
    const tabs = await owned(page);
    const sidebar = page.getByRole('complementary', { name: 'Sections' });
    await sidebar.getByRole('list', { name: 'Your agents' }).getByRole('link', { name: /My worker/ }).waitFor();
    await sidebar.getByRole('button', { name: /^Account/ }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await tabs.waitFor({ state: 'detached' });
    assert.equal(await sidebar.getByRole('list', { name: 'Your agents' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Stop hosted access and revoke' }).count(), 0);
    await page.getByRole('link', { name: 'Agents' }).first().click();
    await page.getByText('Sign in to see your agents', { exact: true }).waitFor();
    results.push({ test: 'sign-out drops owner tabs, nested agents and private data without a reload', passed: true });
    await context.close();
  }
  {
    // The retired /workspace, /approvals, /protocol, /me and /stake have no page and no redirect. An agent with no
    // Agent ID yet opens its resumed setup rather than a page it does not have.
    const { context, page } = await fixture({ width: 1440, height: 900 });
    for (const old of ['/workspace', '/approvals', '/protocol', '/me', '/stake']) {
      await page.goto(`${base}${old}`);
      await page.getByRole('heading', { name: 'Page not found', level: 1 }).waitFor();
      assert.equal(new URL(page.url()).pathname, old);
    }
    await context.route('**/api/agents', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, result: { agents: [{ id: 'draft-1', name: 'Draft worker', address: null, agent_id: null, state: 'created', last_activity_at: null, revoke_json: '{}' }] } }) }));
    await page.goto(`${base}/agents`);
    const row = page.getByRole('main').getByRole('link', { name: /Draft worker/ });
    await row.getByText('No Agent ID yet · Setup not finished', { exact: true }).waitFor();
    await row.click();
    await page.waitForURL(`${base}/agents/new?resume=draft-1`);
    await page.getByRole('heading', { name: 'Finish setting up your agent' }).waitFor();
    await page.getByRole('button', { name: 'Resume wallet setup', exact: true }).waitFor();
    await page.goto(`${base}/agents/new?resume=not-mine`);
    await page.getByText('That agent is not one of yours', { exact: false }).waitFor();
    results.push({ test: 'retired paths show Page not found; an unregistered agent resumes at /agents/new?resume', passed: true });
    await context.close();
  }
  {
    // WS8 take-down: one ad, then the whole entry, each through the agent's own withdraw_service. The key is saved
    // before sending. A lost reply retries with the same key; a conflict, which that key cannot fix, starts a new one.
    const { context, page } = await fixture({ width: 1440, height: 900 });
    const ad = (serviceId, name) => ({ serviceId, name, description: 'Fixture ad', inputs: 'A repository', outputs: 'A branch', turnaroundSeconds: 3600, price: { model: 'quote', amountBaseUnits: '0', token: agent.wallet }, adHash: `0x${'00'.repeat(32)}`, expiresAt: Math.floor(Date.now() / 1000) + 86_400 });
    let listing = { ...agent, ads: [ad('review', 'Code review'), ad('refactor', 'Refactors')] };
    const failures = [{ status: 503, code: 'unavailable', message: 'Directory busy' }, null, { status: 409, code: 'conflict', message: 'The directory changed' }, null];
    const calls = [];
    const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    await context.route('**/data/directory/1942', (route) => (listing === null ? json(route, 404, { ok: false, code: 'not-found', message: 'Not in the directory' }) : json(route, 200, { ok: true, agent: listing })));
    await context.route('**/api/agents/managed/execute', (route) => {
      const body = route.request().postDataJSON();
      calls.push(body);
      const failure = failures[calls.length - 1];
      if (failure) return json(route, failure.status, { ok: false, code: failure.code, message: failure.message });
      listing = body.args.serviceId === undefined ? null : { ...listing, ads: listing.ads.filter((entry) => entry.serviceId !== body.args.serviceId) };
      return json(route, 200, { ok: true, result: { status: 'confirmed' } });
    });
    await owned(page);
    const card = page.getByRole('region', { name: 'Directory listing' });
    await card.getByText('Listed · Live · accepting work', { exact: true }).waitFor();
    await card.getByText('Refactors', { exact: true }).waitFor();
    const saved = (serviceId) => page.evaluate((name) => localStorage.getItem(name), `sidequest.listing-op:1942:${serviceId}`);

    await card.getByRole('button', { name: 'Take down' }).first().click();
    await card.getByRole('alert').getByText(/Directory busy/).waitFor();
    assert.equal(await saved('review'), calls[0].operationKey, 'a lost reply keeps the saved key');
    await card.getByRole('button', { name: 'Take down' }).first().click();
    await card.getByText('Code review', { exact: true }).waitFor({ state: 'detached' });
    assert.deepEqual(calls.slice(0, 2).map(({ tool, args }) => ({ tool, args })), [{ tool: 'withdraw_service', args: { serviceId: 'review' } }, { tool: 'withdraw_service', args: { serviceId: 'review' } }]);
    assert.equal(calls[1].operationKey, calls[0].operationKey);
    assert.equal(await saved('review'), null, 'a finished take-down forgets its key');
    await card.getByText('Refactors', { exact: true }).waitFor();

    const remove = async () => {
      await card.getByRole('button', { name: 'Remove from directory…' }).click();
      await card.getByRole('button', { name: 'Remove from directory', exact: true }).click();
    };
    await remove();
    await card.getByRole('alert').getByText(/The directory changed/).waitFor();
    assert.equal(await saved('*'), null, 'a conflict drops the key');
    await remove();
    await card.getByText('Not listed. Your agent lists its services itself with advertise_service.', { exact: true }).waitFor();
    assert.deepEqual(calls.slice(2).map(({ tool, args }) => ({ tool, args })), [{ tool: 'withdraw_service', args: {} }, { tool: 'withdraw_service', args: {} }]);
    assert.notEqual(calls[3].operationKey, calls[2].operationKey);
    assert.equal(calls.length, 4);
    results.push({ test: 'Manage takes one ad down and leaves the directory; a lost reply keeps its key, a conflict starts a new one', passed: true });
    await context.close();
  }
  assert.deepEqual(errors, []);
  writeFileSync(`${output}/owner-session.json`, JSON.stringify({ tier: 'mocked Chromium only', results }, null, 2));
  console.log(`PASS: owner session, ${results.length} checks`);
} finally {
  await browser.close();
  await server.close();
}

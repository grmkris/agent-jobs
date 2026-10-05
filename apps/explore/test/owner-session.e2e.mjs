// VV2-014: an agent's owner tabs and the operator's private decisions exist only while the board session is live.
// C9: the retired /workspace and /approvals redirect, and an agent without an Agent ID resumes its setup.
// Mocked Chromium on the delegation fixture, whose operator runs agent 1942. No real wallet, session or chain.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { base, browser, server, fixture, errors, output } from './stake-fixture.mjs';

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
    // C9: /workspace and /approvals are retired; old links land on My agents. An agent with no Agent ID yet opens its
    // resumed setup rather than a page it does not have.
    const { context, page } = await fixture({ width: 1440, height: 900 });
    for (const old of ['/workspace', '/approvals']) {
      await page.goto(`${base}${old}`);
      await page.waitForURL(`${base}/agents`);
      await page.getByRole('main').getByText('My worker', { exact: true }).waitFor();
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
    results.push({ test: 'retired pages redirect to My agents; an unregistered agent resumes at /agents/new?resume', passed: true });
    await context.close();
  }
  assert.deepEqual(errors, []);
  writeFileSync(`${output}/owner-session.json`, JSON.stringify({ tier: 'mocked Chromium only', results }, null, 2));
  console.log(`PASS: owner session, ${results.length} checks`);
} finally {
  await browser.close();
  await server.close();
}

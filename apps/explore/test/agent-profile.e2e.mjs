// The agent's public profile and its operator's tabs. A visitor sees what it took and posted, its numbers (gross on
// the tile, gross · fee · net on press), its backing and a Hire action; its operator also gets Needs you, Approvals
// (waiting cards, past rows) and Manage, and an approval link (`?tab=approvals&approval=<id>`, the agent's approveUrl)
// opens that approval in view. Mocked Chromium on the delegation fixture (agent 1942); no wallet, session or chain.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

process.env.STAKE_FIXTURE_PORT ??= '5196';
const { base, browser, server, fixture, errors, output, agentWallet, owner, other } = await import('./stake-fixture.mjs');

const config = JSON.parse(readFileSync(new URL('../../../contracts/config/monad-testnet.json', import.meta.url), 'utf8'));
const [musd, meur] = config.deployment.rewardTokens.map((t) => t.toLowerCase());
const now = Math.floor(Date.now() / 1000);
const job = (id, status, extra = {}) => ({
  job_id: id, kind: 'sidequest-v1', stack: 'main', mode: 'hire', status, creator: owner, approver: owner, token: musd, reward: '20000000',
  creator_bond: '0', worker_bond: '1000000000000000000', worker: agentWallet, agent_id: '1942', delivery_deadline: now + 86400,
  selection_deadline: null, deliverable: null, violation: null, published_tx: null, board_id: 'public', ...extra,
});
// Took 5 (3 paid, 1 lost, 1 overdue with nothing delivered); posted 3 (1 paid out, 1 waiting on review, 1 open).
const taken = [job('71', 'completed'), job('72', 'completed', { token: meur, reward: '10000000' }), job('73', 'completed'), job('74', 'rejected', { violation: 'Quality' }), job('75', 'active', { delivery_deadline: now - 3600 })];
const posted = [job('80', 'completed', { creator: agentWallet, worker: other, agent_id: '2001' }), job('81', 'submitted', { creator: agentWallet, worker: other, agent_id: '2001' }), job('82', 'open', { creator: agentWallet, worker: null, agent_id: null })];
const record = {
  ok: true,
  agent: { agentId: '1942', jobs: 5, completed: 3, inProgress: 1, lost: 1, earned: { [musd]: '54000000', [meur]: '9000000' }, feedback: { completed: 3, 'rejected-quality': 1 }, lastBlock: 100 },
  wallets: [agentWallet], bonds: { returned: 3, burned: 1 }, jobs: taken, feedback: [],
  registered: true, currentWallet: agentWallet, posted,
  work: { earned: { [musd]: { gross: '60000000', fee: '6000000', net: '54000000' }, [meur]: { gross: '10000000', fee: '1000000', net: '9000000' } } },
  hiring: { posted: 3, open: 2, paidOut: { [musd]: { gross: '20000000', fee: '2000000', net: '18000000' } } },
  time: { activeSince: now - 30 * 86400, lastActive: now - 3600, medianTurnaroundSeconds: 5400, turnarounds: 3 },
};
const approval = (id, extra) => ({ id, agent_id: 'managed', operation_id: `op-${id}`, kind: 'hire-over-limit', status: 'pending', request_json: JSON.stringify({ token: musd, amount: '500000000' }), created_at: now - 7200, decision_json: null, decided_at: null, ...extra });
const approvals = [
  approval('ap-wait'),
  approval('ap-old', { kind: 'unstake', status: 'rejected', request_json: JSON.stringify({ amount: '100000000000000000000', shares: '100000000000000000000' }), created_at: now - 3 * 86400, decided_at: now - 2 * 86400 }),
  approval('ap-done', { status: 'executed', request_json: JSON.stringify({ token: musd, amount: '300000000' }), created_at: now - 5 * 86400, decided_at: now - 5 * 86400 + 600 }),
];
const results = [];

const reply = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function profile(viewport, { mine = true } = {}) {
  const { context, page } = await fixture(viewport);
  await context.route('**/data/agents/1942', (route) => reply(route, record));
  await context.route('**/api/approvals', (route) => reply(route, { ok: true, result: { approvals } }));
  if (!mine) await context.route('**/api/agents', (route) => reply(route, { ok: true, result: { agents: [] } }));
  return { context, page };
}

/** Whether the element is (mostly) on screen; smooth scrolling settles first. */
const inView = (locator) => locator.evaluate((el) => {
  const r = el.getBoundingClientRect();
  return r.top >= 0 && r.top < window.innerHeight;
});
async function waitInView(page, locator) {
  for (let i = 0; i < 40; i += 1) {
    if (await inView(locator)) return;
    await page.waitForTimeout(100);
  }
  assert.fail('expected the approval to be scrolled into view');
}

try {
  {
    // A visitor: the profile is public — header with Hire, numbers, money breakdown, jobs both ways, backing.
    const { context, page } = await profile({ width: 1440, height: 900 }, { mine: false });
    await page.goto(`${base}/agent/1942`);
    await page.getByRole('heading', { level: 1, name: 'My worker' }).waitFor();
    await page.getByText('Agent ID 1942', { exact: true }).waitFor();
    assert.equal(await page.getByRole('tablist', { name: 'Your agent' }).count(), 0, 'a visitor gets no owner tabs');
    const hire = page.getByRole('link', { name: 'Hire this agent' });
    assert.match(await hire.getAttribute('href'), /\/publish\?invite=(%221942%22|1942)$/);
    // Where else to look it up: its identity NFT, its 8004scan profile and its wallet.
    await page.getByRole('button', { name: 'Look it up on an explorer' }).click();
    assert.match(await page.getByRole('menuitem', { name: 'Agent on Monadscan' }).getAttribute('href'), /\/nft\/0x[0-9a-fA-F]{40}\/1942$/);
    assert.match(await page.getByRole('menuitem', { name: 'Agent on 8004scan' }).getAttribute('href'), /^https:\/\/8004scan\.io\/agents\/monad-testnet\/1942$/);
    assert.match(await page.getByRole('menuitem', { name: 'Wallet on Monadscan' }).getAttribute('href'), /\/address\/0x2222222222222222222222222222222222222222$/i);
    await page.keyboard.press('Escape');

    await page.getByText('75 %', { exact: true }).waitFor();
    await page.getByText('3 of 4 paid · 1 open', { exact: true }).waitFor();
    await page.getByText('Needs attention:', { exact: true }).waitFor();
    await page.getByText(/delivers in .* \(median of 3\)/).waitFor();
    assert.doesNotMatch(await page.getByText(/^On Sidequest since /).innerText(), /since (Sun|Mon|Tue|Wed|Thu|Fri|Sat)\b/, 'since a day, not a weekday');
    await page.getByRole('list', { name: 'Ratings' }).getByText('Deposit burned once', { exact: true }).waitFor();

    // Gross on the tile; pressing it shows gross, Sidequest's fee and net per token.
    const earned = page.getByRole('button', { name: /^Earned/ });
    await earned.getByText('60 mUSD', { exact: true }).waitFor();
    await earned.click();
    await page.getByText('Gross is the reward and any bonus.', { exact: false }).waitFor();
    await page.getByRole('row', { name: /mUSD\s+60\s+6\s+54/ }).waitFor();
    await page.getByRole('row', { name: /mEUR\s+10\s+1\s+9/ }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByText('Gross is the reward and any bonus.', { exact: false }).waitFor({ state: 'detached' });

    // One list, Took or Posted, opening on the side with more jobs.
    await page.getByRole('heading', { name: 'Jobs · 8' }).waitFor();
    const took = page.getByRole('radio', { name: 'Took · 5' });
    assert.equal(await took.getAttribute('aria-checked'), 'true');
    await page.getByRole('link', { name: /Job #75/ }).getByText('Job #75', { exact: true }).waitFor();
    await page.getByRole('radio', { name: 'Posted · 3' }).click();
    await page.getByRole('link', { name: /Job #82/ }).waitFor();
    assert.equal(await page.getByRole('link', { name: /Job #75/ }).count(), 0);

    // Backing: the summary, then the breakdown and the backers in place; a token chip says what the token is.
    const backing = page.getByRole('region', { name: 'Backing' }).or(page.locator('section', { has: page.getByRole('heading', { name: 'Backing', exact: true }) })).first();
    await backing.getByText('total backing', { exact: true }).waitFor();
    await backing.getByRole('link', { name: 'Back this agent' }).waitFor();
    await backing.getByText('Details', { exact: true }).click();
    await backing.getByText('Top backers', { exact: true }).waitFor();
    await backing.getByText('Reserved by live jobs', { exact: true }).waitFor();
    await backing.getByRole('button', { name: /SIDE/ }).first().click();
    await page.getByRole('link', { name: 'View on Monadscan' }).waitFor();
    await page.keyboard.press('Escape');
    await page.screenshot({ path: `${output}/agent-profile-visitor-1440.png`, fullPage: true });
    results.push({ test: 'visitor: public header with Hire, stats, gross·fee·net popover, Took/Posted, backing details, token popover', passed: true });
    await context.close();
  }
  {
    // Its operator: no Hire; Needs you on Overview leads to the waiting approval.
    const { context, page } = await profile({ width: 1440, height: 900 });
    await page.goto(`${base}/agent/1942`);
    const tabs = page.getByRole('tablist', { name: 'Your agent' });
    await tabs.waitFor();
    assert.equal(await tabs.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected'), 'true');
    assert.equal(await page.getByRole('link', { name: 'Hire this agent' }).count(), 0, 'the operator does not hire their own agent');
    const needs = page.getByRole('region', { name: 'Needs you' });
    await needs.getByText('One decision is waiting for you', { exact: true }).waitFor();
    await needs.getByText('Past its delivery deadline with nothing delivered: job #75', { exact: true }).waitFor();
    await needs.getByText('Work submitted on job #81 it posted waits for review', { exact: true }).waitFor();
    assert.equal(await page.getByText('Needs attention:', { exact: true }).count(), 0, 'the overdue job is not repeated below Needs you');
    await needs.getByText('One decision is waiting for you', { exact: true }).click();
    assert.equal(await tabs.getByRole('tab', { name: /Approvals/ }).getAttribute('aria-selected'), 'true');
    assert.equal(new URL(page.url()).search, '?tab=approvals');
    await page.getByText('Waiting · 1', { exact: true }).waitFor();
    // The live harness's contract: each waiting approval is its own section holding its operation id (its one button
    // reads "Sign and approve hire" once the budget is reviewed, which needs the chain).
    const card = page.locator('section').filter({ hasText: 'Operation op-ap-wait' });
    assert.equal(await card.count(), 1);
    await card.getByRole('button', { name: 'Review exact budget' }).waitFor();
    await page.getByRole('heading', { name: 'Past · 2' }).waitFor();
    await page.getByText('Leave agent-owned backing', { exact: true }).waitFor();
    await page.getByText('Rejected', { exact: true }).waitFor();
    await page.getByText('Done', { exact: true }).waitFor();
    results.push({ test: 'operator: no Hire; Needs you lists the approval, the overdue job and the review; it opens Approvals (waiting card + past rows)', passed: true });
    await context.close();
  }
  {
    // An approval link opens Approvals with that approval in view: a waiting one ringed, a past one unfolded.
    const { context, page } = await profile({ width: 1440, height: 600 });
    await page.goto(`${base}/agent/1942?tab=approvals&approval=ap-wait`);
    const tabs = page.getByRole('tablist', { name: 'Your agent' });
    await tabs.waitFor();
    assert.equal(await tabs.getByRole('tab', { name: /Approvals/ }).getAttribute('aria-selected'), 'true');
    const waiting = page.locator('#approval-ap-wait');
    await waiting.waitFor();
    assert.equal(await waiting.getAttribute('data-focus'), 'true');
    await waitInView(page, waiting);
    await page.screenshot({ path: `${output}/agent-profile-approval-link-1440.png` });

    await page.goto(`${base}/agent/1942?approval=ap-old`);
    const old = page.locator('#approval-ap-old');
    await old.waitFor();
    assert.equal(await old.evaluate((el) => el.open), true, 'the linked past approval is unfolded');
    await old.getByText('Operation op-ap-old', { exact: true }).waitFor();
    await waitInView(page, old);
    assert.equal(await page.locator('#approval-ap-done').evaluate((el) => el.open), false);
    assert.equal(new URL(page.url()).search, '?approval=ap-old&tab=approvals');

    // Leaving Approvals lets the link go; the old Connect tab lands on Manage.
    await tabs.getByRole('tab', { name: 'Manage' }).click();
    await page.getByRole('button', { name: 'Stop hosted access and revoke' }).waitFor();
    assert.equal(new URL(page.url()).search, '?tab=manage');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: `${output}/agent-profile-manage-1440.png`, fullPage: true });
    await tabs.getByRole('tab', { name: /Approvals/ }).click();
    assert.equal(await old.getAttribute('data-focus'), null, 'the focus does not come back');

    await page.goto(`${base}/agent/1942?tab=connect`);
    await tabs.waitFor();
    assert.equal(await tabs.getByRole('tab', { name: 'Manage' }).getAttribute('aria-selected'), 'true');
    assert.equal(await page.getByRole('article', { name: 'My worker' }).count(), 1, 'Manage is one article named for the agent');
    await page.getByText('Paste into your coding agent', { exact: true }).waitFor();
    results.push({ test: 'an approval link opens Approvals with it in view (waiting ringed, past unfolded); the focus ends on leaving; ?tab=connect opens Manage', passed: true });
    await context.close();
  }
  {
    // Phone, light and dark: the page reads top to bottom for both, and the tabs scroll away with it.
    for (const mine of [false, true]) {
      const { context, page } = await profile({ width: 390, height: 844 }, { mine });
      await page.goto(`${base}/agent/1942`);
      await page.getByRole('heading', { name: 'Jobs · 8' }).waitFor();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.equal(overflow, 0, 'no sideways scroll on a phone');
      await page.screenshot({ path: `${output}/agent-profile-${mine ? 'owner' : 'visitor'}-390.png`, fullPage: true });
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.screenshot({ path: `${output}/agent-profile-${mine ? 'owner' : 'visitor'}-390-dark.png`, fullPage: true });
      await context.close();
    }
    results.push({ test: 'phone (390): visitor and operator pages fit without sideways scroll', passed: true });
  }
  assert.deepEqual(errors, []);
  writeFileSync(`${output}/agent-profile.json`, JSON.stringify({ tier: 'mocked Chromium only', results }, null, 2));
  console.log(`PASS: agent profile, ${results.length} checks`);
} finally {
  await browser.close();
  await server.close();
}

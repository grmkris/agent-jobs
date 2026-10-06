// Mocked Chromium only: discovery and contextual agent handoff; no real wallet or economic effect.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
process.env.STAKE_FIXTURE_PORT ??= '5203';
const { base, browser, server, fixture, errors, output, agentWallet, owner, other } = await import('./stake-fixture.mjs');
const config = JSON.parse(readFileSync(new URL('../../../contracts/config/monad-testnet.json', import.meta.url), 'utf8'));
const token = config.deployment.rewardTokens[0].toLowerCase();
const now = Math.floor(Date.now() / 1000);
const jobs = [
  ['11', 'Fix coding tests', ['coding'], 'open'],
  ['12', 'Research design systems', ['design', 'research'], 'active'],
  ['13', 'An existing untagged job', [], 'open'],
].map(([id, title, tags, status]) => ({ id, title, tags, status }));
const chain = jobs.map(job => ({ job_id: job.id, kind: 'sidequest-v1', stack: 'main', mode: 'hire', status: job.status,
  creator: owner, approver: owner, worker: job.status === 'active' ? agentWallet : null, agent_id: job.status === 'active' ? '1942' : null,
  token, reward: '10000000', creator_bond: '0', worker_bond: '0', delivery_deadline: now + 86400, board_id: 'public' }));
const tasks = jobs.map(job => ({ taskId: `task-${job.id}`, jobId: job.id, kind: 'sidequest-v1', stack: 'main', mode: 'hire', title: job.title,
  tags: job.tags, brief: 'Brief', acceptanceCriteria: ['Works'], token, reward: '10000000', creatorBond: '0', workerBond: '0', creator: owner,
  approver: owner, deliveryDeadline: now + 86400, selectionDeadline: null, requiredChecks: [], quoted: false, executionBudget: null,
  screening: { verdict: 'clean', reasons: [] }, createdAt: now }));
const publishers = [
  { id: 'publisher', agent_id: '1942', address: agentWallet, name: 'My publisher', state: 'active' },
  { id: 'second', agent_id: '2001', address: other, name: 'Second publisher', state: 'active' },
];
const results = [];
const reply = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
async function setup(viewport, options = {}) {
  const f = await fixture(viewport, options);
  const state = { agents: publishers, agentReads: 0, failAgents: false, delay: 0, creator: owner, picked: null, writes: [] };
  await f.context.route('**/data/jobs*', route => reply(route, { ok: true, jobs: chain, index: { next_block: 100, updated_at: now } }));
  await f.context.route('**/api/task_index', route => reply(route, { ok: true, result: tasks }));
  await f.context.route('**/api/agents', async route => {
    state.agentReads += 1;
    if (state.delay) await new Promise(resolve => setTimeout(resolve, state.delay));
    return reply(route, state.failAgents ? { ok: false, message: 'Publishers unavailable' } : { ok: true, result: { agents: state.agents } }, state.failAgents ? 503 : 200);
  });
  await f.context.route('**/api/list_quote_requests', route => reply(route, { ok: true, result: [{ requestId: 'req', title: 'Quote this job', brief: 'Brief', creator: state.creator,
    acceptanceCriteria: ['Works'], tokens: [token], creatorBond: '0', workerBond: '0', deliveryDeadline: now + 86400, quoteDeadline: now + 3600 }] }));
  await f.context.route('**/api/list_quotes', route => reply(route, { ok: true, result: { creator: state.creator, picked: state.picked,
    quotes: state.creator === owner ? [{ quoteId: 'quote', worker: other, agentId: '2001', token, symbol: 'mUSD', amount: '10', note: '', expectedCosts: null }] : [] } }));
  await f.context.route('**/api/pick_quote', route => { state.writes.push(route.request().postDataJSON()); return reply(route, { ok: false, message: 'No sends in this fixture' }, 400); });
  return { ...f, state };
}
try {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    const { page, context, state } = await setup(viewport);
    const device = viewport.width === 390 ? 'mobile' : 'desktop';
    await page.goto(`${base}/jobs`);
    await page.getByText('Fix coding tests', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: /Board:/ }).count(), 0);
    const chips = page.getByRole('group', { name: 'Filter by tags' });
    await chips.getByRole('button', { name: 'Coding', exact: true }).click();
    assert.equal(await page.getByText('Research design systems', { exact: true }).count(), 0);
    assert.equal(await page.getByText('An existing untagged job', { exact: true }).count(), 0);
    await chips.getByRole('button', { name: 'Research', exact: true }).click();
    await page.getByText('Research design systems', { exact: true }).waitFor();
    await page.getByRole('textbox', { name: 'Search jobs' }).fill('Research');
    assert.equal(await page.getByText('Fix coding tests', { exact: true }).count(), 0);
    await page.reload();
    assert.equal(await page.getByRole('textbox', { name: 'Search jobs' }).inputValue(), 'Research');
    assert.equal(await chips.getByRole('button', { name: 'Coding', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(new URL(page.url()).searchParams.get('tags'), 'coding,research');
    await page.getByRole('radio', { name: /^Open/ }).click();
    await page.getByText('No jobs match', { exact: true }).waitFor();
    await page.getByRole('radio', { name: /^All/ }).click();
    await page.getByRole('textbox', { name: 'Search jobs' }).fill('');
    await chips.getByRole('button', { name: 'Clear', exact: true }).click();
    await page.getByText('An existing untagged job', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Create with agent', exact: true }).first().click();
    const sheet = page.getByRole('dialog', { name: 'Create with your agent' });
    await sheet.getByRole('combobox', { name: 'Publisher', exact: true }).waitFor();
    assert.equal(await sheet.getByRole('textbox', { name: 'Agent instruction' }).count(), 0);
    await sheet.getByRole('combobox', { name: 'Publisher', exact: true }).selectOption('publisher');
    const prompt = await sheet.getByRole('textbox', { name: 'Agent instruction' }).inputValue();
    assert.match(prompt, /publisher must be my agent #1942/);
    assert.ok(prompt.includes(agentWallet));
    assert.ok(prompt.includes(`${base}/mcp`));
    assert.match(prompt, /same operation and chain receipt before retrying/);
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Denied'); } } }));
    await sheet.getByRole('button', { name: 'Copy instruction', exact: true }).click();
    await sheet.getByText('Copy failed', { exact: true }).waitFor();
    assert.equal(await sheet.getByRole('textbox', { name: 'Agent instruction' }).inputValue(), prompt);
    assert.deepEqual(state.writes, []);
    assert.equal(await page.evaluate(() => window.__wallet.sends.length), 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `${output}/${device}-creation.png`, fullPage: true });
    await sheet.getByRole('button', { name: 'Close', exact: true }).click();
    // Opening after a revoked publisher must not expose a cached old instruction while the fresh list is loading.
    state.agents = [{ ...publishers[0], state: 'revoked' }]; state.delay = 600;
    await page.getByRole('button', { name: 'Create with agent', exact: true }).first().click();
    assert.equal(await sheet.getByRole('textbox', { name: 'Agent instruction' }).count(), 0);
    await sheet.getByText('Set up a publisher or sign in to choose one you already own.', { exact: false }).waitFor();
    await sheet.getByRole('button', { name: 'Close', exact: true }).click();
    state.delay = 0; state.agents = publishers; state.creator = agentWallet;
    await page.goto(`${base}/quotes/req`);
    await page.getByRole('button', { name: 'Choose with your agent', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Pick', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Choose with your agent', exact: true }).click();
    const pickSheet = page.getByRole('dialog', { name: 'Choose with the publisher' });
    const pickPrompt = await pickSheet.getByRole('textbox', { name: 'Agent instruction' }).inputValue();
    assert.match(pickPrompt, /quote request req/);
    assert.match(pickPrompt, /publisher must be my agent #1942/);
    assert.equal(await pickSheet.getByRole('combobox').count(), 0);
    await pickSheet.getByRole('button', { name: 'Close', exact: true }).click();
    state.creator = owner;
    await page.goto(`${base}/quotes/req?fresh=1`);
    await page.getByRole('button', { name: viewport.width === 390 ? 'Pick' : 'Pick this quote', exact: true }).first().waitFor();
    assert.deepEqual(state.writes, []);
    await page.goto(`${base}/b/client-board`);
    await page.getByRole('button', { name: 'Create with agent', exact: true }).click();
    await sheet.getByRole('combobox', { name: 'Publisher', exact: true }).selectOption('publisher');
    await sheet.getByRole('textbox', { name: 'Agent instruction' }).waitFor();
    assert.ok((await sheet.getByRole('textbox', { name: 'Agent instruction' }).inputValue()).includes(`${base}/b/client-board/mcp`));
    await sheet.getByRole('button', { name: 'Close', exact: true }).click();
    results.push({ device, passed: true, checks: ['tag OR with search/phase AND', 'URL reload', 'untagged visible without tags', 'owned publisher choice', 'clipboard failure', 'revoked cached publisher denied', 'hosted requester exact publisher', 'exact browser requester keeps picker', 'tenant MCP context', 'no sends'] });
    await context.close();

    // Signed-out visitors need setup/sign-in; opening a handoff must never force the disabled private query.
    const anonymous = await setup(viewport, { connected: false });
    await anonymous.page.goto(`${base}/jobs`);
    await anonymous.page.getByText('Fix coding tests', { exact: true }).waitFor();
    assert.equal(anonymous.state.agentReads, 0);
    await anonymous.page.getByRole('button', { name: 'Create with agent', exact: true }).click();
    const anonymousSheet = anonymous.page.getByRole('dialog', { name: 'Create with your agent' });
    await anonymousSheet.waitFor();
    await anonymous.page.waitForTimeout(250);
    assert.equal(anonymous.state.agentReads, 0, 'opening the anonymous sheet makes no private agent request');
    await anonymousSheet.getByRole('button', { name: 'Sign in to choose a publisher', exact: true }).waitFor();
    await anonymousSheet.getByRole('link', { name: 'Set up an agent', exact: true }).waitFor();
    assert.equal(await anonymousSheet.getByRole('textbox', { name: 'Agent instruction' }).count(), 0);
    assert.equal(await anonymousSheet.getByRole('button', { name: 'Retry publishers', exact: true }).count(), 0);
    await anonymousSheet.getByRole('button', { name: 'Close', exact: true }).click();
    assert.equal(anonymous.state.agentReads, 0);
    results.push({ device, signedIn: false, passed: true, checks: ['no private agents call on open', 'sign-in and setup visible', 'no publisher prompt', 'no retry-only error'] });
    await anonymous.context.close();
  }
  assert.deepEqual(errors, []);
  writeFileSync(`${output}/results.json`, JSON.stringify({ tier: 'mocked Chromium only', results, errors }, null, 2));
  console.log(`PASS: discovery and agent handoff, ${results.length} viewport records`);
} finally { await browser.close(); await server.close(); }

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

// Hire again: paid jobs and agent profiles hand context to the exact owned publisher. The agent is still marked
// as hired before among a later job's applicants.
// Mocked Chromium only: no live jobs, signing or sends.
const directory = fileURLToPath(new URL('.', import.meta.url));
const output = process.argv[2] ?? '/tmp/sidequest-hire-again-evidence';
const base = 'http://127.0.0.1:5193';
const creator = '0x1111111111111111111111111111111111111111';
const stranger = '0x5555555555555555555555555555555555555555';
const worker = '0x3333333333333333333333333333333333333333';
// The deployment's second listed reward token (mEUR on testnet, 6 decimals): known to the app without a chain read.
const config = JSON.parse(readFileSync(new URL('../../../contracts/config/monad-testnet.json', import.meta.url), 'utf8'));
const token = config.deployment.rewardTokens[1].toLowerCase();
const now = Math.floor(Date.now() / 1000);
const created = now - 5 * 86400;
const offer = (jobId, extra = {}) => ({
  taskId: `task-${jobId}`, jobId, stack: 'main', kind: 'sidequest-v1', title: `Fix the flaky test (job ${jobId})`, brief: 'It fails one run in ten. Find out why.', acceptanceCriteria: ['CI is green', 'No retries added'],
  mode: 'hire', token, reward: '12500000', creatorBond: '2000000000000000000', workerBond: '1500000000000000000', creator, approver: creator,
  deliveryDeadline: created + 72 * 3600, selectionDeadline: null, requiredChecks: ['ci'], quoted: false, executionBudget: null,
  deliverable: { accepts: ['git', 'url'], target: 'https://example.test' }, termsHash: `0x${jobId.padStart(64, '0')}`, manifestUrl: `/offers/${jobId}.json`,
  screening: { verdict: 'clean', reasons: [] }, createdAt: created, status: 'completed', ...extra,
});
const chainJob = (jobId, status, agentId) => ({ job_id: jobId, status, mode: 'hire', board_id: 'public', stack: 'main', kind: 'sidequest-v1', token, reward: '12500000', creator, approver: creator, worker: agentId === null ? null : worker, agent_id: agentId, delivery_deadline: created + 72 * 3600, creator_bond: '2000000000000000000', worker_bond: '1500000000000000000', violation: null, rejection_reason_hash: null });
const jobs = [chainJob('61', 'open', null), chainJob('58', 'completed', '7001'), chainJob('57', 'completed', '7001')];
const tasks = [offer('61', { status: 'open', title: 'A new job for the same agent', deliveryDeadline: now + 86400 }), offer('58'), offer('57')];
const applications = [{ id: 'app-2', worker: `0x${'4'.repeat(40)}`, agent_id: '7002', note: 'Mocked applicant' }, { id: 'app-1', worker, agent_id: '7001', note: 'Mocked applicant' }];
const results = [];
const errors = [];

process.env.PRIVY_APP_ID = 'fixture-privy-app-id';
const server = await createServer({ envFile: false, server: { host: '127.0.0.1', port: 5193, strictPort: true }, plugins: [{ name: 'hire-again-fixtures', enforce: 'pre', resolveId(source) {
  if (source === 'wagmi') return `${directory}directory-wagmi.mjs`;
  if (source === 'wagmi/actions') return `${directory}wagmi-actions.mjs`;
  if (source.endsWith('/Privy.tsx')) return `${directory}privy.mjs`;
  if (source === '@privy-io/react-auth') return `${directory}privy-react-auth.mjs`;
} }] });
await server.listen();
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/home/kristjan/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome' });
mkdirSync(output, { recursive: true });

async function fixture(viewport, address = creator) {
  const context = await browser.newContext({ viewport, hasTouch: viewport.width === 390, isMobile: viewport.width === 390 });
  await context.addInitScript(({ owner, arbiter }) => {
    window.__v1 = { arbiter, free: 100n * 10n ** 18n };
    window.__wallet = { address: owner, connected: true, signatures: [], sends: [] };
    localStorage.setItem('sidequest.session', 'fixture-only-not-a-real-session');
    localStorage.setItem('sidequest.session-owner', JSON.stringify({ address: owner, expiresAt: Math.floor(Date.now() / 1000) + 86400 }));
  }, { owner: address, arbiter: config.sidequest.defaultArbitrator });
  const state = { created: [] };
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort('blockedbyclient');
    const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/__test/token') return reply({ symbol: 'TEST', decimals: 6 });
    if (url.pathname === '/data/jobs') return reply({ ok: true, jobs, index: { next_block: 100, updated_at: now } });
    const detail = /^\/data\/jobs\/(\d+)$/.exec(url.pathname)?.[1];
    if (detail !== undefined) {
      const job = jobs.find((j) => j.job_id === detail);
      return reply({ ok: true, job, board: { boardId: 'public', taskId: `task-${detail}` }, rewards: job.status === 'completed' ? [{ kind: 'reward', recipient: worker, amount: '12500000', tx_hash: `0x${'a'.repeat(64)}` }] : [], bonds: [], evidence: [], feedback: null, ruling: null, timeline: [] });
    }
    if (url.pathname === '/data/agents/7001') return reply({ ok: true, agent: { agentId: '7001', jobs: 2, completed: 2, inProgress: 0, lost: 0, earned: { [token]: '25000000' }, feedback: { completed: 2 }, lastBlock: 100 }, wallets: [worker], bonds: { returned: 2 }, jobs: jobs.filter((j) => j.agent_id === '7001'), feedback: [] });
    if (url.pathname.startsWith('/data/directory/')) return reply({ ok: false, code: 'not-found', message: 'Not in the directory' }, 404);
    if (url.pathname === '/data/boards') return reply({ ok: true, boards: [] });
    if (url.pathname === '/data/stats') return reply({ ok: true, jobs: 0, completed: 0, agents: 0, activity: { demo: 0, unclassified: 0, independent: null }, accounting: {} });
    if (url.pathname.startsWith('/data/')) return reply({ ok: true, agents: [], jobs: [] });
    if (url.pathname.includes('/api/')) {
      const name = url.pathname.split('/').at(-1);
      if (name === 'agents') return reply({ ok: true, result: { agents: [{ id: 'publisher', agent_id: '8123', name: 'My publisher', address: '0x2222222222222222222222222222222222222222', state: 'active' }] } });
      if (name === 'task_index') return reply({ ok: true, result: tasks });
      if (name === 'get_task') {
        const { taskId } = route.request().postDataJSON();
        const task = tasks.find((t) => t.taskId === taskId);
        // The offer Hire again just froze: not published.
        if (task === undefined) return reply({ ok: true, result: { taskId, jobId: null, creator } });
        const open = task.jobId === '61';
        return reply({ ok: true, result: { ...task, you: address === creator ? ['creator', 'approver'] : [], selection: [], terms: { brief: task.brief, acceptanceCriteria: task.acceptanceCriteria, windows: { reviewSeconds: 259200, disputeSeconds: 259200, arbitrationSeconds: 259200 } }, chain: { status: open ? 'open' : 'completed', provider: open ? null : worker, timely: true, submittedAt: open ? null : created + 3600, reviewEndsAt: null, disputeEndsAt: null, arbitrationEndsAt: null, violation: null, listingMatchesOffer: true, paused: false } } });
      }
      if (name === 'list_applications') return reply({ ok: true, result: applications });
      if (name === 'create_task') {
        state.created.push(route.request().postDataJSON());
        return reply({ ok: true, result: { taskId: 'task-new', termsHash: `0x${'b'.repeat(64)}`, manifestUrl: '/offers/new.json', screening: null, transactions: [{ description: 'Publish job', chainId: 10143, to: token, data: '0x01', value: '0' }] } });
      }
      return reply({ ok: false, message: 'Fixture denies this operation' }, 400);
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  return { context, page, state };
}

async function capture(page, name) {
  const width = await page.evaluate(() => ({ actual: document.documentElement.scrollWidth, expected: innerWidth }));
  assert.ok(width.actual <= width.expected, `${name}: horizontal overflow`);
  await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
}

try {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    const device = viewport.width === 390 ? 'mobile' : 'desktop';
    const { context, page, state } = await fixture(viewport);
    await page.goto(`${base}/job/58`);
    await page.getByText('Paid', { exact: true }).first().waitFor();
    await page.getByRole('button', { name: 'Hire again', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Create with your agent' });
    await sheet.getByRole('textbox', { name: 'Agent instruction' }).waitFor();
    const prompt = await sheet.getByRole('textbox', { name: 'Agent instruction' }).inputValue();
    assert.match(prompt, /Read job #58 and its frozen offer/);
    assert.match(prompt, /publisher must be my agent #8123/);
    assert.equal(new URL(page.url()).pathname, '/job/58');
    assert.deepEqual(state.created, []);
    assert.equal(await page.evaluate(() => window.__wallet.sends.length), 0);
    await capture(page, `${device}-hire-again-prompt`);
    await sheet.getByRole('button', { name: 'Close', exact: true }).click();
    await page.goto(`${base}/agent/7001`);
    await page.getByRole('button', { name: 'Hire again', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Hire again', exact: true }).click();
    await sheet.getByRole('textbox', { name: 'Agent instruction' }).waitFor();
    assert.match(await sheet.getByRole('textbox', { name: 'Agent instruction' }).inputValue(), /Read job #58/);
    await sheet.getByRole('button', { name: 'Close', exact: true }).click();
    await page.goto(`${base}/job/61`);
    await page.getByText('Applications · 2', { exact: true }).waitFor();
    const first = page.locator('a[href$="/agent/7001"], a[href$="/agent/7002"]').first();
    assert.equal(await first.innerText(), 'Worker #7001');
    assert.equal(await page.getByText('Hired before', { exact: true }).count(), 1);
    results.push({ device, passed: true, checks: ['paid creator contextual prompt', 'publisher separate from worker', 'no create or send', 'profile latest paid context', 'hired-before applicant first'] });
    await context.close();
  }
  {
    const { context, page } = await fixture({ width: 390, height: 844 }, stranger);
    await page.goto(`${base}/job/58`);
    await page.getByText('Paid', { exact: true }).first().waitFor();
    assert.equal(await page.getByRole('button', { name: 'Hire again', exact: true }).count(), 0);
    await page.goto(`${base}/agent/7001`);
    await page.getByText(/Jobs · 2/).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Hire again', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Hire this agent', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Create with your agent' });
    await sheet.getByRole('textbox', { name: 'Agent instruction' }).waitFor();
    const prompt = await sheet.getByRole('textbox', { name: 'Agent instruction' }).inputValue();
    assert.match(prompt, /invite.agentId="7001"/);
    assert.match(prompt, /publisher must be my agent #8123/);
    assert.equal(await page.evaluate(() => window.__wallet.sends.length), 0);
    await sheet.getByRole('button', { name: 'Close', exact: true }).click();
    await page.goto(`${base}/publish?again=61`);
    await page.getByRole('heading', { name: 'Page not found', exact: true }).waitFor();
    results.push({ passed: true, checks: ['stranger has no hire-again shortcut', 'hire invitation contextual prompt', 'manual posting route removed'] });
    await context.close();
  }
  assert.deepEqual(errors, []);
  writeFileSync(`${output}/results.json`, JSON.stringify({ tier: 'mocked Chromium only; no live jobs, signing or sends', results, errors }, null, 2));
  console.log(`PASS: hire again, ${results.length} evidence records`);
} finally {
  await browser.close();
  await server.close();
}

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { PRODUCTION_CLOCKS } from '../../../packages/sdk/src/deployment.ts';

// The mainnet launch gate (PROD-GATE-006, D16). A mainnet build with MAINNET_LIVE false is reads only: every page that
// writes says "launching soon" when opened by its URL (also under a board and in the widget), a banner says so on every
// page, the board is asked only read tools, and /release.json reports the pinned value. With MAINNET_LIVE true the
// same pages open, and a testnet build links to mainnet instead of "soon". Mocked Chromium only: no board, signing or sends.
const directory = fileURLToPath(new URL('.', import.meta.url));
const output = process.argv[2] ?? '/tmp/hireling-launch-evidence';
const me = '0x1111111111111111111111111111111111111111';
const READ_TOOLS = new Set(['get_task', 'task_index', 'get_board', 'list_boards', 'list_quote_requests', 'list_quotes', 'list_directory', 'get_directory_agent', 'collect_actions', 'sponsor_status', 'telegram_status', 'auth_challenge', 'auth_login', 'whoami', 'list_tasks']);
// Until mainnet is deployed its config has no deployment block and Explore cannot load; like the directory e2e, the
// run borrows testnet's for contracts it never calls, and the gate under test does not depend on it.
const readConfig = (name) => JSON.parse(readFileSync(new URL(`../../../contracts/config/${name}.json`, import.meta.url), 'utf8'));
const borrowed = readConfig('monad-mainnet').deployment?.core === undefined;
const results = [];
const errors = [];
mkdirSync(output, { recursive: true });
process.env.PRIVY_APP_ID = 'fixture-privy-app-id';
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/home/kristjan/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome' });

/** An Explore dev server for `network`, with MAINNET_LIVE as built (false) or forced true for the launch-day build. */
async function serve(port, network, live) {
  process.env.AGENT_JOBS_NETWORK = network;
  const server = await createServer({ envFile: false, server: { host: '127.0.0.1', port, strictPort: true }, plugins: [{ name: 'launch-fixtures', enforce: 'pre', resolveId(source) {
    if (source === 'wagmi') return `${directory}wagmi.mjs`;
    if (source === 'wagmi/actions') return `${directory}wagmi-actions.mjs`;
    if (source.endsWith('/Privy.tsx')) return `${directory}privy.mjs`;
    if (source === '@privy-io/react-auth') return `${directory}privy-react-auth.mjs`;
  }, transform(source, id) {
    if (live && id.endsWith('/src/release.ts')) return source.replace('export const MAINNET_LIVE = false', 'export const MAINNET_LIVE = true');
    if (borrowed && id.endsWith('/contracts/config/monad-mainnet.json')) {
      const deployment = readConfig('monad-testnet').deployment;
      return JSON.stringify({ ...JSON.parse(source), deployment: { ...deployment, hireling: { ...deployment.hireling, clocks: PRODUCTION_CLOCKS } } });
    }
  } }] });
  await server.listen();
  return server;
}

async function open(base, chainId, viewport = { width: 390, height: 844 }) {
  const context = await browser.newContext({ viewport, hasTouch: viewport.width === 390, isMobile: viewport.width === 390 });
  await context.addInitScript(({ account, chain }) => {
    window.__wallet = { address: account, connected: true, chainId: chain, signatures: [], sends: [] };
    localStorage.setItem('agent-jobs.session', 'fixture-only-not-a-real-session');
    localStorage.setItem('agent-jobs.session-owner', JSON.stringify({ address: account, expiresAt: Math.floor(Date.now() / 1000) + 86400 }));
  }, { account: me, chain: chainId });
  const tools = [];
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort('blockedbyclient');
    const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const tool = /\/api\/([a-z_]+)$/.exec(url.pathname)?.[1];
    if (tool !== undefined) {
      tools.push(tool);
      if (tool === 'task_index') return reply({ ok: true, result: [] });
      if (tool === 'get_board') return reply({ ok: true, result: { board: { id: 'acme', name: 'Acme', allowedOrigins: [] } } });
      return reply({ ok: false, code: 'not-found', message: 'Fixture has nothing here' }, 404);
    }
    if (url.pathname === '/data/jobs') return reply({ ok: true, jobs: [], index: { next_block: 100, updated_at: Math.floor(Date.now() / 1000) } });
    if (url.pathname === '/data/stats') return reply({ ok: true, jobs: 0, completed: 0, agents: 0, activity: { demo: 0, unclassified: 0, independent: null }, accounting: {} });
    if (url.pathname.startsWith('/data/')) return reply({ ok: true, agents: [], jobs: [], boards: [], next: null });
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  return { context, page, tools };
}

async function capture(page, name) {
  const width = await page.evaluate(() => ({ actual: document.documentElement.scrollWidth, expected: innerWidth }));
  assert.ok(width.actual <= width.expected, `${name}: horizontal overflow`);
  await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
}

// Every page that writes, by direct URL, with the title its "launching soon" state keeps.
const WRITE_ROUTES = [
  ['/publish', 'Post a job'], ['/stake', 'Stake'], ['/collect', 'Collect'], ['/admin', 'Admin'], ['/telegram', 'Telegram'],
  ['/sponsorship', 'Gas sponsorship'], ['/boards/new', 'Create a board'], ['/b/acme/publish', 'Post a job'], ['/embed/acme?view=publish', 'Post a job'],
];

const drained = await serve(5204, 'monad-mainnet', false);
try {
  const base = 'http://127.0.0.1:5204';
  const { context, page, tools } = await open(base, 143);
  const release = await (await page.request.get(`${base}/release.json`)).json();
  assert.deepEqual(release, { network: 'monad-mainnet', mainnetLive: false, writesOpen: false });

  await page.goto(base);
  await page.getByRole('note').filter({ hasText: 'Launching soon.' }).waitFor();
  await page.getByRole('group', { name: 'Network' }).first().locator('[aria-current="true"]', { hasText: 'Mainnet' }).waitFor();
  await capture(page, 'mainnet-home-drained');

  for (const [path, title] of WRITE_ROUTES) {
    await page.goto(`${base}${path}`);
    await page.getByRole('status').filter({ hasText: 'Hireling on mainnet opens soon' }).waitFor();
    if (!path.startsWith('/embed')) await page.getByRole('heading', { name: title, level: 1 }).waitFor();
    // Nothing on the page offers to write: no form fields, no review, stake, collect or confirm button.
    assert.equal(await page.getByRole('textbox').count(), 0, `${path}: a form field`);
    assert.equal(await page.getByRole('button', { name: /^(Review|Stake|Collect|Confirm|Link Telegram|Turn on|Create)/ }).count(), 0, `${path}: a write button`);
    await page.getByRole('link', { name: 'Try it on testnet' }).first().waitFor();
    if (path === '/stake') await capture(page, 'mainnet-stake-drained');
  }
  assert.deepEqual(errors, []);
  const writes = tools.filter((t) => !READ_TOOLS.has(t));
  assert.deepEqual(writes, [], `write tools reached the board: ${writes.join(', ')}`);
  results.push({ build: 'mainnet, MAINNET_LIVE false', checks: ['release.json pins false', 'banner on every page', 'Mainnet shown as the current network', ...WRITE_ROUTES.map(([p]) => `${p} by URL: launching soon, no form or write button`), 'only read tools reached the board'], passed: true });
  await context.close();
} finally {
  await drained.close();
}

const live = await serve(5205, 'monad-mainnet', true);
try {
  const base = 'http://127.0.0.1:5205';
  const { context, page } = await open(base, 143);
  await page.goto(`${base}/publish`);
  await page.getByRole('heading', { name: 'Post a job', level: 1 }).waitFor();
  assert.equal(await page.getByText('Hireling on mainnet opens soon').count(), 0);
  assert.equal(await page.getByRole('note').filter({ hasText: 'Launching soon.' }).count(), 0);
  await page.goto(`${base}/stake`);
  await page.getByRole('heading', { name: 'Stake', level: 1 }).waitFor();
  assert.equal(await page.getByText('Hireling on mainnet opens soon').count(), 0);
  results.push({ build: 'mainnet, MAINNET_LIVE true', checks: ['write pages open', 'no banner'], passed: true });
  await context.close();
} finally {
  await live.close();
}

const testnet = await serve(5206, 'monad-testnet', true);
try {
  const base = 'http://127.0.0.1:5206';
  const { context, page } = await open(base, 10143);
  await page.goto(base);
  const mainnet = page.getByRole('group', { name: 'Network' }).first().getByRole('link', { name: 'Mainnet' });
  assert.equal(await mainnet.getAttribute('href'), 'https://hireling.xyz/');
  results.push({ build: 'testnet, MAINNET_LIVE true', checks: ['Mainnet is a live link to https://hireling.xyz/'], passed: true });
  await context.close();
} finally {
  await testnet.close();
}

await browser.close();
assert.deepEqual(errors, []);
writeFileSync(`${output}/results.json`, JSON.stringify({ tier: 'mocked Chromium only; no board, signing or sends', results, errors }, null, 2));
console.log(`PASS: launch, ${results.length} evidence records`);

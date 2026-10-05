import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { readFileSync } from 'node:fs';

// Mocked Chromium only: the real SDK reads encoded responses from a test-only RPC transport.
const directory = fileURLToPath(new URL('.', import.meta.url));
const output = process.argv[2] ?? '/tmp/hireling-delegation-evidence';
const port = Number(process.env.STAKE_FIXTURE_PORT ?? 5194);
const base = `http://127.0.0.1:${port}`;
const owner = '0x1111111111111111111111111111111111111111';
const delegator = JSON.parse(readFileSync(new URL('../../../contracts/config/monad-testnet.json', import.meta.url))).delegation.delegator;
const agentWallet = '0x2222222222222222222222222222222222222222';
const other = '0x3333333333333333333333333333333333333333';
const contracts = { factory: '0xf000000000000000000000000000000000000001', vault: '0xf000000000000000000000000000000000000002', feeSchedule: '0xf000000000000000000000000000000000000003', distributor: '0xf000000000000000000000000000000000000004', miningReserve: '0xf000000000000000000000000000000000000005', holding: '0xf000000000000000000000000000000000000006', evaluator: '0xf000000000000000000000000000000000000007', safe: '0xf000000000000000000000000000000000000008' };
const agent = { chainId: 10143, identityRegistry: contracts.factory, agentId: '1942', wallet: agentWallet, profile: { name: 'My worker', description: 'Fixture worker', services: [] }, profileSource: 'operator-supplied', agentURI: '', enrolled: true, ownership: 'verified', presence: { freshness: 'fresh', state: 'available', accepting: true, lastSeenBucket: null }, ads: [], observedAt: 100, projectionAt: 100, revision: 1 };
const errors = [];
const results = [];
process.env.PRIVY_APP_ID = 'fixture-privy-app-id';
const server = await createServer({ envDir: false, server: { host: '127.0.0.1', port, strictPort: true, watch: null, hmr: false }, plugins: [{ name: 'delegation-fixtures', enforce: 'pre', resolveId(source) {
  if (source === 'wagmi') return `${directory}stake-wagmi.mjs`;
  if (source === 'wagmi/actions') return `${directory}wagmi-actions.mjs`;
  if (source.endsWith('/stake-context.ts')) return `${directory}stake-chain.mjs`;
  if (source.endsWith('/Privy.tsx')) return `${directory}privy.mjs`;
  if (source === '@privy-io/react-auth') return `${directory}privy-react-auth.mjs`;
}, transform(source, id) {
  if (id.endsWith('/src/hireling.ts')) return source.replace(/export const hireling: HirelingContracts \| null =[\s\S]*?(\n\n|\n?$)/, 'export const hireling: HirelingContracts | null = (window as { __hireling?: HirelingContracts | null }).__hireling ?? null$1');
} }] });
await server.listen();
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/home/kristjan/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome' });
mkdirSync(output, { recursive: true });

async function fixture(viewport, options = {}) {
  const context = await browser.newContext({ viewport, hasTouch: viewport.width === 390, isMobile: viewport.width === 390 });
  await context.addInitScript(({ owner: fixtureOwner, delegator: fixtureDelegator, agentWallet: fixtureAgentWallet, other: fixtureOther, contracts: fixtureContracts, agent: fixtureAgent, options: fixtureOptions }) => {
    const E = 10n ** 18n;
    window.__hireling = fixtureOptions.deployed === false ? null : fixtureContracts;
    window.__agents = [fixtureAgent];
    window.__wallet = { address: fixtureOwner, connected: fixtureOptions.connected ?? true, signatures: [], sends: JSON.parse(localStorage.getItem('fixture-wallet-sends') ?? '[]') };
    window.__balances = { native: 5n * 10n ** 17n };
    window.__stake = { wallet: 50000n * E, nonce: 0n, calls: [], cooldown: 600, down: fixtureOptions.down ?? false, open: fixtureOptions.open ?? true, pools: {
      [fixtureOwner]: { assets: 4000n * E, reserved: 1500n * E, shares: 4000n * E, queuedShares: 0n, generation: 0n, positions: { [fixtureOwner]: { shares: 4000n * E, queuedShares: 0n, unlockAt: 0, generation: 0n } } },
      [fixtureAgentWallet]: { assets: 10000n * E, reserved: 8000n * E, shares: 10000n * E, queuedShares: 0n, generation: 0n, positions: { [fixtureOwner]: { shares: 6000n * E, queuedShares: 0n, unlockAt: 0, generation: 0n }, [fixtureOther]: { shares: 4000n * E, queuedShares: 0n, unlockAt: 0, generation: 0n } } },
    } };
    window.__stake.code = fixtureOptions.delegated ? { [fixtureOwner]: `0xef0100${fixtureDelegator.slice(2)}` } : {};
    window.__stake.receipts = JSON.parse(localStorage.getItem('fixture-stake-receipts') ?? '{}');
    if (fixtureOptions.proposal) window.__stake.proposal = fixtureOptions.proposal;
    if (fixtureOptions.retired) {
      const pool = window.__stake.pools[fixtureAgentWallet];
      Object.assign(pool, { assets: 0n, reserved: 0n, shares: 0n, queuedShares: 0n, generation: 1n });
      window.__stake.historical = { [fixtureAgentWallet]: '0' };
    }
    if (fixtureOptions.dust) {
      const pool = window.__stake.pools[fixtureAgentWallet];
      Object.assign(pool, { assets: 6n, shares: 10n, reserved: 0n });
      pool.positions[fixtureOwner].shares = 4n;
      pool.positions[fixtureOther].shares = 6n;
    }
    localStorage.setItem('agent-jobs.session', 'fixture-only-not-a-real-session');
    localStorage.setItem('agent-jobs.session-owner', JSON.stringify({ address: fixtureOwner, expiresAt: Math.floor(Date.now() / 1000) + 86400 }));
  }, { owner, delegator, agentWallet, other, contracts, agent, options });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort('blockedbyclient');
    const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/__test/receipt') return reply(await page.evaluate(hash => window.__stake.receipts[hash] ?? { status: 'success', logs: [] }, url.searchParams.get('hash')));
    if (url.pathname === '/data/directory') return reply({ ok: true, agents: [agent], nextCursor: null, observedAt: 100, chainId: 10143, identityRegistry: contracts.factory, scope: 'fixture' });
    if (url.pathname === '/data/directory/1942') return reply({ ok: true, agent });
    if (url.pathname === '/data/agents/1942') return reply({ ok: false, message: 'Fixture has no job history' }, 404);
    if (url.pathname === '/api/agents/managed') return reply({ ok: true, result: { allowances: [], grants: [], revocation: {} } });
    if (url.pathname === '/api/agents/managed/recovery') return reply({ ok: true, result: { grants: [] } });
    if (url.pathname === '/api/agents' && route.request().method() === 'POST') return reply({ ok: true, result: { id: 'managed', name: 'My worker', address: agentWallet, agent_id: '1942', state: 'active' } });
    if (url.pathname === '/api/agents') return reply({ ok: true, result: { agents: [{ id: 'managed', name: 'My worker', address: agentWallet, agent_id: '1942', state: 'active' }] } });
    if (url.pathname === '/data/delegations' || url.pathname.startsWith('/data/backing/')) {
      const down = await page.evaluate(() => window.__stake.down);
      if (down) return reply({ ok: false, message: 'Fixture index unavailable' }, 503);
      const snapshot = await page.evaluate(({ account, wallet }) => window.__stakingSnapshot(account, wallet), {
        account: url.pathname.startsWith('/data/backing/') ? url.pathname.split('/').at(-1) : undefined,
        wallet: url.searchParams.get('wallet') ?? undefined,
      });
      return reply({ ok: true, ...snapshot });
    }
    if (url.pathname.startsWith('/data/')) return reply({ ok: true, agents: [], jobs: [], boards: [] });
    if (url.pathname.endsWith('/api/task_index')) return reply({ ok: true, result: [] });
    if (url.pathname.includes('/api/')) return reply({ ok: false, message: 'Fixture denies this operation' }, 400);
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  return { context, page };
}

export { output, base, owner, agentWallet, other, contracts, agent, errors, results, server, browser, fixture };

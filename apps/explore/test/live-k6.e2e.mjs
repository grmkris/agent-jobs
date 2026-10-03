import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createPublicClient, createWalletClient, http, isHex, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from 'viem/chains';

// LIVE-UI: hosted staging smoke and K6 harness. It deliberately defaults to read-only. The browser gets a real
// EIP-1193 provider whose signing happens in this Node process through a viem local account; the private key is read
// from the worktree .env.local and never enters page scripts, screenshots, logs or evidence. The hosted bundle's
// Privy root is replaced at the asset boundary with an injected-wallet bridge, while every board/indexer/API request
// remains on https://testnet.hireling.xyz and every chain read uses Monad testnet.
//
// Read-only preparation:
//   node test/live-k6.e2e.mjs /tmp/hireling-live-ui/read-only
// Sending requires all four explicit guards (coordinator GAS-FIX + staging release, and this harness' send switch):
//   LIVE_UI_SEND=1 LIVE_UI_ALLOW_SEND=1 GAS_FIX_CONFIRMED=1 STAGING_RELEASE_CONFIRMED=1 \
//     node test/live-k6.e2e.mjs /tmp/hireling-live-ui/k6
// No send mode is run by default, and this file never prints the key.

const origin = process.env.HIRELING_STAGING_ORIGIN ?? 'https://testnet.hireling.xyz';
const output = process.argv[2] ?? '/tmp/hireling-live-ui/read-only';
const mode = process.env.LIVE_UI_SEND === '1' ? 'send' : 'read';
const allowSend = mode === 'send' && process.env.LIVE_UI_ALLOW_SEND === '1' && process.env.GAS_FIX_CONFIRMED === '1' && process.env.STAGING_RELEASE_CONFIRMED === '1';
const allowSignatures = allowSend || process.env.LIVE_UI_ALLOW_SIGNATURES === '1';
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const envPath = `${repo}.env.local`;
const envStat = statSync(envPath);
assert.equal(envStat.mode & 0o777, 0o600, '.env.local must be mode 600');
const envText = readFileSync(envPath, 'utf8');
const privateKey = envText.match(/^UI_TESTNET_PRIVATE_KEY=(0x[0-9a-fA-F]{64})$/m)?.[1];
assert.ok(privateKey, 'UI_TESTNET_PRIVATE_KEY is missing from worktree .env.local');
const account = privateKeyToAccount(privateKey);
const rpcUrl = process.env.MONAD_TESTNET_RPC_URL ?? monadTestnet.rpcUrls.default.http[0];
const publicClient = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });
const walletClient = createWalletClient({ account, chain: monadTestnet, transport: http(rpcUrl) });
const results = [];
const errors = [];
const txs = [];
const blocked = [];
mkdirSync(output, { recursive: true });

const hexOr = (value) => typeof value === 'string' && isHex(value) ? value : toHex(value);
const asTx = (tx) => ({
  account,
  to: tx.to,
  data: tx.data,
  value: tx.value === undefined ? undefined : BigInt(tx.value),
  gas: tx.gas === undefined ? undefined : BigInt(tx.gas),
  gasPrice: tx.gasPrice === undefined ? undefined : BigInt(tx.gasPrice),
  maxFeePerGas: tx.maxFeePerGas === undefined ? undefined : BigInt(tx.maxFeePerGas),
  maxPriorityFeePerGas: tx.maxPriorityFeePerGas === undefined ? undefined : BigInt(tx.maxPriorityFeePerGas),
  nonce: tx.nonce === undefined ? undefined : Number(BigInt(tx.nonce)),
});
const signMessage = async (value) => {
  if (!allowSignatures) throw Object.assign(new Error('LIVE-UI read-only mode refuses signatures'), { code: 4100 });
  return account.signMessage({ message: typeof value === 'string' && value.startsWith('0x') ? { raw: value } : String(value) });
};
const request = async ({ method, params = [] }) => {
  if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [account.address];
  if (method === 'eth_chainId') return '0x279f';
  if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
  if (method === 'wallet_getPermissions') return [];
  if (method === 'wallet_requestPermissions') return [];
  if (method === 'personal_sign') return signMessage(params[0]);
  if (method === 'eth_sign') return signMessage(params[1]);
  if (method === 'eth_signTypedData_v4' || method === 'eth_signTypedData') {
    if (!allowSignatures) throw Object.assign(new Error('LIVE-UI read-only mode refuses signatures'), { code: 4100 });
    const typed = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1];
    const types = { ...typed.types };
    delete types.EIP712Domain;
    return account.signTypedData({ domain: typed.domain, types, primaryType: typed.primaryType, message: typed.message });
  }
  if (method === 'wallet_signAuthorization') {
    if (!allowSignatures) throw Object.assign(new Error('LIVE-UI read-only mode refuses signatures'), { code: 4100 });
    const input = params[0] ?? {};
    const signed = await account.signAuthorization({ account, contractAddress: input.contractAddress ?? input.address, chainId: Number(BigInt(input.chainId ?? '0x279f')), nonce: Number(BigInt(input.nonce ?? 0)), executor: 'self' });
    return { address: signed.address, chainId: hexOr(signed.chainId), nonce: hexOr(signed.nonce), r: signed.r, s: signed.s, yParity: hexOr(signed.yParity) };
  }
  if (method === 'eth_sendTransaction') {
    if (!allowSend) throw Object.assign(new Error('LIVE-UI read-only mode refuses transactions'), { code: 4100 });
    const hash = await walletClient.sendTransaction(asTx(params[0]));
    txs.push({ hash, from: account.address });
    return hash;
  }
  if (method === 'eth_sendRawTransaction' || method === 'wallet_sendCalls') throw Object.assign(new Error('LIVE-UI harness refuses raw/batched transactions'), { code: 4100 });
  return publicClient.request({ method, params });
};

const patchHostedBundle = (body) => {
  const originalM = 'function m_({children:e}){return(0,R.jsxs)(Te,{appId:Lf,config:{embeddedWallets:{ethereum:{createOnLogin:`all-users`}},defaultChain:p_,supportedChains:[p_]},children:[(0,R.jsx)(h_,{}),e]})}';
  const injectedM = 'function m_({children:e}){let{isConnected:t}=Vc(),{connectors:n,connect:r}=Wc();return(0,L.useEffect)(()=>{if(t||globalThis.ethereum===void 0)return;qf(globalThis.ethereum);let e=n.find(e=>e.id===`injected`);e!==void 0&&r({connector:e})},[t,n,r]),(0,R.jsx)(R.Fragment,{children:e})}';
  assert.ok(body.includes(originalM), 'hosted Privy root changed; refuse an unreviewed asset patch');
  let patched = body.replace(originalM, injectedM);
  const originalG = 'function g_(){return(0,R.jsx)(__,{})}';
  assert.ok(patched.includes(originalG), 'hosted Privy login boundary changed');
  patched = patched.replace(originalG, 'function g_(){return null}');
  const originalV = 'function v_(){let{authenticated:e,logout:t}=ke();return async()=>{e&&await t()}}';
  assert.ok(patched.includes(originalV), 'hosted Privy logout boundary changed');
  patched = patched.replace(originalV, 'function v_(){return async()=>{}}');
  const originalL = 'function lS({label:e,className:t}){let{ready:n,login:r}=ke();return(0,R.jsx)(q,{size:`lg`,disabled:!n,className:t,onClick:()=>r(),children:e})}';
  assert.ok(patched.includes(originalL), 'hosted Privy publish-login boundary changed');
  patched = patched.replace(originalL, 'function lS({label:e,className:t}){return(0,R.jsx)(q,{size:`lg`,disabled:!0,className:t,children:e})}');
  const cStart = patched.indexOf('function C_(e){');
  const cEnd = patched.indexOf('var w_=', cStart);
  assert.ok(cStart >= 0 && cEnd > cStart, 'hosted Privy delegator boundary changed');
  patched = `${patched.slice(0, cStart)}function C_(e){return null}${patched.slice(cEnd)}`;
  return patched;
};

const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/home/kristjan/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
await context.exposeFunction('__liveWalletRequest', request);
await context.addInitScript(() => {
  const listeners = new Map();
  window.ethereum = {
    isMetaMask: false,
    request: (args) => window.__liveWalletRequest(args),
    on: (name, fn) => { listeners.set(name, fn); },
    removeListener: (name) => { listeners.delete(name); },
  };
});
await context.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  if (url.origin === new URL(rpcUrl).origin) return route.continue();
  if (url.origin !== origin) {
    blocked.push(url.origin);
    return route.abort('blockedbyclient');
  }
  if (url.pathname.endsWith('.js') && url.pathname.includes('/assets/')) {
    const response = await route.fetch();
    const body = await response.text();
    if (!body.includes('function m_(') || !body.includes('embeddedWallets:{ethereum:{createOnLogin:`all-users`')) return route.fulfill({ response, body });
    const patched = patchHostedBundle(body);
    const headers = { ...response.headers() };
    delete headers['content-length'];
    return route.fulfill({ response, headers, body: patched });
  }
  return route.continue();
});
const page = await context.newPage();
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });

const release = await (await fetch(`${origin}/release.json`, { signal: AbortSignal.timeout(20_000) })).json();
assert.deepEqual(release, { network: 'monad-testnet', mainnetLive: false, writesOpen: true });
assert.equal(await publicClient.getChainId(), 10143);
const jobs = await (await fetch(`${origin}/data/jobs`, { signal: AbortSignal.timeout(20_000) })).json();
assert.equal(jobs.ok, true);
const liveJob = jobs.jobs.find((job) => job.kind === 'hireling-v1');
const pages = [
  ['/stake', /Stake|Your fee as a worker/],
  ['/publish', /Post|Direct hire|Request quotes/],
  ['/collect', /Collect|Nothing to collect|cannot be read/],
  ['/sponsorship', /Gas sponsorship|Sign in/],
  [liveJob === undefined ? '/job/65' : `/job/${liveJob.job_id}`, /Job #|not indexed|unavailable/],
];
for (const [path, text] of pages) {
  await page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded' });
  await page.getByText(text).first().waitFor({ timeout: 60_000 });
  await page.screenshot({ path: `${output.replace(/\/$/, '')}-${path.replaceAll('/', '_') || 'home'}.png`, fullPage: true });
  results.push({ path, live: true, mode, account: account.address });
}
assert.deepEqual(errors, [], `hosted staging page errors: ${errors.join('; ')}`);
assert.deepEqual(blocked, [], `unexpected cross-origin requests: ${[...new Set(blocked)].join(', ')}`);
assert.deepEqual(txs, [], 'read-only preparation sent a transaction');
await browser.close();
console.log(`PASS: hosted staging ${mode} smoke; ${results.length} pages; no transactions; live v1 job ${liveJob?.job_id ?? 'not indexed'}`);

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { concat, encodeAbiParameters, encodeFunctionData, encodePacked, parseAbi } from 'viem';
import { createServer } from 'vite';
import { sponsorshipGrantTerms } from './grant-fixture.mjs';

// U7: the Telegram link page (board code, signed text naming the wallet, t.me deep link, waiting for the bot, unlink)
// and gas-sponsorship onboarding (the ERC-7710 delegation to the relay, read from its caveats before signing, refused
// when it reaches past Sidequest's contracts; turn off). Mocked Chromium only: no live board, bot, signing or sends.
const directory = fileURLToPath(new URL('.', import.meta.url));
const output = process.argv[2] ?? '/tmp/sidequest-onboarding-evidence';
const base = 'http://127.0.0.1:5199';
const me = '0x1111111111111111111111111111111111111111';
const config = JSON.parse(readFileSync(new URL('../../../contracts/config/monad-testnet.json', import.meta.url), 'utf8'));
const { relay } = config.roles;
const { manager, enforcers } = config.delegation;
const contracts = { factory: '0xf000000000000000000000000000000000000001', vault: '0xf000000000000000000000000000000000000002', feeSchedule: '0xf000000000000000000000000000000000000003', distributor: '0xf000000000000000000000000000000000000004', miningReserve: '0xf000000000000000000000000000000000000005', holding: '0xf000000000000000000000000000000000000006', evaluator: '0xf000000000000000000000000000000000000007', safe: '0xf000000000000000000000000000000000000008' };
const grantTerms = sponsorshipGrantTerms(contracts);
const NONCE = 'tg_fixture_123';
const textFor = (wallet) => `Link this wallet to Telegram on Sidequest.\nWallet: ${wallet}\nCode: ${NONCE}`;
const until = Math.floor(Date.now() / 1000) + 30 * 86400;

const delegation = (targets = grantTerms.targets) => JSON.stringify({
  types: { EIP712Domain: [], Delegation: [{ name: 'delegate', type: 'address' }, { name: 'delegator', type: 'address' }, { name: 'authority', type: 'bytes32' }, { name: 'caveats', type: 'Caveat[]' }, { name: 'salt', type: 'uint256' }], Caveat: [{ name: 'enforcer', type: 'address' }, { name: 'terms', type: 'bytes' }] },
  primaryType: 'Delegation',
  domain: { name: 'DelegationManager', version: '1', chainId: 10143, verifyingContract: manager },
  message: {
    delegate: relay,
    delegator: me,
    authority: `0x${'f'.repeat(64)}`,
    caveats: [
      { enforcer: enforcers.allowedTargets, terms: concat(targets) },
      { enforcer: enforcers.allowedMethods, terms: grantTerms.methods },
      { enforcer: enforcers.limitedCalls, terms: encodeAbiParameters([{ type: 'uint256' }], [50n]) },
      { enforcer: enforcers.timestamp, terms: encodePacked(['uint128', 'uint128'], [0n, BigInt(until)]) },
    ],
    salt: '7',
  },
});
const disable = { description: 'Disable the gas permission', chainId: 10143, to: manager, data: encodeFunctionData({ abi: parseAbi(['function disableDelegation(bytes32 delegationHash)']), functionName: 'disableDelegation', args: [`0x${'ab'.repeat(32)}`] }), value: '0' };
const results = [];
const errors = [];

process.env.PRIVY_APP_ID = 'fixture-privy-app-id';
const server = await createServer({ envFile: false, server: { host: '127.0.0.1', port: 5199, strictPort: true }, plugins: [{ name: 'onboarding-fixtures', enforce: 'pre', resolveId(source) {
  if (source === 'wagmi') return `${directory}onboarding-wagmi.mjs`;
  if (source === 'wagmi/actions') return `${directory}wagmi-actions.mjs`;
  if (source.endsWith('/Privy.tsx')) return `${directory}onboarding-privy.mjs`;
  if (source === '@privy-io/react-auth') return `${directory}privy-react-auth.mjs`;
}, transform(source, id) {
  if (id.endsWith('/src/sidequest.ts')) return source.replace(/export const sidequest: SidequestContracts =[\s\S]*?(\n\n|\n?$)/, 'export const sidequest: SidequestContracts = (window as { __sidequest: SidequestContracts }).__sidequest$1');
} }] });
await server.listen();
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/home/kristjan/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome' });
mkdirSync(output, { recursive: true });

async function fixture(viewport, options = {}) {
  const context = await browser.newContext({ viewport, hasTouch: viewport.width === 390, isMobile: viewport.width === 390 });
  await context.addInitScript(({ account, sidequest }) => {
    window.__sidequest = sidequest;
    window.__wallet = { address: account, connected: true, signatures: [], messages: [], sends: [], upgrades: 0 };
    localStorage.setItem('sidequest.session', 'fixture-only-not-a-real-session');
    localStorage.setItem('sidequest.session-owner', JSON.stringify({ address: account, expiresAt: Math.floor(Date.now() / 1000) + 86400 }));
  }, { account: me, sidequest: contracts });
  const state = {
    telegram: { linked: false, username: null, linkedAt: null },
    telegramDown: options.telegramDown ?? false,
    message: textFor(me),
    confirmed: [],
    sponsor: { status: 'none', typedData: null, callsUsed: 0 },
    sponsorDown: options.sponsorDown ?? false,
    prepared: delegation(),
    sponsorConfirmed: [],
  };
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort('blockedbyclient');
    const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const body = () => route.request().postDataJSON();
    const api = url.pathname.replace(/^.*\/api\//, '');
    if (url.pathname === '/__test/receipt') {
      // The on-chain disable is mined.
      state.sponsor = { ...state.sponsor, status: 'revoked' };
      return reply({ status: 'success' });
    }
    if (url.pathname.includes('/api/')) {
      switch (api) {
        case 'telegram_status':
          assert.deepEqual(body(), { wallet: me });
          return state.telegramDown ? reply({ ok: false, message: 'Fixture board unavailable' }, 503) : reply({ ok: true, result: state.telegram });
        case 'telegram_link_prepare':
          assert.deepEqual(body(), { wallet: me });
          return reply({ ok: true, result: { nonce: NONCE, message: state.message, expiresAt: Math.floor(Date.now() / 1000) + 600 } });
        case 'telegram_link_confirm':
          state.confirmed.push(body());
          return reply({ ok: true, result: { ok: true } });
        case 'telegram_unlink':
          assert.deepEqual(body(), { wallet: me });
          state.telegram = { linked: false, username: null, linkedAt: null };
          return reply({ ok: true, result: { ok: true } });
        case 'sponsor_status':
          assert.deepEqual(body(), { wallet: me });
          return state.sponsorDown ? reply({ ok: false, message: 'Fixture board unavailable' }, 503) : reply({ ok: true, result: state.sponsor });
        case 'sponsor_prepare':
          assert.deepEqual(body(), { wallet: me });
          return reply({ ok: true, result: { sign: { typedData: state.prepared }, upgrade: { delegator: config.delegation.delegator } } });
        case 'sponsor_confirm':
          state.sponsorConfirmed.push(body());
          state.sponsor = { status: 'live', typedData: state.prepared, callsUsed: 0 };
          return reply({ ok: true, result: state.sponsor });
        case 'sponsor_revoke':
          assert.deepEqual(body(), { wallet: me });
          return reply({ ok: true, result: { transactions: [disable] } });
        case 'task_index':
          return reply({ ok: true, result: [] });
        default:
          return reply({ ok: false, message: 'Fixture denies this operation' }, 400);
      }
    }
    if (url.pathname === '/data/jobs') return reply({ ok: true, jobs: [], index: { next_block: 100, updated_at: Math.floor(Date.now() / 1000) } });
    if (url.pathname === '/data/stats') return reply({ ok: true, jobs: 0, completed: 0, agents: 0, activity: { demo: 0, unclassified: 0, independent: null }, accounting: {} });
    if (url.pathname.startsWith('/data/')) return reply({ ok: true, agents: [], jobs: [], boards: [] });
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
const wallet = (page) => page.evaluate(() => ({ messages: window.__wallet.messages, signatures: window.__wallet.signatures, sends: window.__wallet.sends.length, upgrades: window.__wallet.upgrades }));

try {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    const device = viewport.width === 390 ? 'mobile' : 'desktop';

    // Telegram: from Me, link with a signed text, open the bot, survive a reload, then the bot links the chat.
    {
      const { context, page, state } = await fixture(viewport);
      await page.goto(`${base}/account`);
      await page.getByRole('link', { name: /Telegram/ }).click();
      await page.waitForURL('**/telegram');
      await page.getByRole('button', { name: 'Link Telegram' }).click();
      const sheet = page.getByRole('dialog', { name: 'Sign to link Telegram?' });
      await sheet.getByText(`Code: ${NONCE}`, { exact: false }).waitFor();
      await capture(page, `${device}-telegram-sign`);
      // An embedded wallet's in-page prompt must stay pressable while the sheet waits for it.
      await page.evaluate(() => { window.__wallet.signPrompt = true; });
      await sheet.getByRole('button', { name: 'Sign', exact: true }).click();
      const prompt = page.getByRole('dialog', { name: 'Wallet signature fixture' });
      await prompt.waitFor();
      // Closing the review would not cancel the pending request, so nothing in the sheet dismisses it meanwhile.
      assert.equal(await sheet.getByRole('button', { name: 'Cancel', exact: true }).isDisabled(), true);
      assert.equal(await sheet.getByRole('button', { name: 'Close', exact: true }).isDisabled(), true);
      await page.keyboard.press('Escape');
      await sheet.getByRole('button', { name: 'Sign', exact: true }).waitFor();
      if (viewport.width < 640) {
        // A downward flick past the dismissal point springs back instead of hiding the pending review.
        // The fixture prompt may cover the grab handle; let the drag reach the sheet.
        await prompt.evaluate((el) => { el.style.pointerEvents = 'none'; });
        const handle = await sheet.locator('.cursor-grab').boundingBox();
        await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
        await page.mouse.down();
        await page.mouse.move(handle.x + handle.width / 2, handle.y + 600, { steps: 8 });
        assert.match(await sheet.locator('.cursor-grab').evaluate((el) => el.parentElement.style.transform), /translateY\(\d/);
        await page.mouse.up();
        await page.waitForFunction(() => [...document.querySelectorAll('dialog[open] > div')].every((d) => d.style.transform === ''), null, { timeout: 5000 });
        await prompt.evaluate((el) => { el.style.pointerEvents = ''; });
        await sheet.getByRole('button', { name: 'Sign', exact: true }).waitFor();
      }
      await prompt.getByRole('button', { name: 'Sign fixture' }).click({ timeout: 5000 });
      await page.evaluate(() => { window.__wallet.signPrompt = false; });
      const open = page.getByRole('link', { name: 'Open @sidequest_xyz_bot' });
      await open.waitFor();
      assert.equal(await open.getAttribute('href'), `https://t.me/sidequest_xyz_bot?start=${NONCE}`);
      assert.equal(await open.getAttribute('target'), '_blank');
      assert.deepEqual((await wallet(page)).messages, [textFor(me)]);
      assert.deepEqual(state.confirmed, [{ nonce: NONCE, signature: `0x${'33'.repeat(65)}` }]);
      await page.getByText(/Waiting for Telegram/).waitFor();
      await capture(page, `${device}-telegram-waiting`);
      await page.reload();
      await open.waitFor();

      state.telegram = { linked: true, username: 'kris_fixture', linkedAt: Math.floor(Date.now() / 1000) };
      await page.getByRole('status').filter({ hasText: 'Telegram linked' }).waitFor({ timeout: 10_000 });
      await page.getByText('@kris_fixture', { exact: true }).waitFor();
      assert.equal(await open.count(), 0);
      await capture(page, `${device}-telegram-linked`);
      await page.goto(`${base}/account`);
      await page.getByRole('link', { name: /Telegram/ }).getByText('Linked', { exact: true }).waitFor();

      await page.goto(`${base}/telegram`);
      await page.getByRole('button', { name: 'Unlink Telegram' }).click();
      await page.getByRole('dialog', { name: 'Unlink Telegram?' }).getByRole('button', { name: 'Unlink', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Telegram unlinked' }).waitFor();
      await page.getByRole('button', { name: 'Link Telegram' }).waitFor();

      // A text that does not name this wallet is refused before the wallet opens; a declined signature links nothing.
      state.message = `Link a wallet to Telegram on Sidequest.\nCode: ${NONCE}`;
      await page.getByRole('button', { name: 'Link Telegram' }).click();
      await page.getByText('The text to sign does not name your wallet. Nothing was signed.', { exact: true }).waitFor();
      state.message = textFor(me);
      await page.evaluate(() => { window.__wallet.declineSign = true; });
      await page.getByRole('button', { name: 'Link Telegram' }).click();
      await page.getByRole('dialog', { name: 'Sign to link Telegram?' }).getByRole('button', { name: 'Sign', exact: true }).click();
      await page.getByText('You declined to sign. Nothing was linked.', { exact: true }).waitFor();
      // The wallet record restarts with each page load: since the last one, only the declined request reached it.
      assert.deepEqual((await wallet(page)).messages, [textFor(me)]);
      assert.equal(state.confirmed.length, 1);
      results.push({ device, flow: 'telegram', checks: ['Me row', 'signed text names wallet and code', 't.me deep link with code', 'waits across reload', 'linked by the bot', 'Me badge', 'unlink', 'foreign text refused', 'decline links nothing'], passed: true });
      await context.close();
    }

    // Sponsorship: from Me, read the limits from the caveats, upgrade then sign, on; turn off on-chain.
    {
      const { context, page, state } = await fixture(viewport);
      await page.goto(`${base}/account`);
      await page.getByRole('link', { name: /Gas sponsorship/ }).click();
      await page.waitForURL('**/sponsorship');
      await page.getByRole('button', { name: 'Turn on' }).click();
      const sheet = page.getByRole('dialog', { name: 'Let Sidequest pay your gas?' });
      await sheet.getByText('Call Holding', { exact: true }).waitFor();
      await sheet.getByText('Call Stake vault', { exact: true }).waitFor();
      await sheet.getByText(grantTerms.methodNames, { exact: true }).waitFor();
      await sheet.getByText('50 calls', { exact: true }).waitFor();
      await sheet.getByText('First your wallet points at the delegation contract. The relay sends that for you.', { exact: true }).waitFor();
      await capture(page, `${device}-sponsor-sign`);
      await sheet.getByRole('button', { name: 'Sign the permission' }).click();
      await page.getByRole('status').filter({ hasText: 'Sidequest now pays your gas' }).waitFor();
      const signed = await wallet(page);
      assert.equal(signed.upgrades, 1);
      assert.equal(signed.signatures.length, 1);
      assert.equal(signed.signatures[0].primaryType, 'Delegation');
      assert.equal(signed.signatures[0].message.delegate.toLowerCase(), relay.toLowerCase());
      assert.deepEqual(state.sponsorConfirmed, [{ wallet: me, signature: `0x${'44'.repeat(65)}` }]);
      await page.getByText('0 of 50', { exact: true }).waitFor();
      await capture(page, `${device}-sponsor-on`);
      await page.goto(`${base}/account`);
      await page.getByRole('link', { name: /Gas sponsorship/ }).getByText('On', { exact: true }).waitFor();

      await page.goto(`${base}/sponsorship`);
      await page.getByRole('button', { name: 'Turn off' }).click();
      await page.getByRole('dialog', { name: 'Turn off gas sponsorship?' }).getByRole('button', { name: 'Turn off', exact: true }).click();
      await page.getByRole('button', { name: 'Confirm fixture' }).click();
      await page.getByRole('status').filter({ hasText: 'Gas sponsorship off' }).waitFor();
      await page.getByText('You turned it off. Turn it on again for a new one.', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.__wallet.sends.at(-1).to.toLowerCase()), manager.toLowerCase());

      // A permission that reaches past Sidequest's contracts is refused before the wallet opens.
      state.prepared = delegation([contracts.holding, config.deployment.rewardTokens[0]]);
      await page.getByRole('button', { name: 'Turn on' }).click();
      await page.getByText(/which is not a Sidequest contract\. Nothing was signed\./).waitFor();
      assert.equal(await page.getByRole('dialog', { name: 'Let Sidequest pay your gas?' }).count(), 0);
      assert.equal((await wallet(page)).signatures.length, 0);
      results.push({ device, flow: 'sponsorship', checks: ['Me row', 'limits read from caveats', 'upgrade then sign', 'delegate is the relay', 'on with calls used', 'Me badge', 'turn off sends disableDelegation', 'foreign target refused'], passed: true });
      await context.close();
    }
  }

  // Unavailable is not "off"; no v1 on the network says so.
  {
    const { context, page } = await fixture({ width: 390, height: 844 }, { telegramDown: true, sponsorDown: true });
    await page.goto(`${base}/telegram`);
    await page.getByText('Whether Telegram is linked cannot be read right now.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Link Telegram' }).count(), 0);
    await page.goto(`${base}/sponsorship`);
    await page.getByText('Whether Sidequest pays your gas cannot be read right now.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Turn on' }).count(), 0);
    await capture(page, 'sponsor-unavailable');
    await context.close();
    results.push({ checks: ['telegram unavailable is not unlinked', 'sponsorship unavailable is not off'], passed: true });
  }
  assert.deepEqual(errors, []);
  writeFileSync(`${output}/results.json`, JSON.stringify({ tier: 'mocked Chromium only; no live board, bot, signing or sends', results, errors }, null, 2));
  console.log(`PASS: onboarding, ${results.length} evidence records`);
} finally {
  await browser.close();
  await server.close();
}

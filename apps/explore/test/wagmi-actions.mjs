import { batchCalldata } from '@agent-jobs/sdk';

export async function waitForTransactionReceipt(_config, { hash }) {
  const response = await fetch(`/__test/receipt?hash=${hash}`);
  if (!response.ok) throw new Error('Receipt RPC unavailable');
  return response.json();
}

// A fixture chain built from the fixture wallet's sends: send k (0-based) is mined in block 101 + k with nonce k and
// the hash the wallet double returned. `window.__wallet.chainDown` makes every read fail like an unreachable RPC.
const BASE_BLOCK = 100n;
function chainReady() {
  if (window.__wallet.chainDown) throw new Error('Fixture RPC unavailable');
}
export async function getTransactionCount() {
  chainReady();
  return window.__wallet.sends.length;
}
export async function getBlockNumber() {
  chainReady();
  return BASE_BLOCK + BigInt(window.__wallet.sends.length);
}
export async function getBlock(_config, { blockNumber }) {
  chainReady();
  const index = Number(blockNumber - BASE_BLOCK) - 1;
  const sent = window.__wallet.sends[index];
  if (sent === undefined) return { number: blockNumber, transactions: [] };
  const from = window.__wallet.address;
  const call = Array.isArray(sent) ? { to: from, input: batchCalldata(sent.map((tx) => ({ ...tx, value: '0' }))) } : { to: sent.to, input: sent.data };
  return { number: blockNumber, transactions: [{ hash: `0x${(index + 1).toString(16).padStart(64, '0')}`, from, nonce: index, ...call }] };
}
// Contract code by address from `window.__bytecode`; undefined (no code) for any other address, as the RPC answers.
export async function getBytecode(_config, { address }) {
  chainReady();
  return window.__bytecode?.[address.toLowerCase()];
}

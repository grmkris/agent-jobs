import { coreAbi, epochDistributorAbi, feeScheduleAbi, miningReserveAbi, stakeVaultAbi, hirelingHoldingAbi, hirelingEvaluatorAbi } from '@agent-jobs/sdk';
import { useQuery } from '@tanstack/react-query';
import { decodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { MULTI_SEND_CALL_ONLY, safeAbi, unpackMultiSend } from '../src/safe.ts';
import { sendFixtureTransaction } from './wagmi.mjs';

export * from './wagmi.mjs';

// A fixture Safe and Hireling v1 in `window.__admin`: reads answer from it, and every call the wallet double sends
// (through the Safe's execTransaction, or direct) is decoded and applied, so the console shows the chain moving.
const ZERO = '0x0000000000000000000000000000000000000000';
const ZERO32 = `0x${'0'.repeat(64)}`;
const eq = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const key = (a) => a.toLowerCase();
function answer({ address, functionName, args = [] }) {
  const s = window.__admin;
  if (s.down) throw new Error('Fixture RPC unavailable');
  switch (functionName) {
    case 'getOwners': return s.owners;
    case 'getThreshold': return s.threshold;
    case 'owner': return s.owner[key(address)] ?? ZERO;
    case 'pendingOwner': return s.pendingOwner[key(address)] ?? ZERO;
    case 'paused': return s.paused;
    case 'pauseCount': return BigInt(s.pauses.length);
    case 'pauseAt': return s.pauses[Number(args[0])];
    case 'balanceOf': return 0n;
    case 'ADMIN_ROLE': return `0x${'a'.repeat(64)}`;
    case 'hasRole': return s.safeIsAdmin;
    case 'schedule': return s.schedule;
    case 'pending': return s.pending === null ? [{ thresholds: [0n, 0n, 0n, 0n], bps: [0, 0, 0, 0], treasury: ZERO }, 0] : [s.pending.schedule, s.pending.eta];
    case 'DELAY': return 259200;
    case 'PROPOSAL_GRACE': return 604800;
    case 'MAX_BPS': return 3000;
    case 'bootstrapped': return s.bootstrapped;
    case 'pendingHolding': return s.pendingHolding === null ? [ZERO, 0] : [s.pendingHolding.holding, s.pendingHolding.eta];
    case 'HOLDING_DELAY': return 691200;
    case 'isHolding': return s.holdings.some((h) => eq(h, args[0]));
    case 'currentEpoch': return s.currentEpoch;
    case 'totalFunded': return s.totalFunded;
    case 'available': return s.available;
    case 'outstanding': return 0n;
    case 'budget': return 10n ** 24n;
    case 'cumulativeBudget': return (args[0] + 1n) * 10n ** 24n;
    case 'epochEnd': return BigInt(s.genesis + (Number(args[0]) + 1) * 604800);
    case 'rootOf': return s.roots[String(args[0])] ?? { root: ZERO32, total: 0n, claimed: 0n, dataHash: ZERO32 };
    default: throw new Error(`Fixture has no read for ${functionName}`);
  }
}
const show = (value) => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
// A token's decimals answer per call, as wagmi's allowFailure does: an address with none fails alone.
const read = (c) => {
  if (c.functionName !== 'decimals') return { status: 'success', result: answer(c) };
  if (window.__admin.down) throw new Error('Fixture RPC unavailable');
  const decimals = window.__admin.decimals[key(c.address)];
  return decimals === undefined ? { status: 'failure', error: new Error('Fixture: no decimals') } : { status: 'success', result: decimals };
};
export const useReadContracts = ({ contracts, query }) => useQuery({
  queryKey: ['fixture-admin', show(contracts.map(({ address, functionName, args }) => [address, functionName, args]))],
  queryFn: async () => contracts.map(read),
  retry: false,
  ...query,
});

const ABIS = [coreAbi, feeScheduleAbi, stakeVaultAbi, hirelingHoldingAbi, hirelingEvaluatorAbi, miningReserveAbi, epochDistributorAbi];
function decode(data) {
  for (const abi of ABIS) {
    try { return decodeFunctionData({ abi, data }); } catch { /* not this contract */ }
  }
  throw new Error('Fixture cannot decode the call');
}
function apply({ to, data }) {
  const s = window.__admin;
  if (!eq(to, s.safe)) return applyCall('direct', to, data, null);
  const { args } = decodeFunctionData({ abi: safeAbi, data });
  const [innerTo, , innerData, operation, , , , , , signatures] = args;
  if (operation === 0) return applyCall('safe', innerTo, innerData, signatures);
  // operation 1: the Safe delegatecalls MultiSendCallOnly, which makes each packed call in order, all in this one send.
  if (!eq(innerTo, MULTI_SEND_CALL_ONLY)) throw new Error('Fixture Safe: delegatecall to an unknown contract');
  for (const call of unpackMultiSend(innerData)) applyCall('atomic', call.to, call.data, signatures);
}
function applyCall(via, to, data, signatures) {
  const s = window.__admin;
  const inner = { to, data, signatures };
  const { functionName, args = [] } = decode(inner.data);
  s.calls.push({ via, to: inner.to, functionName, signatures: inner.signatures ?? null });
  const now = Math.floor(Date.now() / 1000);
  if (functionName === 'acceptOwnership') { s.owner[key(inner.to)] = s.safe; s.pendingOwner[key(inner.to)] = ZERO; }
  if (functionName === 'pause') s.paused = true;
  if (functionName === 'unpause') s.paused = false;
  // The Evaluator's pause history (D4b, C9-007): notePause opens an interval while the core is paused and closes the
  // open one once it runs again.
  if (functionName === 'notePause') {
    const open = s.pauses.at(-1)?.end === 0;
    if (s.paused && !open) s.pauses.push({ start: now, end: 0 });
    if (!s.paused && open) s.pauses.at(-1).end = now;
  }
  if (functionName === 'propose') s.pending = { schedule: args[0], eta: now + 259200 };
  if (functionName === 'cancel') s.pending = null;
  if (functionName === 'execute') { s.schedule = s.pending.schedule; s.pending = null; }
  if (functionName === 'proposeHolding') s.pendingHolding = { holding: args[0], eta: now + 691200 };
  if (functionName === 'cancelHoldingProposal') s.pendingHolding = null;
  if (functionName === 'acceptHolding') { s.holdings.push(s.pendingHolding.holding); s.pendingHolding = null; }
  if (functionName === 'revokeHolding') s.holdings = s.holdings.filter((h) => !eq(h, args[0]));
  if (functionName === 'setRoot') s.roots[String(args[0])] = { root: args[1], total: args[2], claimed: 0n, dataHash: args[3] };
  if (functionName === 'fund') { s.totalFunded += args[1]; s.available += args[1]; }
  if (functionName === 'resizeRoot') s.roots[String(args[0])] = { ...s.roots[String(args[0])], total: args[1] };
}
export const useSendTransaction = () => ({ sendTransactionAsync: async (transaction) => {
  const hash = await sendFixtureTransaction(transaction);
  apply(transaction);
  return hash;
} });

// EIP-712 signing (the epoch price list): `window.__admin.signWith` picks the key. Public anvil test keys only, never
// real ones: #0 is the fixture owner's, #1 stands in for a wallet whose signature does not recover to the owner.
const KEYS = { owner: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', other: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' };
export const useSignTypedData = () => ({ signTypedDataAsync: async (typed) => {
  const s = window.__admin;
  if (s.signWith === 'decline') throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
  const { account: _account, ...data } = typed;
  return privateKeyToAccount(KEYS[s.signWith]).signTypedData(data);
} });

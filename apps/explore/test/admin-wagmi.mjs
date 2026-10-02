import { coreAbi, epochDistributorAbi, feeScheduleAbi, miningReserveAbi, stakeVaultAbi, hirelingHoldingAbi, hirelingEvaluatorAbi } from '@agent-jobs/sdk';
import { useQuery } from '@tanstack/react-query';
import { decodeFunctionData } from 'viem';
import { safeAbi } from '../src/safe.ts';
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
export const useReadContracts = ({ contracts, query }) => useQuery({
  queryKey: ['fixture-admin', show(contracts.map(({ address, functionName, args }) => [address, functionName, args]))],
  queryFn: async () => contracts.map((c) => ({ status: 'success', result: answer(c) })),
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
  const viaSafe = eq(to, s.safe);
  const inner = viaSafe ? (() => { const { args } = decodeFunctionData({ abi: safeAbi, data }); return { to: args[0], data: args[2], signatures: args[9] }; })() : { to, data };
  const { functionName, args = [] } = decode(inner.data);
  s.calls.push({ via: viaSafe ? 'safe' : 'direct', to: inner.to, functionName, signatures: inner.signatures ?? null });
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

import { stakeVaultAbi } from '@agent-jobs/sdk';
import { useQuery } from '@tanstack/react-query';
import { decodeFunctionData } from 'viem';
import { sendFixtureTransaction } from './wagmi.mjs';

export * from './wagmi.mjs';

// A fixture stake vault, fee schedule and FACTORY v2 in `window.__stake`: reads answer from it, and every vault call
// the wallet double sends is decoded and applied to it, so the page shows the chain moving. Nothing reaches a chain.
const K = 10n ** 21n;
const schedule = { thresholds: [0n, 10n * K, 100n * K, 1000n * K], bps: [3000, 1000, 300, 100], treasury: '0x9999999999999999999999999999999999999999' };
function answer({ functionName, address, args = [] }) {
  const s = window.__stake;
  switch (functionName) {
    case 'stakeOf': return s.staked;
    case 'reservedOf': return s.reserved;
    case 'availableOf': return s.staked - s.reserved;
    case 'unstakeOf': return [s.unstaking, s.unlockAt];
    case 'UNSTAKE_DELAY': return 604800;
    case 'schedule': return schedule;
    case 'pending': return [{ thresholds: [0n, 0n, 0n, 0n], bps: [0, 0, 0, 0], treasury: '0x0000000000000000000000000000000000000000' }, 0];
    case 'balanceOf': return s.wallet;
    case 'nonces': return s.nonce;
    case 'eip712Domain': return ['0x0f', 'Factory', '1', 10143n, address, `0x${'0'.repeat(64)}`, []];
    case 'bootstrapped': return s.open;
    case 'paused': return false;
    case 'PROPOSAL_GRACE': return 604800;
    case 'pendingHolding': return s.proposal === undefined ? ['0x0000000000000000000000000000000000000000', 0] : [s.proposal.holding, s.proposal.eta];
    case 'holdingDenied': return (s.denied ?? {})[args[1].toLowerCase()] === true;
    default: throw new Error(`Fixture has no read for ${functionName}`);
  }
}
export const useReadContracts = ({ contracts, query }) => useQuery({
  queryKey: ['fixture-stake', contracts.map((c) => c.functionName).join()],
  queryFn: async () => {
    if (window.__stake.down) throw new Error('Fixture RPC unavailable');
    return contracts.map((c) => ({ status: 'success', result: answer(c) }));
  },
  ...query,
});

export const useSignTypedData = () => ({ signTypedDataAsync: async (typedData) => {
  window.__wallet.signatures.push(typedData);
  if (window.__wallet.declineSign) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
  return `0x${'11'.repeat(32)}${'22'.repeat(32)}1b`;
} });

function apply({ data }) {
  const s = window.__stake;
  const { functionName, args } = decodeFunctionData({ abi: stakeVaultAbi, data });
  s.calls.push(functionName);
  if (functionName === 'stakeWithPermit') { s.wallet -= args[0]; s.staked += args[0]; s.nonce += 1n; }
  if (functionName === 'requestUnstake') { s.staked -= args[0]; s.unstaking += args[0]; s.unlockAt = Math.floor(Date.now() / 1000) + 604800; }
  if (functionName === 'cancelUnstake') { s.staked += s.unstaking; s.unstaking = 0n; s.unlockAt = 0; }
  if (functionName === 'withdraw') { s.wallet += s.unstaking; s.unstaking = 0n; s.unlockAt = 0; }
  if (functionName === 'setHoldingDenied') s.denied = { ...s.denied, [args[0].toLowerCase()]: args[1] };
}
export const useSendTransaction = () => ({ sendTransactionAsync: async (transaction) => {
  const hash = await sendFixtureTransaction(transaction);
  apply(transaction);
  return hash;
} });

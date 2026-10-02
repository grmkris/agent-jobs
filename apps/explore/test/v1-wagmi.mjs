import { hirelingHoldingAbi } from '@agent-jobs/sdk';
import { useQuery } from '@tanstack/react-query';
import { decodeFunctionData } from 'viem';
import { sendFixtureTransaction, useReadContract as useFixtureReadContract, useReadContracts as useFixtureReadContracts } from './wagmi.mjs';

export * from './wagmi.mjs';

// Hireling v1 reads on top of the UX wallet double, from `window.__v1`: the Holding's window bounds and default
// arbitrator, the vault's free stake for the creator bond, the fee quote and top-ups. Nothing reaches a chain.
const H = 3600;
const V1_READS = {
  MIN_REVIEW_WINDOW: () => H, MAX_REVIEW_WINDOW: () => 14 * 86400,
  MIN_DISPUTE_WINDOW: () => H, MAX_DISPUTE_WINDOW: () => 14 * 86400,
  MIN_ARBITRATION_WINDOW: () => 12 * H, MAX_ARBITRATION_WINDOW: () => 14 * 86400,
  defaultArbitrator: () => window.__v1.arbiter,
  quoteActivation: () => window.__v1.quote,
  topUpOf: () => window.__v1.topUp,
  getListing: () => ({ bonus: window.__v1.bonus }),
  allowance: () => 0n,
};
export const useReadContracts = (options) => {
  const v1 = options.contracts.every((c) => V1_READS[c.functionName] !== undefined);
  const reads = useQuery({
    queryKey: ['fixture-v1', JSON.stringify(options.contracts.map((c) => [c.address, c.functionName, c.args]), (_k, v) => (typeof v === 'bigint' ? v.toString() : v))],
    queryFn: async () => options.contracts.map((c) => ({ status: 'success', result: V1_READS[c.functionName](c) })),
    enabled: v1 && options.query?.enabled !== false,
  });
  const fallback = useFixtureReadContracts(v1 ? { ...options, query: { ...options.query, enabled: false } } : options);
  return v1 ? reads : fallback;
};
export const useReadContract = (options) => {
  const read = useFixtureReadContract(options);
  if (options.functionName === 'availableOf') return { data: window.__v1.free, isLoading: false, isError: false };
  return read;
};
// A top-up the wallet double sends is applied to the fixture listing, so the page shows the bonus grow.
export const useSendTransaction = () => ({ sendTransactionAsync: async (transaction) => {
  const hash = await sendFixtureTransaction(transaction);
  try {
    const { functionName, args } = decodeFunctionData({ abi: hirelingHoldingAbi, data: transaction.data });
    if (functionName === 'topUp') { window.__v1.bonus += args[1]; window.__v1.topUp += args[1]; }
  } catch { /* an approval, not a Holding call */ }
  return hash;
} });

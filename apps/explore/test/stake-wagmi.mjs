import { useQuery } from '@tanstack/react-query';
import { chainLatency, sendFixtureTransaction } from './wagmi.mjs';
import { answer, apply } from './stake-chain.mjs';
export * from './wagmi.mjs';

export const useReadContracts = ({ contracts, query }) => useQuery({
  queryKey: ['fixture-stake', contracts.map(c => c.functionName + ':' + c.args?.join()).join()],
  queryFn: async () => {
    await chainLatency();
    if (window.__stake.down) throw new Error('Fixture RPC unavailable');
    return contracts.map(c => window.__stake.unreadable?.includes(c.functionName)
      ? { status: 'failure', error: new Error('Fixture read unavailable') }
      : { status: 'success', result: answer(c) });
  },
  ...query,
});
export const useSignTypedData = () => ({ signTypedDataAsync: async typedData => {
  window.__wallet.signatures.push(typedData);
  if (window.__wallet.signGate) await new Promise(resolve => { window.__releasePermit = resolve; });
  if (window.__wallet.declineSign) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
  return `0x${'11'.repeat(32)}${'22'.repeat(32)}1b`;
} });
export const useSendTransaction = () => ({ sendTransactionAsync: async transaction => {
  const hash = await sendFixtureTransaction(transaction);
  apply(transaction);
  return hash;
} });

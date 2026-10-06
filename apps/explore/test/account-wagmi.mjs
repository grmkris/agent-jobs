import { useSyncExternalStore } from 'react';
import { useBalance as baseBalance, useReadContracts as baseContracts } from './wagmi.mjs';
export * from './wagmi.mjs';

const subscribe = (notify) => {
  window.addEventListener('fixture-balances-change', notify);
  return () => window.removeEventListener('fixture-balances-change', notify);
};
const state = () => window.__walletBalances;

export function useBalance(options) {
  const base = baseBalance(options);
  const current = useSyncExternalStore(subscribe, state);
  if (current === undefined) return base;
  return {
    data: current.native === null ? undefined : { value: BigInt(current.native) },
    isPending: current.loading,
    isError: !current.loading && current.native === null,
    isLoading: current.loading,
  };
}

export function useReadContracts(options) {
  const base = baseContracts(options);
  const current = useSyncExternalStore(subscribe, state);
  if (current === undefined || !options.contracts.every((contract) => contract.functionName === 'balanceOf')) return base;
  return {
    data: current.loading ? undefined : options.contracts.map(({ address }) => {
      const value = current.tokens[address.toLowerCase()];
      return value === undefined || value === null
        ? { status: 'failure', error: new Error('Fixture balance unavailable') }
        : { status: 'success', result: BigInt(value) };
    }),
    isPending: current.loading,
    isError: false,
    isLoading: current.loading,
  };
}

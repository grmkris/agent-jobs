import { useQuery } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';

export const fixtureAddress = '0x1111111111111111111111111111111111111111';
export const createConfig = () => ({});
export const http = () => ({});
export const custom = () => ({});
export const WagmiProvider = ({ children }) => children;
const subscribeAccount = (notify) => { window.addEventListener('fixture-wallet-change', notify); return () => window.removeEventListener('fixture-wallet-change', notify); };
export const useAccount = () => {
  const address = useSyncExternalStore(subscribeAccount, () => window.__wallet.connected === false ? undefined : window.__wallet.address);
  return { address, chainId: window.__wallet.chainId ?? 10143, isConnected: address !== undefined };
};
export const useDisconnect = () => ({ disconnect: () => {} });
export const useConnect = () => ({ connectors: [], connect: () => {} });
export const useSignMessage = () => ({ signMessageAsync: async () => {
  // Opt-in board sign-in double: a fixed fake signature the fixture API accepts; nothing is signed.
  if (window.__wallet.canSign) return `0x${'22'.repeat(65)}`;
  throw new Error('No real signing in UX fixtures');
} });
export const useSignTypedData = () => ({ signTypedDataAsync: async () => { throw new Error('No real signing in UX fixtures'); } });
export const useSwitchChain = () => ({ switchChainAsync: async () => {} });
/**
 * Chain reads that arrive late, for the layout-shift audit (shots.mjs --audit): `window.__chainLatency` ms before every
 * fixture read answers. Off (0) everywhere else, where the synchronous answers below are kept.
 */
const late = () => (window.__chainLatency ?? 0) > 0;
export const chainLatency = () => (late() ? new Promise((resolve) => setTimeout(resolve, window.__chainLatency)) : undefined);
// Every balance and amount read answers 10^24 unless the page sets a realistic one (shots.mjs): `window.__balances`,
// by function name, with `native` for the MON balance.
const balance = (name) => window.__balances?.[name] ?? 10n ** 24n;
export const useBalance = () => {
  const query = useQuery({ queryKey: ['fixture-balance'], queryFn: async () => { await chainLatency(); return { value: balance('native') }; }, enabled: late() });
  return late() ? query : { data: { value: balance('native') }, isLoading: false };
};
export const useReadContract = ({ functionName }) => {
  const query = useQuery({ queryKey: ['fixture-read', functionName], queryFn: async () => { await chainLatency(); return functionName === 'paused' ? false : balance(functionName); }, enabled: late() });
  return late() ? query : { data: functionName === 'paused' ? false : balance(functionName), isLoading: false };
};
export const useReadContracts = ({ contracts, query }) => useQuery({ queryKey: ['fixture-token', contracts[0]?.address], queryFn: async () => {
  await chainLatency();
  const response = await fetch(`/__test/token?address=${contracts[0]?.address}`);
  if (!response.ok) throw new Error('Token metadata unavailable');
  const metadata = await response.json();
  // Token metadata only: any other read (a Safe's getOwners on /me, say) fails alone, as it would without a fixture.
  return contracts.map(({ functionName }) => (functionName === 'symbol' || functionName === 'decimals' ? { status: 'success', result: metadata[functionName] } : { status: 'failure', error: new Error(`No fixture read for ${functionName}`) }));
}, ...query });

export function sendFixtureTransaction(transaction) {
  return new Promise((resolve, reject) => {
    const panel = document.createElement('div');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Wallet confirmation fixture');
    panel.style.cssText = 'position:fixed;inset:30% 12%;z-index:100000;background:white;color:black;border:3px solid #007aff;border-radius:16px;padding:24px';
    const heading = document.createElement('h2');
    heading.textContent = 'Wallet confirmation — test double, no signing';
    panel.append(heading);
    for (const action of ['Confirm fixture', 'Decline fixture']) {
      const button = document.createElement('button');
      button.textContent = action;
      button.style.cssText = 'min-width:44px;min-height:44px;margin:8px';
      button.addEventListener('click', () => {
        panel.remove();
        if (action === 'Decline fixture') return reject(Object.assign(new Error('User rejected the request.'), { code: 4001 }));
        // The wallet failed before broadcasting: an error that is not a refusal, and nothing went out.
        if (window.__wallet.dropped) return reject(new Error('Wallet transport failed before broadcast'));
        window.__wallet.sends.push(transaction);
        localStorage.setItem('fixture-wallet-sends', JSON.stringify(window.__wallet.sends, (_key, value) => typeof value === 'bigint' ? value.toString() : value));
        if (window.__wallet.ambiguous) return reject(new Error('Transport failed after broadcast'));
        resolve(`0x${window.__wallet.sends.length.toString(16).padStart(64, '0')}`);
      });
      panel.append(button);
    }
    document.body.append(panel);
  });
}
export const useSendTransaction = () => ({ sendTransactionAsync: sendFixtureTransaction });

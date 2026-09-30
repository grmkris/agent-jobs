import { useQuery } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';

export const fixtureAddress = '0x1111111111111111111111111111111111111111';
export const createConfig = () => ({});
export const http = () => ({});
export const WagmiProvider = ({ children }) => children;
const subscribeAccount = (notify) => { window.addEventListener('fixture-wallet-change', notify); return () => window.removeEventListener('fixture-wallet-change', notify); };
export const useAccount = () => {
  const address = useSyncExternalStore(subscribeAccount, () => window.__wallet.connected === false ? undefined : window.__wallet.address);
  return { address, chainId: 10143, isConnected: address !== undefined };
};
export const useDisconnect = () => ({ disconnect: () => {} });
export const useConnect = () => ({ connectors: [], connect: () => {} });
export const useSignMessage = () => ({ signMessageAsync: async () => { throw new Error('No real signing in UX fixtures'); } });
export const useSignTypedData = () => ({ signTypedDataAsync: async () => { throw new Error('No real signing in UX fixtures'); } });
export const useSwitchChain = () => ({ switchChainAsync: async () => {} });
export const useBalance = () => ({ data: { value: 10n ** 24n }, isLoading: false });
export const useReadContract = ({ functionName }) => ({ data: functionName === 'paused' ? false : 10n ** 24n, isLoading: false });
export const useReadContracts = ({ contracts, query }) => useQuery({ queryKey: ['fixture-token', contracts[0]?.address], queryFn: async () => {
  const response = await fetch(`/__test/token?address=${contracts[0]?.address}`);
  if (!response.ok) throw new Error('Token metadata unavailable');
  const metadata = await response.json();
  return contracts.map(({ functionName }) => ({ status: 'success', result: functionName === 'symbol' ? metadata.symbol : metadata.decimals }));
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

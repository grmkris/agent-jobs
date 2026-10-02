import { Fragment, createElement, useEffect } from 'react';
import { useAccount, useConnect } from 'wagmi';
import { setPrivyProvider } from '../../src/wallet.ts';

// U-REAL: Privy's embedded wallet replaced by the page's injected dev-key wallet (`window.ethereum`, set up by
// real.e2e.mjs), which forwards every request to the anvil fork, where anvil holds the public dev keys. It reaches wagmi
// the way Privy's provider does: through `setPrivyProvider` and the `privy` connector, so the launch gate, the connector
// and every hook are Explore's own. No 7702 batching: steps go one transaction at a time, as from an external wallet.
function DevWalletBridge() {
  const { isConnected } = useAccount();
  const { connectors, connect } = useConnect();
  useEffect(() => {
    if (isConnected || window.ethereum === undefined) return;
    setPrivyProvider(window.ethereum);
    const connector = connectors.find((c) => c.id === 'privy');
    if (connector !== undefined) connect({ connector });
  }, [isConnected, connectors, connect]);
  return null;
}

export const PrivyRoot = ({ children }) => createElement(Fragment, null, createElement(DevWalletBridge), children);
export const PrivyLogin = () => null;
export const usePrivyLogout = () => async () => {};
export const useDelegatorUpgrade = () => null;
export const usePrivyBatch = () => null;

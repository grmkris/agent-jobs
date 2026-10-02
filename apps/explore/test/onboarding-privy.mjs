export * from './privy.mjs';

// The embedded wallet's DeleGator upgrade, counted: the relay would send it; here nothing is sent.
export const useDelegatorUpgrade = () => async () => {
  window.__wallet.upgrades += 1;
  return null;
};

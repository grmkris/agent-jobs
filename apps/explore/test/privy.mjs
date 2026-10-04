import { sendFixtureTransaction } from './wagmi.mjs';

export const PrivyRoot = ({ children }) => children;
export const PrivyLogin = () => null;
export const useAgentWallets = () => null;
export const usePrivyLogout = () => async () => {};
export const useDelegatorUpgrade = () => null;
export const usePrivyBatch = () => window.__wallet.batch ? sendFixtureTransaction : null;

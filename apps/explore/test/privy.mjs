import { sendFixtureTransaction } from './wagmi.mjs';

export const PrivyRoot = ({ children }) => children;
export const PrivyLogin = () => null;
export const usePrivyLogout = () => async () => {};
export const usePrivyModalOpen = () => false;
export const useDelegatorUpgrade = () => null;
export const usePrivyBatch = () => window.__wallet.batch ? sendFixtureTransaction : null;

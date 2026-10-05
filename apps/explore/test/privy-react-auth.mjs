// Test double for '@privy-io/react-auth' where the app imports it directly: Privy's login is counted, never opened.
export const usePrivy = () => ({ ready: true, authenticated: false, getAccessToken: async () => 'fixture-only-not-a-real-privy-token', login: () => { window.__privyLogins = (window.__privyLogins ?? 0) + 1; } });
export const useSignTypedData = () => ({ signTypedData: async () => { throw new Error('No real Privy signing in mocked browser fixtures'); } });
export const useSigners = () => ({ addSigners: async () => { throw new Error('No real Privy signer changes in mocked browser fixtures'); }, removeSigners: async () => { throw new Error('No real Privy signer changes in mocked browser fixtures'); } });

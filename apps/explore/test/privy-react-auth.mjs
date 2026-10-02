// Test double for '@privy-io/react-auth' where the app imports it directly: Privy's login is counted, never opened.
export const usePrivy = () => ({ ready: true, authenticated: false, login: () => { window.__privyLogins = (window.__privyLogins ?? 0) + 1; } });

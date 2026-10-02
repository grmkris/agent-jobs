export * from './wagmi.mjs';

// Signing doubles for the Telegram link and the sponsorship delegation: each request is recorded in `window.__wallet`
// so the test can check exactly what was put in front of the wallet. Nothing is signed.
export const useSignMessage = () => ({ signMessageAsync: async ({ message }) => {
  window.__wallet.messages.push(message);
  if (window.__wallet.declineSign) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
  return `0x${'33'.repeat(65)}`;
} });
export const useSignTypedData = () => ({ signTypedDataAsync: async (typedData) => {
  window.__wallet.signatures.push(JSON.parse(JSON.stringify(typedData, (_key, value) => typeof value === 'bigint' ? value.toString() : value)));
  if (window.__wallet.declineSign) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
  return `0x${'44'.repeat(65)}`;
} });

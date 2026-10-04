export * from './wagmi.mjs';

// Signing doubles for the Telegram link and the sponsorship delegation: each request is recorded in `window.__wallet`
// so the test can check exactly what was put in front of the wallet. Nothing is signed.
// With `window.__wallet.signPrompt`, the request waits for a click on an in-page prompt, as Privy's embedded wallet
// draws one: an ordinary fixed element in the page, not in the top layer.
const signPrompt = () => !window.__wallet.signPrompt ? Promise.resolve() : new Promise((resolve) => {
  const panel = document.createElement('div');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Wallet signature fixture');
  panel.style.cssText = 'position:fixed;inset:30% 12%;z-index:100000;background:white;color:black;border:3px solid #007aff;border-radius:16px;padding:24px';
  const button = document.createElement('button');
  button.textContent = 'Sign fixture';
  button.style.cssText = 'min-width:44px;min-height:44px';
  button.addEventListener('click', () => { panel.remove(); resolve(); });
  panel.append(button);
  document.body.append(panel);
});
export const useSignMessage = () => ({ signMessageAsync: async ({ message }) => {
  window.__wallet.messages.push(message);
  await signPrompt();
  if (window.__wallet.declineSign) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
  return `0x${'33'.repeat(65)}`;
} });
export const useSignTypedData = () => ({ signTypedDataAsync: async (typedData) => {
  window.__wallet.signatures.push(JSON.parse(JSON.stringify(typedData, (_key, value) => typeof value === 'bigint' ? value.toString() : value)));
  if (window.__wallet.declineSign) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
  return `0x${'44'.repeat(65)}`;
} });

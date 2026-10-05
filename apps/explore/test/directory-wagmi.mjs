import { fixtureAddress, useReadContracts as useFixtureReadContracts } from './v1-wagmi.mjs';

export * from './v1-wagmi.mjs';

export const useReadContracts = (options) => {
  const reads = useFixtureReadContracts(options);
  if (options.contracts[0]?.functionName !== 'ownerOf') return reads;
  return { data: options.contracts.map(({ functionName }) => ({ status: 'success', result: functionName === 'tokenURI' ? '' : fixtureAddress })), isLoading: false };
};

export const useSignTypedData = () => ({ signTypedDataAsync: async (typedData) => {
  if (document.querySelector('dialog[open]')) throw new Error('Onboarding sheet still blocks wallet');
  window.__wallet.signatures.push(typedData.primaryType);
  if (window.__wallet.decline) {
    window.__wallet.decline = false;
    throw new Error('User rejected the request.');
  }
  if (window.__wallet.rotate) {
    window.__wallet.address = '0x3333333333333333333333333333333333333333';
    window.dispatchEvent(new Event('fixture-wallet-change'));
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return `0x${'11'.repeat(65)}`;
} });

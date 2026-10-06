import { answer } from './admin-wagmi.mjs';

export * from './wagmi-actions.mjs';

// One-shot reads (the funding snapshot, D18) answered from the fixture Safe and Sidequest v1, at whatever block is asked:
// the fixture chain has one state.
export async function readContracts(_config, { contracts, allowFailure = true }) {
  const results = contracts.map((c) => answer(c));
  return allowFailure ? results.map((result) => ({ status: 'success', result })) : results;
}

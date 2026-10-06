import { deployment } from '../../../packages/sdk/src/deployment.ts';
import { workTargets } from '../../../packages/sdk/src/delegation/grants.ts';
import { concat, toFunctionSelector } from 'viem';

// Keep mocked sponsorship bytes tied to the same ABI and method allow-list as the signed grant template.
const d = deployment('monad-testnet');
const stack = d.stacks.main;
if (stack === undefined || d.sidequest === null) throw new Error('The testnet Sidequest grant fixture is not deployed');
const targets = workTargets({ deployment: d, stack });
const target = (address) => {
  const found = targets.find((item) => item.address.toLowerCase() === address.toLowerCase());
  if (found === undefined) throw new Error(`Grant target is missing: ${address}`);
  return found;
};
const holding = target(stack.holding);
const vault = target(d.sidequest.vault);

export const holdingAbi = holding.abi;
export const vaultAbi = vault.abi;

export function sponsorshipGrantTerms(contracts) {
  const ctx = {
    deployment: { ...d, sidequest: { ...d.sidequest, vault: contracts.vault } },
    stack: { ...stack, holding: contracts.holding, evaluator: contracts.evaluator },
  };
  const templateTargets = workTargets(ctx);
  const methodNames = new Map(templateTargets.flatMap((item) => {
    const functions = item.abi.filter((fn) => fn.type === 'function' && item.methods.includes(fn.name));
    if (item.methods.some((name) => !functions.some((fn) => fn.name === name))) throw new Error('Grant method missing from ABI');
    return functions.map((fn) => [toFunctionSelector(fn), fn.name]);
  }));
  return {
    targets: templateTargets.map((item) => item.address),
    methods: concat([...methodNames.keys()]),
    methodNames: [...methodNames.values()].join(', '),
  };
}

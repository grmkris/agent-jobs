// scripts/ is not a workspace package and has no node_modules of its own, so viem comes from the SDK's, by path (the
// way the other root scripts reach packages). Adding a root dependency instead re-resolves shared peers in the lockfile.
export * from '../../packages/sdk/node_modules/viem/_esm/index.js'
export { privateKeyToAccount } from '../../packages/sdk/node_modules/viem/_esm/accounts/index.js'

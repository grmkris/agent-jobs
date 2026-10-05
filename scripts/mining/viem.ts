/** Mining scripts use the workspace-level viem dependency so their types and runtime stay stable. */
export * from 'viem'
export { privateKeyToAccount } from 'viem/accounts'

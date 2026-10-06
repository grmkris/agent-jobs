/**
 * Deploy-time choice of network for every Worker in the stack: `SIDEQUEST_NETWORK` (default `monad-testnet`) picks
 * the committed contracts config, and the RPC URL comes from the matching `.env.local` variable, so a `prod` deploy
 * can never talk to testnet by accident.
 */
export function rpcUrlForNetwork(): string | undefined {
  return process.env.SIDEQUEST_NETWORK === 'monad-mainnet' ? process.env.SIDEQUEST_PROD_MONAD_RPC_URL : process.env.MONAD_TESTNET_RPC_URL
}

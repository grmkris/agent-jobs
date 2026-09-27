/**
 * Deploy-time choice of network for every Worker in the stack: `AGENT_JOBS_NETWORK` (default `monad-testnet`) picks
 * the committed contracts config, and the RPC URL comes from the matching `.env.local` variable, so a `prod` deploy
 * can never talk to testnet by accident.
 */
export function rpcUrlForNetwork(): string | undefined {
  return process.env.AGENT_JOBS_NETWORK === 'monad-mainnet' ? process.env.MONAD_MAINNET_RPC_URL : process.env.MONAD_TESTNET_RPC_URL
}

import { stageProfile } from '../../../infra/stage.ts'

/** Live stages use the same plain RPC name on every network. Legacy testnet RPC is local/test-only. */
export function rpcUrlForNetwork(env: NodeJS.ProcessEnv = process.env): string | undefined {
  stageProfile(env.SIDEQUEST_STAGE)
  return env.MONAD_RPC_URL || ((env.SIDEQUEST_STAGE === undefined || env.SIDEQUEST_STAGE === 'local' || env.NODE_ENV === 'test') ? env.MONAD_TESTNET_RPC_URL : undefined)
}

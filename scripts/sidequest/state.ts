/** Sidequest owns an independent namespace. Remote state remains production-only. */
export function stateMode(env: NodeJS.ProcessEnv): 'local' | 'remote' {
  const remote = env.ALCHEMY_REMOTE_STATE === '1' || env.ALCHEMY_STATE_MODE === 'remote'
  if (remote && (env.SIDEQUEST_STAGE !== 'prod' || env.SIDEQUEST_NETWORK !== 'monad-mainnet')) throw new Error('Remote state is reserved for the explicit production release')
  if (env.ALCHEMY_STATE_MODE && !['local', 'remote'].includes(env.ALCHEMY_STATE_MODE)) throw new Error('Unknown state mode')
  if (env.ALCHEMY_STATE_MODE === 'local' && remote) throw new Error('Conflicting state configuration')
  return remote ? 'remote' : 'local'
}

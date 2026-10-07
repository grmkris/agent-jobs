/** Each live stage has independent remote state; local work and tests keep local state. */
export function stateMode(env: NodeJS.ProcessEnv): 'local' | 'remote' {
  if (env.ALCHEMY_STATE_MODE && !['local', 'remote'].includes(env.ALCHEMY_STATE_MODE)) throw new Error('Unknown state mode')
  const explicitRemote = env.ALCHEMY_REMOTE_STATE === '1' || env.ALCHEMY_STATE_MODE === 'remote'
  if (env.ALCHEMY_STATE_MODE === 'local' && explicitRemote) throw new Error('Conflicting state configuration')
  const remote = explicitRemote || (env.ALCHEMY_STATE_MODE !== 'local' && env.NODE_ENV !== 'test' && ['dev', 'prod'].includes(env.SIDEQUEST_STAGE ?? 'local'))
  if (remote && !['dev', 'prod'].includes(env.SIDEQUEST_STAGE ?? 'local')) throw new Error('Remote state requires dev or prod stage')
  return remote ? 'remote' : 'local'
}

export function assertLiveRelease(stage: string, state: 'local' | 'remote', env: NodeJS.ProcessEnv): void {
  if (env.SIDEQUEST_RELEASE !== '1') throw new Error('Live release requires SIDEQUEST_RELEASE=1')
  if (!['dev', 'prod'].includes(stage) || env.SIDEQUEST_STAGE !== stage) throw new Error('Live release stage mismatch')
  if (state !== 'remote') throw new Error('Live release requires remote state')
  if (env.SIDEQUEST_APPLY_MIGRATIONS !== '1') throw new Error('Live release requires SIDEQUEST_APPLY_MIGRATIONS=1')
  if (env.SIDEQUEST_WITHOUT_EXPLORE !== undefined) throw new Error('Live release requires Explore')
}

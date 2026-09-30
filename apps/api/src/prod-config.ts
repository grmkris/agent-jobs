export const prodSecretSources = {
  MONAD_RPC_URL: 'HIRELING_PROD_MONAD_RPC_URL',
  RELAY_PRIVATE_KEY: 'HIRELING_PROD_RELAY_PRIVATE_KEY',
  ATTESTER_PRIVATE_KEY: 'HIRELING_PROD_ATTESTER_PRIVATE_KEY',
  AI_GATEWAY_API_KEY: 'HIRELING_PROD_AI_GATEWAY_API_KEY',
  GITHUB_APP_PRIVATE_KEY: 'HIRELING_PROD_GITHUB_APP_PRIVATE_KEY',
  HYPERSYNC_API_TOKEN: 'HIRELING_PROD_HYPERSYNC_API_TOKEN',
} as const

export interface ProdArtifact {
  stage: string
  network: string
  chainId: number
  rpc: { url: string; chainId: number | null }
  hyperSync: { url: string; chainId: number | null }
  privy: { appId: string | null; origins: string[]; approved: boolean }
  remoteState: boolean
  secretSources: Record<string, string>
  addresses: Record<string, string | null>
}

interface ChainConfig {
  network: string
  chainId: number
  roles: Record<string, string>
  erc8004: { identity: string; reputation: string }
  x402: { usdc: string }
  factory: { faucet: boolean }
  holdGates: { minHoldToPublish: number; minHoldToClaim: number }
  faucetTokens: { names: string[]; symbols: string[] }
  knownTokens: string[]
  deployment: {
    network?: string
    block?: number
    core?: string
    factory?: string
    main?: { holding: string; evaluator: string; openTokens?: boolean }
    legacy?: Record<string, { openTokens?: boolean }>
  }
}

const address = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/.test(value)
const mainnetUrl = (value: string, hyperSync = false) => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
      !/testnet|10143|localhost|127\.0\.0\.1/i.test(url.hostname) &&
      (!hyperSync || url.origin === 'https://monad.hypersync.xyz')
  } catch {
    return false
  }
}

function validateCompleteProdConfig(config: ChainConfig, artifact: ProdArtifact): string[] {
  const failures: string[] = []
  const check = (valid: boolean, label: string) => { if (!valid) failures.push(label) }
  check(artifact.stage === 'prod' && artifact.network === 'monad-mainnet' && config.network === artifact.network, 'stage/network')
  check(config.chainId === 143 && artifact.chainId === 143 && artifact.rpc.chainId === 143 && artifact.hyperSync.chainId === 143, 'chain/providers')
  check(mainnetUrl(artifact.rpc.url), 'rpc URL')
  check(mainnetUrl(artifact.hyperSync.url, true), 'HyperSync URL')
  check(artifact.remoteState === true, 'remote state')
  check(artifact.privy.approved === true && typeof artifact.privy.appId === 'string' && artifact.privy.appId.length > 0 &&
    artifact.privy.origins.length > 0 && artifact.privy.origins.every(origin => origin === 'https://hireling.xyz'), 'Privy app/origin approval')
  check(config.factory.faucet === false && config.faucetTokens.names.length === 0 && config.faucetTokens.symbols.length === 0, 'no mainnet faucet')
  check(config.holdGates.minHoldToPublish === 0 && config.holdGates.minHoldToClaim === 0, 'zero hold gates')
  check(config.knownTokens.length === 1 && config.knownTokens[0]?.toLowerCase() === config.x402.usdc.toLowerCase(), 'known USDC')
  const deployed = config.deployment
  check(deployed.network === artifact.network && Number.isSafeInteger(deployed.block) && (deployed.block ?? 0) > 0, 'deployment network/block')
  check(deployed.main?.openTokens === true, 'open-token main Holding metadata')
  check(Object.values(deployed.legacy ?? {}).every(stack => stack.openTokens !== true), 'legacy tokens closed')
  const expected = {
    ...config.roles,
    identity: config.erc8004.identity,
    reputation: config.erc8004.reputation,
    usdc: config.x402.usdc,
    core: deployed.core,
    factory: deployed.factory,
    holding: deployed.main?.holding,
    evaluator: deployed.main?.evaluator,
  }
  for (const [name, value] of Object.entries(expected)) {
    check(address(value) && artifact.addresses[name]?.toLowerCase() === value.toLowerCase(), `address:${name}`)
  }
  for (const [binding, source] of Object.entries(prodSecretSources)) {
    check(artifact.secretSources[binding] === source, `secret source:${binding}`)
  }
  check(Object.keys(artifact.secretSources).length === Object.keys(prodSecretSources).length, 'unexpected secret source')
  return failures
}

export function validateProdConfig(config: ChainConfig, artifact: ProdArtifact): string[] {
  try {
    return validateCompleteProdConfig(config, artifact)
  } catch {
    return ['artifact structure']
  }
}

export function runtimeSecret(name: keyof typeof prodSecretSources): string | undefined {
  return process.env[process.env.AGENT_JOBS_NETWORK === 'monad-mainnet' ? prodSecretSources[name] : name]
}

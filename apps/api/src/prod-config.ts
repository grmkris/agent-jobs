export const prodSecretSources = {
  MONAD_RPC_URL: 'HIRELING_PROD_MONAD_RPC_URL',
  RELAY_PRIVATE_KEY: 'HIRELING_PROD_RELAY_PRIVATE_KEY',
  ATTESTER_PRIVATE_KEY: 'HIRELING_PROD_ATTESTER_PRIVATE_KEY',
  AI_GATEWAY_API_KEY: 'HIRELING_PROD_AI_GATEWAY_API_KEY',
  GITHUB_APP_PRIVATE_KEY: 'HIRELING_PROD_GITHUB_APP_PRIVATE_KEY',
  HYPERSYNC_API_TOKEN: 'HIRELING_PROD_HYPERSYNC_API_TOKEN',
  TELEGRAM_BOT_TOKEN: 'HIRELING_PROD_TELEGRAM_BOT_TOKEN',
  TELEGRAM_WEBHOOK_SECRET: 'HIRELING_PROD_TELEGRAM_WEBHOOK_SECRET',
} as const

export interface ProdStack {
  // JSON artifacts are validated at runtime below; keep this broad enough for
  // inferred JSON fixtures while the accepted values remain fail-closed.
  kind?: string | undefined
  factory?: string | null | undefined
  holding: string | null
  evaluator: string | null
  openTokens?: boolean | undefined
}

export interface ProdHireling {
  block: number | null
  factory: string | null
  vault: string | null
  feeSchedule: string | null
  distributor: string | null
  miningReserve: string | null
  teamVesting: string | null
  t0: number | null
}

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
  deployment: {
    main: ProdStack
    hireling: ProdHireling
    legacy?: Record<string, ProdStack> | undefined
  }
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
  stacks: { names: string[] }
  deployment: {
    network?: string
    block?: number
    core?: string
    factory?: string
    main?: ProdStack
    hireling?: ProdHireling
    demo?: ProdStack
    fast?: ProdStack
    legacy?: Record<string, ProdStack>
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
  check(config.stacks.names.length === 1 && config.stacks.names[0] === 'main' && deployed.demo === undefined && deployed.fast === undefined, 'single v1 stack')
  check(deployed.main?.kind === 'hireling-v1' && artifact.deployment.main.kind === 'hireling-v1', 'main v1 kind')
  check(address(deployed.main?.factory) && deployed.main.factory.toLowerCase() === deployed.factory?.toLowerCase() &&
    deployed.main.factory.toLowerCase() === deployed.hireling?.factory?.toLowerCase(), 'v1 factory consistency')
  check(Object.keys(deployed.legacy ?? {}).length === 0 && Object.keys(artifact.deployment.legacy ?? {}).length === 0, 'no mainnet legacy pairs')
  const hireling = deployed.hireling
  check(hireling !== undefined && Number.isSafeInteger(hireling.block) && (hireling.block ?? 0) > 0 &&
    Number.isSafeInteger(hireling.t0) && (hireling.t0 ?? 0) > 0 &&
    artifact.deployment.hireling.block === hireling.block && artifact.deployment.hireling.t0 === hireling.t0, 'hireling block/T0')
  for (const name of ['factory', 'vault', 'feeSchedule', 'distributor', 'miningReserve', 'teamVesting'] as const) {
    const value = hireling?.[name]
    check(address(value) && artifact.deployment.hireling[name]?.toLowerCase() === value.toLowerCase(), `hireling:${name}`)
  }
  for (const name of ['factory', 'holding', 'evaluator'] as const) {
    const value = deployed.main?.[name]
    check(address(value) && artifact.deployment.main[name]?.toLowerCase() === value.toLowerCase(), `main:${name}`)
  }
  check(artifact.deployment.main.openTokens === true, 'artifact main open tokens')
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

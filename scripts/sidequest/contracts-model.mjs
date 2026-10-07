/**
 * Pure planning for `contracts.mjs`, the testnet deploy wrapper for one Sidequest generation (G1d and later).
 * Every action runs forge from `contracts/` with the run's own broadcast root, so an earlier generation's broadcast
 * logs and candidate record stay where they are. Only `deploy` and `accept` broadcast, and only with
 * `SIDEQUEST_TESTNET_SEND=1`.
 */

export const TESTNET_CHAIN_ID = 10143
export const SENDING = new Set(['deploy', 'accept'])
export const SCRIPTS = {
  'deploy-plan': 'DeploySidequest.s.sol',
  deploy: 'DeploySidequest.s.sol',
  promote: 'PromoteSidequest.s.sol',
  'accept-plan': 'SafeAccept.s.sol',
  accept: 'SafeAccept.s.sol',
  verify: 'SafeAccept.s.sol',
}
export const ACTIONS = new Set([...Object.keys(SCRIPTS), 'archive'])
export const LOCKED_OPERATIONS = new Set(['archive', 'deploy', 'promote', 'accept'])

/** `<action> --generation <label>`; the label names the broadcast root, the logs and the config archive. */
export function parseArgs(argv) {
  const [action, ...rest] = argv
  if (!ACTIONS.has(action)) throw new Error('invalid-contract-action')
  const flag = rest.indexOf('--generation')
  const generation = flag === -1 ? undefined : rest[flag + 1]
  if (generation === undefined || !/^[a-z][a-z0-9-]{1,31}$/.test(generation)) throw new Error('generation-required')
  return { action, generation }
}

export const broadcastRoot = (generation) => `broadcast/sidequest-${generation}`
export const candidatePath = (generation) =>
  `contracts/${broadcastRoot(generation)}/sidequest/monad-testnet.candidate.json`
export const archivePath = (generation) => `contracts/config/archive/pre-${generation}-monad-testnet.json`
export const operationLockPath = (generation) => `.sidequest/contracts-${generation}.lock`

/** The signing role per action: the Safe owner accepts, the configured admin deploys. Promote and verify send nothing. */
export const roleFor = (action) => (action.startsWith('accept') ? 'SAFE_OWNER' : 'DEPLOYER')

/**
 * The forge invocation for one action, or a refusal. `candidateExists` is whether this generation's candidate record
 * is already on disk; `signer` is the role's keystore (address, path, passwordPath).
 */
/** Every refusal, in order; the first that applies wins. */
function refusal({ action, config, env, candidateExists, signer }) {
  const promoted = config.deployment?.sidequest !== undefined
  const checks = [
    [config.chainId !== TESTNET_CHAIN_ID || config.sidequest?.reuseCore === true, 'fresh-testnet-config-required'],
    [SENDING.has(action) && env.SIDEQUEST_TESTNET_SEND !== '1', 'testnet-send-not-enabled'],
    [!env.MONAD_RPC_URL, 'rpc-url-required'],
    [action === 'deploy' && (promoted || candidateExists), 'deployment-already-started-reconcile-before-resume'],
    [action === 'deploy-plan' && promoted, 'config-still-promoted-archive-first'],
    [
      roleFor(action) === 'DEPLOYER' && signer.address.toLowerCase() !== String(config.roles?.admin).toLowerCase(),
      'deployer-config-mismatch',
    ],
  ]
  return checks.find(([refused]) => refused)?.[1]
}

/**
 * The forge invocation for one action, or a refusal. `candidateExists` is whether this generation's candidate record
 * is already on disk; `signer` is the role's keystore (address, path, passwordPath).
 */
export function planAction(input) {
  const refused = refusal(input)
  if (refused !== undefined) throw new Error(refused)
  const { action, generation, env, signer } = input
  const sends = SENDING.has(action)
  const args = ['script', `script/${SCRIPTS[action]}`, '--rpc-url', env.MONAD_RPC_URL, '--sender', signer.address]
  if (action === 'verify') args.push('--sig', 'check()')
  if (action !== 'promote' && action !== 'verify') {
    args.push(
      '--keystore',
      signer.path,
      '--password-file',
      signer.passwordPath,
      '--legacy',
      '--with-gas-price',
      '110000000000',
      '--gas-estimate-multiplier',
      '110',
    )
  }
  if (sends) args.push('--broadcast', '--slow', '--non-interactive')
  return { args, sends, forgeEnv: { NETWORK: 'monad-testnet', FOUNDRY_BROADCAST: broadcastRoot(generation) } }
}

/**
 * The config a fresh deploy expects: `deployment` keeps only `rewardTokens` (mUSD/mEUR are reused), every other
 * top-level key (roles, erc8004, delegation, x402, knownTokens, usdPegged, boards, sidequest, liquidity, …) is kept.
 * Same transform as `contracts/script/rehearse-sidequest-pipeline.sh`.
 */
export function resetConfig(config) {
  if (config.chainId !== TESTNET_CHAIN_ID) throw new Error('fresh-testnet-config-required')
  if (config.deployment?.sidequest === undefined) throw new Error('config-not-promoted-nothing-to-archive')
  const rewardTokens = config.deployment.rewardTokens
  if (!Array.isArray(rewardTokens) || rewardTokens.length === 0) throw new Error('reward-tokens-missing')
  return { ...config, deployment: { rewardTokens } }
}

import { readFileSync } from 'node:fs'
import { RELAY_FLOOR_MAINNET } from '@agent-jobs/sdk'
import { privateKeyToAccount } from 'viem/accounts'
import mainnet from '../../../contracts/config/monad-mainnet.json' with { type: 'json' }
import { liveLaunchGate, opensAdmission, prodSecretSources, relayFloorWei, validateAdmissionMode, validateProdConfig, type ChainConfig, type LaunchReader, type ProdArtifact } from './prod-config.ts'

/** JSON-RPC reads only (eth_getCode, eth_call, eth_getBalance at latest). Any transport, HTTP or RPC error throws. */
export function rpcReader(url: string): LaunchReader {
  let id = 0
  const rpc = async (method: string, params: unknown[]): Promise<string> => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(15_000) })
    const body = await response.json() as { result?: unknown; error?: unknown }
    if (!response.ok || body.error !== undefined || typeof body.result !== 'string' || !/^0x[0-9a-fA-F]*$/.test(body.result)) throw new Error('read failed')
    return body.result
  }
  return {
    code: address => rpc('eth_getCode', [address, 'latest']),
    call: async (to, data) => await rpc('eth_call', [{ to, data }, 'latest']) as `0x${string}`,
    balance: async address => BigInt(await rpc('eth_getBalance', [address, 'latest'])),
  }
}

/** D16: refuse a deploy that would open production admission unless the live launch predicates hold. A deploy that pins
 *  an explicit drained `PROD_ADMISSION_DRAIN` (setup or emergency) does not need them. Runs before any resource. */
export async function assertLaunchGate(config: ChainConfig, drain: string | undefined, reader: LaunchReader, relayFloor: bigint | undefined): Promise<void> {
  if (!opensAdmission(drain)) return
  const failures = await liveLaunchGate(config, reader, relayFloor)
  if (failures.length > 0) throw new Error(`production launch gate refused: ${failures.join(', ')}`)
}

export async function assertDeployConfig(stage: string): Promise<void> {
  const network = process.env.AGENT_JOBS_NETWORK ?? 'monad-testnet'
  if (stage !== 'prod' && network !== 'monad-mainnet') return
  if (stage !== 'prod' || network !== 'monad-mainnet' || process.env.AGENT_JOBS_STAGE !== stage) throw new Error('production stage/network mismatch')
  const path = process.env.AGENT_JOBS_PROD_ARTIFACT
  if (path === undefined || !path.endsWith('.json')) throw new Error('production needs an explicit reviewed JSON artifact')
  let artifact: ProdArtifact
  try {
    artifact = JSON.parse(readFileSync(path, 'utf8')) as ProdArtifact
  } catch {
    throw new Error('production artifact is unreadable or invalid JSON')
  }
  let failures: string[]
  try {
    failures = [...validateProdConfig(mainnet, artifact), ...validateAdmissionMode(artifact, process.env.PROD_ADMISSION_DRAIN)]
  } catch {
    throw new Error('production artifact has missing or invalid fields')
  }
  if (failures.length > 0) throw new Error(`production preflight rejected: ${failures.join(', ')}`)
  if (process.env.ALCHEMY_REMOTE_STATE !== '1') throw new Error('production requires remote state')
  if (process.env.HIRELING_PROD_PRIVY_APP_ID !== artifact.privy.appId || process.env.HYPERSYNC_URL !== artifact.hyperSync.url) throw new Error('production provider/Privy runtime mapping mismatch')
  for (const [binding, source] of Object.entries(prodSecretSources)) {
    const value = process.env[source]
    if (value === undefined || value === '' || value === 'unset') throw new Error(`production secret source missing: ${binding}`)
  }
  for (const [source, role] of [['HIRELING_PROD_RELAY_PRIVATE_KEY', 'relay'], ['HIRELING_PROD_ATTESTER_PRIVATE_KEY', 'attester']] as const) {
    let matches = false
    try {
      matches = privateKeyToAccount(process.env[source] as `0x${string}`).address.toLowerCase() === mainnet.roles[role].toLowerCase()
    } catch {
      throw new Error(`production signing source invalid: ${role}`)
    }
    if (!matches) throw new Error(`production signing address mismatch: ${role}`)
  }
  const rpc = process.env.HIRELING_PROD_MONAD_RPC_URL
  if (rpc !== artifact.rpc.url) throw new Error('production RPC runtime mapping mismatch')
  try {
    const response = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), signal: AbortSignal.timeout(15_000) })
    const body = await response.json() as { result?: string }
    if (!response.ok || Number(body.result) !== 143) throw new Error('chain mismatch')
  } catch {
    throw new Error('production read-only RPC chain proof failed')
  }
  await assertLaunchGate(mainnet, process.env.PROD_ADMISSION_DRAIN, rpcReader(rpc), relayFloorWei(RELAY_FLOOR_MAINNET))
}

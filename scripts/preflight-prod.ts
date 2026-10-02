import { readFileSync } from 'node:fs'
import { liveLaunchGate, relayFloorWei, validateProdConfig, type ProdArtifact } from '../apps/api/src/prod-config.ts'
import { rpcReader } from '../apps/api/src/deploy-preflight.ts'
import mainnet from '../contracts/config/monad-mainnet.json' with { type: 'json' }

// TODO(D16, B6): import { RELAY_FLOOR_MAINNET } from '@agent-jobs/sdk' once B6 is on main; until then --live refuses.
const RELAY_FLOOR_MAINNET: bigint | string | undefined = undefined

const path = process.argv[2]
const live = process.argv.includes('--live')
if (!path) throw new Error('pass a reviewed production artifact JSON path, optionally --live; no secret values')
let artifact: ProdArtifact | undefined
let failures: string[]
try {
  artifact = JSON.parse(readFileSync(path, 'utf8')) as ProdArtifact
  failures = validateProdConfig(mainnet, artifact)
} catch {
  console.error('production preflight rejected: artifact is unreadable or structurally invalid')
  process.exitCode = 1
  failures = []
}
if (failures.length > 0) {
  console.error(`production preflight rejected: ${failures.join(', ')}`)
  process.exitCode = 1
} else if (process.exitCode !== 1 && !live) {
  console.log('Hireling v1 production structural preflight passed (single main pair, Safe, vault, fees and mining); run with --live for the D16 launch gate')
} else if (process.exitCode !== 1 && artifact !== undefined) {
  // D16 live launch gate, read-only, against the artifact's reviewed public RPC.
  const reader = rpcReader(artifact.rpc.url)
  let gate: string[]
  try {
    const chain = await fetch(artifact.rpc.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), signal: AbortSignal.timeout(15_000) })
    const body = await chain.json() as { result?: string }
    gate = Number(body.result) === 143 ? await liveLaunchGate(mainnet, reader, relayFloorWei(RELAY_FLOOR_MAINNET)) : ['launch:rpc is not chain 143']
  } catch {
    gate = ['launch:rpc unreadable']
  }
  if (gate.length > 0) {
    console.error(`production launch gate refused: ${gate.join(', ')}`)
    process.exitCode = 1
  } else {
    console.log('Hireling v1 production launch gate passed: Safe owns all six, holds both core admin roles (deployer neither), attester verifies, relay above RELAY_FLOOR_MAINNET')
  }
}

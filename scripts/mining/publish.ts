import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { epochDistributorAbi } from '../../packages/sdk/src/abi/epochDistributor.ts'
import { type DeploymentConfig } from '../../packages/sdk/src/deployment.ts'
import { client } from './chain.ts'
import { CloudflareManifests, MiningPublishError, publishEpoch, stageOf } from './publish-lib.ts'

// Coordinator-only live command: no deployment, state initialization, signer or on-chain transaction.
try {
  const args = process.argv.slice(2)
  if (args.length !== 3 || args[1] !== '--stage' || !args[0]) throw new MiningPublishError('usage')
  const selected = stageOf(args[2]!)
  const envPath = resolve('.env.local')
  const env = { ...process.env, ...(existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {}) }
  if ((env.SIDEQUEST_STAGE && env.SIDEQUEST_STAGE !== selected.stage) || (env.SIDEQUEST_NETWORK && env.SIDEQUEST_NETWORK !== selected.network)) throw new MiningPublishError('stage-chain-mismatch')
  const rpc = env[selected.network === 'monad-mainnet' ? 'MONAD_MAINNET_RPC_URL' : 'MONAD_TESTNET_RPC_URL']
  if (!rpc || rpc === 'unset') throw new MiningPublishError('credentials-missing')
  const bytes = readFileSync(resolve(args[0]))
  const config = JSON.parse(readFileSync(new URL(`../../contracts/config/${selected.network}.json`, import.meta.url), 'utf8')) as DeploymentConfig
  const c = client(rpc)
  await publishEpoch(bytes, selected, config, {
    getChainId: () => c.getChainId(),
    readRoot: (address, epoch) => c.readContract({ address, abi: epochDistributorAbi, functionName: 'rootOf', args: [epoch] }),
  }, new CloudflareManifests(env))
  console.log('mining:publish uploaded and verified')
} catch (error) {
  // RPC/provider exceptions can contain credentials and request bodies; print only our fixed codes.
  console.error(`mining:publish refused: ${error instanceof MiningPublishError ? error.code : 'unavailable'}`)
  process.exitCode = 1
}

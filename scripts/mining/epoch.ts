import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { creditRuleOf, type CreditRuleConfig } from './rule.ts'
import type { EpochOptions, MiningConfig } from './epoch-v2.ts'
import type { PriceListFile } from './prices.ts'

export const epochEntry = (config: CreditRuleConfig, epoch: bigint) =>
  creditRuleOf(config, epoch).version === 1 ? './epoch-v1.ts' : './epoch-v2.ts'

const argv = process.argv.slice(2)
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? undefined : argv[i + 1]
}
const network = flag('network') ?? 'monad-testnet'
const rpc = flag('rpc') ?? process.env[network === 'monad-mainnet' ? 'MONAD_MAINNET_RPC_URL' : 'MONAD_TESTNET_RPC_URL']

async function dispatch() {
  const epochArg = argv[0]
  if (epochArg === undefined || !/^[0-9]+$/.test(epochArg)) throw new Error('usage: bun run mining:epoch <n> ...')
  if (network !== 'monad-testnet' && network !== 'monad-mainnet') throw new Error('unsupported mining network')
  const epoch = BigInt(epochArg)
  const configPath = resolve(flag('config') ?? join(import.meta.dirname, '../../contracts/config', `${network}.json`))
  // SAFETY: deploymentFromConfig validates the selected deployment; creditRuleOf validates its cutover.
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as MiningConfig
  const entry = epochEntry(config, epoch)
  if (flag('recompute') === undefined && entry === './epoch-v1.ts') {
    await import(entry)
    return
  }
  if (rpc === undefined || rpc === '') throw new Error('set --rpc or the selected network RPC variable')
  const pageArg = flag('page') ?? '1000'
  if (!/^[1-9][0-9]*$/.test(pageArg)) throw new Error('--page takes a positive number of blocks')
  const options: Omit<EpochOptions, 'pricesFile' | 'previousFile'> = {
    epoch,
    network,
    config,
    rpc,
    page: BigInt(pageArg),
  }
  const recompute = flag('recompute')
  if (recompute !== undefined) {
    await (await import('./recompute.ts')).runRecompute(recompute, options)
    return
  }
  const pricesPath = flag('prices'),
    outDir = flag('out')
  if (pricesPath === undefined || outDir === undefined) throw new Error('v2 epoch requires --prices and --out')
  // SAFETY: verifiedPriceList validates the message, tokens and signature before the builder uses them.
  const pricesFile = JSON.parse(readFileSync(pricesPath, 'utf8')) as PriceListFile
  await (
    await import('./epoch-v2.ts')
  ).runEpochV2(
    { ...options, pricesFile, previousPath: flag('previous-prices') ?? join(outDir, `epoch-${epoch - 1n}.json`) },
    outDir,
  )
}

if (import.meta.main)
  await dispatch().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(
      `mining:epoch failed: ${rpc === undefined || rpc === '' ? message : message.split(rpc).join('<rpc>')}`,
    )
    process.exitCode = 1
  })

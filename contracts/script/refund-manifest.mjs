import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createPublicClient, http, erc20Abi } from 'viem'
import { KRIS, address, checksum, makeManifest, oldVaultAbi, positionCandidates } from './refund-model.mjs'

export const PUBLIC_RPC = 'https://testnet-rpc.monad.xyz'
export async function readLogs(from, through, addresses, client, pageSize = 1000) {
  const logs = []
  for (let next = from; next <= through; next += pageSize) {
    const end = Math.min(next + pageSize - 1, through)
    const page = await client.getLogs({ address: addresses, fromBlock: BigInt(next), toBlock: BigInt(end) })
    for (const log of page) {
      if (log.removed || log.blockNumber === null || log.logIndex === null || !log.transactionHash || log.blockNumber < BigInt(next) || log.blockNumber > BigInt(end)
        || !addresses.some(a => address(a) === address(log.address))) throw new Error('refund: RPC returned a foreign or incomplete log')
      logs.push({ address: log.address, block_number: Number(log.blockNumber), log_index: log.logIndex, transaction_hash: log.transactionHash,
        topic0: log.topics[0] ?? null, topic1: log.topics[1] ?? null, topic2: log.topics[2] ?? null, topic3: log.topics[3] ?? null, data: log.data })
    }
  }
  return logs
}

/** Only public RPC reads. All reads and candidate enumeration are pinned to the requested finalized block. */
export async function captureSnapshot(config, block, rpc = PUBLIC_RPC, dependencies = {}) {
  const h = config.deployment?.sidequest
  if (config.chainId !== 10143 || config.network !== 'monad-testnet' || !Number.isSafeInteger(h?.block) || !Number.isSafeInteger(block) || block < h.block) throw new Error('refund: requires an archived testnet deployment and explicit snapshot block')
  const client = dependencies.client ?? createPublicClient({ transport: http(rpc, { timeout: 20_000, retryCount: 2 }) })
  if (await client.getChainId() !== 10143) throw new Error('refund: RPC must be chain 10143')
  const head = await client.getBlock({ blockTag: 'finalized' })
  if (BigInt(block) > head.number) throw new Error('refund: snapshot block is not finalized')
  const fixed = await client.getBlock({ blockNumber: BigInt(block) })
  const read = (contract, abi, functionName, args = []) => client.readContract({ address: address(contract), abi, functionName, args, blockNumber: BigInt(block) })
  if (address(await read(h.vault, oldVaultAbi, 'factory')) !== address(h.factory)) throw new Error('refund: archived vault token mismatch')
  const vaultLogs = await (dependencies.readLogs ?? readLogs)(h.block, block, [h.vault], client)
  const accounts = await captureAccounts(vaultLogs, h.vault, read)
  const exclusions = [[config.deployment.testnetFaucet, 'old faucet balance is not refunded'], [config.sidequest.allocation.ecosystem, 'ecosystem allocation is recreated']].filter(([wallet]) => wallet)
  if (exclusions.some(([wallet]) => address(wallet) === KRIS)) throw new Error('refund: Kris overlaps an excluded allocation')
  const excluded = []
  for (const [wallet, reason] of exclusions) excluded.push({ wallet: address(wallet), amount: String(await read(h.factory, erc20Abi, 'balanceOf', [address(wallet)])), reason })
  const looseBalances = [{ wallet: KRIS, amount: String(await read(h.factory, erc20Abi, 'balanceOf', [KRIS])), sources: ['Kris loose old SIDE at snapshot'] }]
  const totalAssets = String(await read(h.vault, oldVaultAbi, 'totalAssets'))
  if ((await client.getBlock({ blockNumber: BigInt(block) })).hash !== fixed.hash) throw new Error('refund: snapshot block hash changed')
  return { chainId: 10143, block, blockHash: fixed.hash, timestamp: Number(fixed.timestamp), old: { vault: address(h.vault), factory: address(h.factory), core: address(config.deployment.core), holding: address(config.deployment.main.holding), block: h.block, configChecksum: checksum(config) }, vaultLogs, accounts, looseBalances, excluded, totalAssets }
}

export function parseManifestArgs(args) {
  const options = { out: 'docs/evidence/testnet-g1d/refund-manifest.json' }
  for (let i = 0; i < args.length; i += 2) {
    if (!['--out', '--config', '--block'].includes(args[i]) || args[i + 1] === undefined || options[args[i].slice(2)] !== undefined && args[i] !== '--out') throw new Error('refund: usage refund-manifest.mjs --config ARCHIVE --block N [--out FILE]')
    options[args[i].slice(2)] = args[i + 1]
  }
  if (!options.config || !/^[1-9][0-9]*$/u.test(options.block ?? '') || !options.config.startsWith('contracts/config/archive/')) throw new Error('refund: --config must name an archived config and --block is required')
  return { ...options, block: Number(options.block) }
}

async function main() {
  const options = parseManifestArgs(process.argv.slice(2))
  const config = JSON.parse(readFileSync(options.config, 'utf8'))
  if (Number(config.deployment?.block) - 1 !== options.block) throw new Error('refund: --block must equal archived deployment.block - 1')
  const target = resolve(options.out), evidence = target.replace(/\.json$/u, '.snapshot.json')
  if (target === evidence || existsSync(target) || existsSync(evidence)) throw new Error('refund: outputs already exist or path does not end in .json')
  const snapshot = await captureSnapshot(config, options.block, process.env.MONAD_RPC_URL || process.env.MONAD_TESTNET_RPC_URL || PUBLIC_RPC)
  const manifest = makeManifest(snapshot)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(evidence, JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx' })
  writeFileSync(target, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ block: snapshot.block, positions: manifest.positions.length, transfers: manifest.transfers.length, totals: manifest.totals, checksum: manifest.checksum }))
}


const stringValues = record => Object.fromEntries(Object.entries(record).map(([key, value]) => [key, String(value)]))
async function captureAccounts(vaultLogs, vault, read) {
  const candidates = positionCandidates(vaultLogs), accounts = []
  for (const account of new Set(candidates.map(row => row.account))) {
    const pool = await read(vault, oldVaultAbi, 'poolOf', [account])
    const positions = []
    for (const candidate of candidates.filter(row => row.account === account)) {
      const position = await read(vault, oldVaultAbi, 'positionOf', [account, candidate.delegator])
      const assets = await read(vault, oldVaultAbi, 'convertToAssets', [account, position.shares])
      positions.push({ delegator: candidate.delegator, ...stringValues(position), assets: String(assets) })
    }
    accounts.push({ account, pool: stringValues(pool), positions })
  }
  return accounts
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) await main().catch(error => {
  console.error(error.message?.startsWith('refund:') ? error.message : 'refund: public read unavailable; provider details suppressed')
  process.exitCode = 1
})

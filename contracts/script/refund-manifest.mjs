import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createPublicClient, http, erc20Abi, parseUnits } from 'viem'
import { KRIS, address, checksum, makeManifest, oldVaultAbi, positionCandidates } from './refund-model.mjs'
import { refundIdentity, refundPaths } from './refund-generation.mjs'

export const PUBLIC_RPC = 'https://testnet-rpc.monad.xyz'
/** Monad's public RPC refuses eth_getLogs over more than 100 blocks (-32614) and more than 25 requests a second. */
const RPC_REQUESTS_PER_SECOND = 20
const RATE_LIMITED = /limited to \d+\/sec|rate limit|too many requests|\b429\b/i
/** The client methods a manifest run calls; each is one RPC request. */
const PACED = new Set(['getChainId', 'getBlock', 'getLogs', 'readContract'])

/** Spaces every call of a client so one manifest run stays under the public RPC's request rate. */
export function paced(client, perSecond = RPC_REQUESTS_PER_SECOND) {
  let next = 0
  const slot = async () => {
    const now = Date.now()
    const at = Math.max(now, next)
    next = at + 1000 / perSecond
    if (at > now) await new Promise(done => setTimeout(done, at - now))
  }
  return new Proxy(client, {
    get(target, key) {
      const value = target[key]
      if (!PACED.has(key)) return value
      // The limit is per caller IP, so other local users (a fork rehearsal's anvil) can still trip it: back off and retry.
      return async (...args) => {
        for (let attempt = 0; ; attempt++) {
          await slot()
          try {
            return await value.apply(target, args)
          } catch (error) {
            if (attempt >= 5 || !RATE_LIMITED.test(String(error?.details ?? error?.shortMessage ?? error?.message))) throw error
            await new Promise(done => setTimeout(done, 1000 * (attempt + 1)))
          }
        }
      }
    },
  })
}

export const LOG_PAGE_BLOCKS = 100
const LOG_PAGES_IN_FLIGHT = 8

/** One log as the model reads it, refused unless it is complete, from a watched address and inside its own page. */
function logRow(log, [next, end], addresses) {
  if (log.removed || log.blockNumber === null || log.logIndex === null || !log.transactionHash || log.blockNumber < BigInt(next) || log.blockNumber > BigInt(end)
    || !addresses.some(a => address(a) === address(log.address))) throw new Error('refund: RPC returned a foreign or incomplete log')
  return { address: log.address, block_number: Number(log.blockNumber), log_index: log.logIndex, transaction_hash: log.transactionHash,
    topic0: log.topics[0] ?? null, topic1: log.topics[1] ?? null, topic2: log.topics[2] ?? null, topic3: log.topics[3] ?? null, data: log.data }
}

export async function readLogs(from, through, addresses, client, pageSize = LOG_PAGE_BLOCKS) {
  const pages = []
  for (let next = from; next <= through; next += pageSize) pages.push([next, Math.min(next + pageSize - 1, through)])
  const logs = []
  // A few pages in flight at once, then appended in block order; every log is still checked against its own page.
  for (let i = 0; i < pages.length; i += LOG_PAGES_IN_FLIGHT) {
    const batch = pages.slice(i, i + LOG_PAGES_IN_FLIGHT)
    const results = await Promise.all(batch.map(([next, end]) => client.getLogs({ address: addresses, fromBlock: BigInt(next), toBlock: BigInt(end) })))
    for (const [index, page] of results.entries()) logs.push(...page.map(log => logRow(log, batch[index], addresses)))
  }
  return logs
}

/** Only public RPC reads. All reads and candidate enumeration are pinned to the requested finalized block. */
export async function captureSnapshot(config, block, rpc = PUBLIC_RPC, dependencies = {}, krisSide) {
  const h = config.deployment?.sidequest
  if (config.chainId !== 10143 || config.network !== 'monad-testnet' || !Number.isSafeInteger(h?.block) || !Number.isSafeInteger(block) || block < h.block) throw new Error('refund: requires an archived testnet deployment and explicit snapshot block')
  const client = dependencies.client ?? paced(createPublicClient({ transport: http(rpc, { timeout: 20_000, retryCount: 2 }) }))
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
  const amount = krisSide === undefined
    ? await read(h.factory, erc20Abi, 'balanceOf', [KRIS])
    : parseUnits(krisSide, Number(await read(h.factory, erc20Abi, 'decimals')))
  const looseBalances = [{ wallet: KRIS, amount: String(amount), sources: [krisSide === undefined ? 'Kris loose old SIDE at snapshot' : 'Explicit Kris cutover allocation; liquid balances are not migrated'] }]
  const totalAssets = String(await read(h.vault, oldVaultAbi, 'totalAssets'))
  if ((await client.getBlock({ blockNumber: BigInt(block) })).hash !== fixed.hash) throw new Error('refund: snapshot block hash changed')
  return { chainId: 10143, block, blockHash: fixed.hash, timestamp: Number(fixed.timestamp), old: { vault: address(h.vault), factory: address(h.factory), core: address(config.deployment.core), holding: address(config.deployment.main.holding), block: h.block, configChecksum: checksum(config) }, vaultLogs, accounts, looseBalances, excluded, totalAssets }
}

export function parseManifestArgs(args) {
  const options = {}
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.slice(2)
    if (!['--out', '--config', '--block', '--generation', '--source', '--kris-side'].includes(args[i]) || args[i + 1] === undefined || options[key] !== undefined)
      throw new Error('refund: usage refund-manifest.mjs --config ARCHIVE --block N [--generation LABEL --source LABEL --kris-side AMOUNT --out FILE]')
    options[key] = args[i + 1]
  }
  const identity = refundIdentity(options.generation, options.source)
  if (!options.config || !/^[1-9][0-9]*$/u.test(options.block ?? '') || !options.config.startsWith('contracts/config/archive/') || !Number.isSafeInteger(Number(options.block)))
    throw new Error('refund: --config must name an archived config and --block is required')
  if (options['kris-side'] !== undefined && !/^[1-9][0-9]*(?:\.[0-9]+)?$/u.test(options['kris-side'])) throw new Error('refund: invalid Kris allocation')
  return { ...options, ...identity, out: options.out ?? refundPaths(identity.generation).manifest, block: Number(options.block), krisSide: options['kris-side'] }
}

async function main() {
  const options = parseManifestArgs(process.argv.slice(2))
  const config = JSON.parse(readFileSync(options.config, 'utf8'))
  // The archive pins old contracts; its deployment block cannot identify G1d's future cutoff.
  // The batch verifies --block against the promoted new deployment before any send.
  const target = resolve(options.out), evidence = target.replace(/\.json$/u, '.snapshot.json')
  if (target === evidence || existsSync(target) || existsSync(evidence)) throw new Error('refund: outputs already exist or path does not end in .json')
  const snapshot = await captureSnapshot(config, options.block, process.env.MONAD_RPC_URL || process.env.MONAD_TESTNET_RPC_URL || PUBLIC_RPC, {}, options.krisSide)
  const manifest = makeManifest(snapshot, options)
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

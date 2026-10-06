import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createPublicClient, http, parseAbi, decodeEventLog, erc20Abi } from 'viem'
import { address, checksum, decodeVaultLogs, logKey, makeManifest, oldVaultAbi } from './refund-model.mjs'

const registryAbi = parseAbi([
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
  'event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue)',
  'function ownerOf(uint256) view returns (address)',
  'function getAgentWallet(uint256) view returns (address)',
])

export async function readLogs(from, through, addresses, token) {
  const logs = []
  let next = from
  while (next <= through) {
    const response = await fetch('https://monad-testnet.hypersync.xyz/query', {
      method: 'POST', signal: AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ from_block: next, to_block: through + 1, logs: [{ address: addresses }],
        field_selection: { log: ['block_number', 'log_index', 'transaction_hash', 'address', 'topic0', 'topic1', 'topic2', 'topic3', 'data'] } }),
    })
    if (!response.ok) throw new Error(`refund: HyperSync HTTP ${response.status}`)
    const body = await response.json()
    if (!Number.isSafeInteger(body.next_block) || body.next_block <= next || body.next_block > through + 1) {
      throw new Error('refund: HyperSync range did not advance safely')
    }
    const page = (body.data ?? []).flatMap(row => row.logs ?? [])
    if (page.some(log => log.block_number < next || log.block_number >= body.next_block || !addresses.some(a => a.toLowerCase() === log.address.toLowerCase()))) {
      throw new Error('refund: HyperSync returned a foreign log')
    }
    logs.push(...page)
    next = body.next_block
  }
  return logs
}

function registryCandidates(logs) {
  const byWallet = new Map()
  function add(wallet, id) {
    const key = address(wallet)
    if (!byWallet.has(key)) byWallet.set(key, new Set())
    byWallet.get(key).add(id.toString())
  }
  for (const log of logs) {
    let event
    try { event = decodeEventLog({ abi: registryAbi, data: log.data, topics: [log.topic0, log.topic1, log.topic2, log.topic3].filter(Boolean), strict: true }) }
    catch { continue }
    if (event.eventName === 'Registered') add(event.args.owner, event.args.agentId)
    if (event.eventName === 'MetadataSet' && event.args.metadataKey === 'agentWallet') {
      const value = event.args.metadataValue
      if (/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{24}[0-9a-fA-F]{40}$/.test(value)) add(`0x${value.slice(-40)}`, event.args.agentId)
      else if (value !== '0x') throw new Error('refund: unrecognized registry wallet encoding')
    }
  }
  return byWallet
}

export async function captureSnapshot(config, blockNumber, rpc, token, extras = []) {
  const identity = JSON.parse(readFileSync(new URL('./redeploy-identities.json', import.meta.url))).g1b
  const h = config.deployment.sidequest
  const pinned = key => identity.addresses[`deployment.sidequest.${key}`]
  if (config.chainId !== 10143 || config.network !== 'monad-testnet' || h.block !== identity.sidequestBlock
    || ['factory', 'vault', 'distributor'].some(key => address(h[key]) !== address(pinned(key)))) throw new Error('refund: G1b identity mismatch')
  const client = createPublicClient({ transport: http(rpc, { timeout: 20_000, retryCount: 2 }) })
  if (await client.getChainId() !== 10143) throw new Error('refund: RPC must be chain 10143')
  const head = await client.getBlock({ blockTag: 'finalized' })
  const block = blockNumber ?? Number(head.number)
  if (!Number.isSafeInteger(block) || block < h.block || BigInt(block) > head.number) throw new Error('refund: snapshot must be a finalized G1b block')
  const fixed = await client.getBlock({ blockNumber: BigInt(block) })
  const logs = await readLogs(h.block, block, [h.vault, h.factory], token)
  const vaultLogs = logs.filter(log => address(log.address) === address(h.vault))
  const registryLogs = await readLogs(0, block, [config.erc8004.identity], token)
  const candidates = registryCandidates(registryLogs)
  const read = async (contract, abi, functionName, args, at = block) => {
    await new Promise(done => setTimeout(done, 150))
    try { return await client.readContract({ address: contract, abi, functionName, args, blockNumber: BigInt(at) }) }
    catch { throw new Error(`refund: ${functionName} read unavailable at block ${at} for ${args.map(String).join(',')}`) }
  }
  const deposits = decodeVaultLogs(vaultLogs).filter(event => event.eventName === 'Staked')
  const wallets = new Map()
  function add(wallet, source) {
    const key = address(wallet)
    if (!wallets.has(key)) wallets.set(key, new Set())
    wallets.get(key).add(source)
  }
  for (const wallet of extras) add(wallet, 'explicit-product-wallet')
  for (const deposit of deposits) {
    add(deposit.args.account, 'vault-account')
    add(deposit.args.payer, 'vault-payer')
  }
  for (const log of logs.filter(entry => address(entry.address) === address(h.factory))) {
    let event
    try { event = decodeEventLog({ abi: erc20Abi, data: log.data, topics: [log.topic0, log.topic1, log.topic2].filter(Boolean), strict: true }) }
    catch { continue }
    if (event.eventName === 'Transfer') {
      add(event.args.to, 'factory-transfer-recipient')
      add(event.args.from, 'factory-transfer-sender')
    }
  }
  const operatorProofs = {}
  const registry = []
  const cached = new Map()
  async function lookup(id, at) {
    const key = `${id}:${at}`
    if (!cached.has(key)) {
      const wallet = await read(config.erc8004.identity, registryAbi, 'getAgentWallet', [BigInt(id)], at)
      const owner = await read(config.erc8004.identity, registryAbi, 'ownerOf', [BigInt(id)], at)
      cached.set(key, { agentId: id, block: at, wallet: address(wallet), owner: address(owner) })
    }
    return cached.get(key)
  }
  for (const deposit of deposits) {
    const account = address(deposit.args.account)
    if (account === address(deposit.args.payer) || address(deposit.args.payer) === address(h.distributor)) continue
    const matches = []
    for (const id of candidates.get(account) ?? []) {
      // Registrations after a deposit cannot prove ownership at that deposit.
      const registered = registryLogs.find(log => log.topic1 === `0x${BigInt(id).toString(16).padStart(64, '0')}` && log.block_number <= deposit.block_number)
      if (!registered) continue
      const proof = await lookup(id, deposit.block_number)
      if (proof.wallet === account) matches.push(proof)
    }
    if (matches.length > 1 && new Set(matches.map(proof => proof.owner)).size > 1) throw new Error('refund: account has conflicting registry owners')
    if (matches.length > 0) operatorProofs[logKey(deposit)] = matches[0]
  }
  const productWallets = [...wallets.keys()]
  for (const account of productWallets) {
    for (const id of candidates.get(account) ?? []) {
      const proof = await lookup(id, block)
      if (proof.wallet !== account) continue
      registry.push(proof)
      add(proof.owner, 'registry-operator')
    }
  }
  const accounts = []
  for (const account of [...new Set(deposits.map(event => address(event.args.account)))].toSorted()) {
    const stake = await read(h.vault, oldVaultAbi, 'stakeOf', [account])
    const [unstaking, unlockAt] = await read(h.vault, oldVaultAbi, 'unstakeOf', [account])
    accounts.push({ account, stake: stake.toString(), unstaking: unstaking.toString(), unlockAt: Number(unlockAt) })
  }
  // Launch replaces these genesis allocations. Refunding them again would double the allocations.
  const exclusions = new Map([
    ['0x0000000000000000000000000000000000000000', 'zero/burn address'],
    [address(h.vault), 'old vault; represented by positions'],
    [address(h.distributor), 'old mining distributor; new mining reserve allocation'],
    [address(h.miningReserve), 'old mining reserve; new genesis allocation'],
    [address(h.teamVesting), 'old vesting; new genesis allocation'],
    ...Object.values(config.sidequest.allocation).map(wallet => [address(wallet), 'genesis allocation recipient; new genesis allocation']),
    ...Object.values(config.liquidity?.uniswapV4 ?? {}).map(wallet => [address(wallet), 'liquidity infrastructure; not a product wallet']),
    ...[h.feeSchedule, config.deployment.main.holding, config.deployment.main.evaluator].map(wallet => [address(wallet), 'old protocol contract; not a product wallet']),
  ])
  const looseBalances = []
  const excluded = []
  for (const [wallet, sources] of [...wallets.entries()].toSorted(([a], [b]) => a.localeCompare(b))) {
    const amount = await read(h.factory, erc20Abi, 'balanceOf', [wallet])
    const row = { wallet, amount: amount.toString(), sources: [...sources].toSorted() }
    if (amount > 0n && !exclusions.has(wallet) && !registry.some(proof => proof.wallet === wallet || proof.owner === wallet)) {
      const code = await client.getCode({ address: wallet, blockNumber: BigInt(block) })
      if (code && code !== '0x' && !/^0xef0100[0-9a-f]{40}$/i.test(code)) throw new Error(`refund: unclassified contract balance at ${wallet}; review product-wallet inventory`)
    }
    if (exclusions.has(wallet)) excluded.push({ ...row, reason: exclusions.get(wallet) })
    else looseBalances.push(row)
  }
  if ((await client.getBlock({ blockNumber: BigInt(block) })).hash !== fixed.hash) throw new Error('refund: snapshot block hash changed')
  return { chainId: 10143, block, blockHash: fixed.hash, timestamp: Number(fixed.timestamp),
    old: { vault: address(h.vault), factory: address(h.factory), distributor: address(h.distributor), registry: address(config.erc8004.identity) },
    vaultLogs, registryEvidence: { from: 0, through: block, logs: registryLogs.length, checksum: checksum(registryLogs) },
    operatorProofs, registry, accounts, looseBalances, excluded,
    totalStaked: (await read(h.vault, oldVaultAbi, 'totalStaked', [])).toString(),
    totalUnstaking: (await read(h.vault, oldVaultAbi, 'totalUnstaking', [])).toString() }
}

async function main() {
  const args = process.argv.slice(2)
  const options = { out: 'docs/evidence/testnet-g1c/refund-manifest.json', config: 'contracts/config/monad-testnet.json', extras: [] }
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    if (!['--out', '--config', '--block', '--wallet'].includes(key) || !args[i + 1]) throw new Error('refund: usage refund-manifest.mjs [--block N] [--config FILE] [--out FILE] [--wallet ADDRESS]')
    const value = args[++i]
    if (key === '--wallet') options.extras.push(address(value))
    else options[key.slice(2)] = value
  }
  if (!process.env.MONAD_TESTNET_RPC_URL || !process.env.HYPERSYNC_API_TOKEN) throw new Error('refund: set MONAD_TESTNET_RPC_URL and HYPERSYNC_API_TOKEN')
  const target = resolve(options.out)
  const evidence = target.replace(/\.json$/, '.snapshot.json')
  if (target === evidence || existsSync(target) || existsSync(evidence)) throw new Error('refund: output already exists or does not end in .json; choose a fresh path')
  const snapshot = await captureSnapshot(JSON.parse(readFileSync(options.config)), options.block ? Number(options.block) : undefined,
    process.env.MONAD_TESTNET_RPC_URL, process.env.HYPERSYNC_API_TOKEN, options.extras)
  const manifest = makeManifest(snapshot)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(evidence, JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx' })
  writeFileSync(target, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ block: snapshot.block, positions: manifest.positions.length, transfers: manifest.transfers.length, totals: manifest.totals, checksum: manifest.checksum }))
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  await main().catch(error => {
    console.error(error.message?.startsWith('refund:') ? error.message : 'refund: read unavailable; provider details suppressed')
    process.exitCode = 1
  })
}

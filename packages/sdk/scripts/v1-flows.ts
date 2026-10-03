/**
 * Testnet-only runner for every live row in the Hireling v1 flow matrix.
 *
 * Every protocol send is journaled: the signed bytes and nonce are persisted before broadcast, so a
 * restarted process resumes the exact transaction. The runner refuses any chain other than Monad testnet.
 * Required values are read by name from .env.local; no key is ever logged.
 */
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { type Hex, decodeEventLog, parseAbi, parseUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import * as sdk from '../src/index.ts'
import config from '../../../contracts/config/monad-testnet.json' with { type: 'json' }
import { ensureFlowDirectory, saveFlowState } from './flow-persistence.ts'
import { v1FlowArbitrators } from './v1-flow-keys.ts'

const names = [...sdk.V1_CORE_FLOWS, ...sdk.V1_HOSTED_FLOWS, ...sdk.V1_ADMIN_FLOWS, 'owed-blocklist', 'owed-gas']
if (process.argv[2] === '--list') { console.log(names.join('\n')); process.exit(0) }
const requested = (process.argv[2] === 'all' ? names.join(',') : process.argv[2] ?? 'hire,cancel,topup-paid').split(',').map(name => name.trim()).filter(Boolean)
for (const name of requested) if (!names.includes(name as typeof names[number])) throw new Error(`unknown v1 flow ${name}; use --list`)

const env = (name: string, optional = false) => {
  const value = process.env[name]
  if ((value === undefined || value === '') && !optional) throw new Error(`${name} is not set (.env.local)`)
  return value
}
async function main() {
const rpc = env('MONAD_TESTNET_RPC_URL')!
const network = 'monad-testnet' as const
const ctx = sdk.context(network, 'main', rpc)
if (ctx.deployment.chainId !== 10143 || ctx.stack.kind !== 'hireling-v1' || ctx.deployment.hireling === null)
  throw new Error('testnet v1 flows require a promoted Hireling v1 main pair')
const creator = sdk.wallet(network, privateKeyToAccount(env('TESTNET_CREATOR_PRIVATE_KEY') as Hex), rpc)
const worker = sdk.wallet(network, privateKeyToAccount(env('TESTNET_WORKER_PRIVATE_KEY') as Hex), rpc)
const relay = sdk.wallet(network, privateKeyToAccount(env('RELAY_PRIVATE_KEY') as Hex), rpc)
const arbiters = v1FlowArbitrators(config, process.env)
const arbitrator = sdk.wallet(network, arbiters.v1, rpc)
const legacyArbitrator = arbiters.legacy === undefined ? undefined : sdk.wallet(network, arbiters.legacy, rpc)
const explorer = 'https://testnet.monadscan.com/tx/'
const profile = env('V1_FLOW_PROFILE', true) ?? 'default'
if (!/^[A-Za-z0-9_-]{1,80}$/.test(profile)) throw new Error('V1_FLOW_PROFILE must be a short alphanumeric label')
const stateDir = new URL(`./.v1-flows/${profile}/`, import.meta.url)
ensureFlowDirectory(stateDir)
const stateUrl = new URL('journal.json', stateDir)
const lockUrl = new URL('runner.lock', stateDir)
if (existsSync(lockUrl)) {
  const pid = Number(readFileSync(lockUrl, 'utf8'))
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('invalid flow lock; inspect it before retrying')
  let alive = true
  try { process.kill(pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false }
  if (alive) throw new Error('another runner owns this flow journal')
  unlinkSync(lockUrl)
}
const lock = openSync(lockUrl, 'wx', 0o600)
writeFileSync(lock, String(process.pid)); closeSync(lock)
process.once('exit', () => unlinkSync(lockUrl))
process.once('SIGINT', () => process.exit(130))
process.once('SIGTERM', () => process.exit(143))

const load = (): sdk.FlowState => existsSync(stateUrl) ? sdk.parseFlowJson(readFileSync(stateUrl, 'utf8')) : { binding: '', values: {}, sends: {} }
const state = load()
const binding = sdk.hashText(sdk.flowJson({ deployment: ctx.deployment, creator: creator.account.address, worker: worker.account.address,
  relay: relay.account.address, arbitrator: arbitrator.account.address, reward: env('V1_FLOW_REWARD', true) ?? '1', bond: env('V1_FLOW_BOND', true) ?? '10' }))
if (state.binding !== '' && state.binding !== binding) throw new Error('flow journal belongs to a different testnet deployment or wallet set')
state.binding = binding
const save = (next: sdk.FlowState) => saveFlowState(stateDir, next)
const log = (label: string, hash: Hex) => console.log(`[${label}] ${explorer}${hash}`)
const journal = new sdk.FlowJournal(ctx, state, save, log)
if (relay.account.address.toLowerCase() !== ctx.deployment.relay.toLowerCase()) throw new Error('relay key does not match the promoted testnet config')

async function waitUntil(label: string, target: number) {
  for (;;) {
    const current = Number((await ctx.publicClient.getBlock()).timestamp)
    if (current >= target) return
    console.log(`[${label}] waiting ${target - current}s of chain time`)
    await new Promise(resolve => setTimeout(resolve, Math.min(30, target - current) * 1000))
  }
}

async function setupAgent(): Promise<bigint> {
  const saved = state.values['setup/agentId']
  if (typeof saved === 'bigint' && (await sdk.agentWallet(ctx, saved)).toLowerCase() === worker.account.address.toLowerCase()) return saved
  const configured = env('TESTNET_AGENT_ID', true)
  if (configured !== undefined) {
    const id = BigInt(configured)
    if ((await sdk.agentWallet(ctx, id)).toLowerCase() !== worker.account.address.toLowerCase()) throw new Error('TESTNET_AGENT_ID is owned by another wallet')
    state.values['setup/agentId'] = id; save(state); return id
  }
  const receipt = await journal.contract('setup/register', worker, ctx.deployment.identity, sdk.identityAbi, 'register', ['https://hireling.xyz/testnet-v1-worker'])
  let id: bigint | undefined
  for (const entry of receipt.logs) {
    if (entry.address.toLowerCase() !== ctx.deployment.identity.toLowerCase()) continue
    try {
      const event = decodeEventLog({ abi: parseAbi(['event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)']), data: entry.data, topics: entry.topics })
      if (event.args.to.toLowerCase() === worker.account.address.toLowerCase()) id = event.args.tokenId
    } catch { /* Other identity logs. */ }
  }
  if (id === undefined || (await sdk.agentWallet(ctx, id)).toLowerCase() !== worker.account.address.toLowerCase()) throw new Error('registration did not mint the worker identity')
  state.values['setup/agentId'] = id; save(state)
  return id
}

async function setupStake() {
  const h = ctx.deployment.hireling!
  const decimals = await ctx.publicClient.readContract({ address: h.factory, abi: sdk.factoryTokenAbi, functionName: 'decimals' })
  const target = parseUnits(env('V1_STAKE_TARGET', true) ?? '100', decimals)
  for (const [name, wallet] of [['creator', creator], ['worker', worker] ] as const) {
    const amount = await journal.once(`setup/${name}/stakeAmount`, async () => { const current = await sdk.getStake(ctx, wallet.account.address); return current.staked >= target ? 0n : target - current.staked })
    if (amount === 0n) continue
    const allowance = await ctx.publicClient.readContract({ address: h.factory, abi: sdk.factoryTokenAbi, functionName: 'allowance', args: [wallet.account.address, h.vault] })
    if (allowance < amount) await journal.contract(`setup/${name}/approve`, wallet, h.factory, sdk.factoryTokenAbi, 'approve', [h.vault, amount])
    await journal.contract(`setup/${name}/stake`, wallet, h.vault, sdk.stakeVaultAbi, 'stake', [amount])
  }
}

const rewardToken = ctx.deployment.rewardTokens[0]
if (rewardToken === undefined) throw new Error('testnet deployment has no configured reward token')
const rewardDecimals = await ctx.publicClient.readContract({ address: rewardToken, abi: sdk.factoryTokenAbi, functionName: 'decimals' })
const factoryDecimals = await ctx.publicClient.readContract({ address: ctx.deployment.hireling.factory, abi: sdk.factoryTokenAbi, functionName: 'decimals' })
const reward = parseUnits(env('V1_FLOW_REWARD', true) ?? '1', rewardDecimals)
const bond = parseUnits(env('V1_FLOW_BOND', true) ?? '10', factoryDecimals)
if (reward <= 0n || bond <= 0n) throw new Error('live money verification needs positive reward and bond amounts')
if (requested.includes('legacy-contest') && state.values['legacy-contest/done'] !== true && state.sends['legacy-contest/publish'] === undefined)
  await sdk.requireLegacyContestFactory(ctx, creator)
const hosted = requested.some(name => (sdk.V1_HOSTED_FLOWS as readonly string[]).includes(name))
const boardUrl = hosted ? env('V1_BOARD_URL')! : ''
const clients = new Map<string, ReturnType<typeof sdk.boardClient>>()
const call = async <T = any>(wallet: sdk.Wallet, tool: string, input: Record<string, unknown>): Promise<T> => {
  let client = clients.get(wallet.account.address)
  if (client === undefined) {
    client = sdk.boardClient(boardUrl); await client.signIn(wallet.account as import('viem').LocalAccount); clients.set(wallet.account.address, client)
  }
  return client.call<T>(tool, input)
}
if (hosted) {
  const info = await call<{ chainId: number; contracts: { stacks: { main: { holding: string } } } }>(creator, 'protocol_info', {})
  if (info.chainId !== 10143 || info.contracts.stacks.main.holding.toLowerCase() !== ctx.stack.holding.toLowerCase()) throw new Error('V1_BOARD_URL is not this testnet deployment')
}
const agentId = await setupAgent()
await setupStake()
for (const name of requested) {
  const deps = { ctx, journal, creator, worker, relay, arbitrator, ...(legacyArbitrator === undefined ? {} : { legacyArbitrator }), agentId, token: rewardToken,
    reward, bond, waitUntil, log: (text: string) => console.log(`[${name}] ${text}`) }
  if ((sdk.V1_CORE_FLOWS as readonly string[]).includes(name)) await sdk.runV1CoreFlow(deps, name as sdk.V1CoreFlow)
  else if ((sdk.V1_HOSTED_FLOWS as readonly string[]).includes(name)) await sdk.runV1HostedFlow({ ...deps, call }, name as sdk.V1HostedFlow)
  else if ((sdk.V1_ADMIN_FLOWS as readonly string[]).includes(name)) {
    const safeOwner = sdk.wallet(network, privateKeyToAccount(env('SAFE_BACKUP_TESTNET_PRIVATE_KEY') as Hex), rpc)
    await sdk.runV1AdminFlow({ ...deps, safeOwner }, name as sdk.V1AdminFlow)
  } else if (name.startsWith('owed-')) {
    const kind = name === 'owed-gas' ? 'gasBurner' as const : 'blocklist' as const
    const record = config as unknown as { deployment: { oddTokens?: { blocklist: Hex; gasBurner: Hex } } }
    const token = record.deployment.oddTokens?.[kind]
    if (token === undefined) throw new Error('G1 must promote the real testnet OddTokens addresses')
    const owner = sdk.wallet(network, privateKeyToAccount(env('TESTNET_ODD_OWNER_PRIVATE_KEY') as Hex), rpc)
    const decimals = await ctx.publicClient.readContract({ address: token, abi: sdk.factoryTokenAbi, functionName: 'decimals' })
    await sdk.runV1CoreFlow({ ...deps, token, reward: parseUnits(env('V1_FLOW_REWARD', true) ?? '1', decimals), refusingToken: { kind, owner } }, 'hire', name)
  }
  else throw new Error(`unknown v1 flow ${name}`)
}

}
try { await main() } catch (error) {
  const failure = error as { shortMessage?: string; message?: string }
  let message = (failure.shortMessage ?? failure.message ?? "live flow failed").split("\n")[0]!
  for (const [name, value] of Object.entries(process.env)) {
    if (value && /KEY|TOKEN|SECRET|RPC_URL/i.test(name)) message = message.replaceAll(value, "[redacted]")
  }
  console.error(message.replace(/https?:\/\/\S+/g, "[RPC]"))
  console.error("Flow journal preserved; retry the same case to reconcile its saved transaction.")
  process.exitCode = 1
}

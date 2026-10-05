/** C2 CLI. Setup funds only this independent testnet creator; start is reserved for Claude. */
import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { type Hex, encodeFunctionData, formatEther, formatUnits, getAddress, parseEther, parseUnits } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import config from '../../../contracts/config/monad-testnet.json' with { type: 'json' }
import * as sdk from '../src/index.ts'
import { utcDay } from '../src/demand-bot.ts'
import { ensureFlowDirectory } from './flow-persistence.ts'
import { createDemandRuntime, demandLog, safeDemandError } from './demand-bot-runtime.ts'
import { envLocal } from './lib/common.ts'
import { reportCliFailure } from './lib/cli-errors.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const directory = resolve(process.env.DEMAND_BOT_STATE_DIR ?? join(root, '.crew/demand'))
const command = process.argv[2] ?? 'status'
let running = true
const isRunning = () => running
process.on('SIGTERM', () => { running = false })
process.on('SIGINT', () => { running = false })

function ensureLock() {
  ensureFlowDirectory(pathToFileURL(`${directory}/`))
  if (process.env.DEMAND_BOT_LOCKED === '1') return true
  const args = ['--nonblock', '--no-fork', join(directory, 'journal.lock')]
  if (command === 'setup') args.push('flock', '--nonblock', '--no-fork', join(root, '.crew/deployer.lock'))
  args.push('bun', fileURLToPath(import.meta.url), command)
  const result = spawnSync('flock', args, { cwd: root, env: { ...process.env, DEMAND_BOT_LOCKED: '1' }, stdio: 'inherit' })
  process.exitCode = result.status ?? 1
  return false
}

function demandKey(): Hex {
  const file = join(root, '.env.local')
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : []
  const existing = lines.find(line => line.startsWith('DEMAND_BOT_PRIVATE_KEY='))?.slice('DEMAND_BOT_PRIVATE_KEY='.length) ?? process.env.DEMAND_BOT_PRIVATE_KEY
  if (existing !== undefined) return existing as Hex
  if (command !== 'setup') throw new Error('setup must create the demand identity first')
  const key = generatePrivateKey()
  const address = privateKeyToAccount(key).address
  const fd = openSync(file, 'a', 0o600)
  try {
    appendFileSync(fd, `\nDEMAND_BOT_PRIVATE_KEY=${key}\nDEMAND_BOT_ADDRESS=${address}\n`)
    fsyncSync(fd)
  } finally { closeSync(fd) }
  chmodSync(file, 0o600)
  return key
}

async function main() {
  if (!['setup', 'status', 'once', 'start'].includes(command)) throw new Error('unknown demand command')
  if (!ensureLock()) return
  const key = demandKey()
  const rpc = envLocal('MONAD_TESTNET_RPC_URL', 'https://testnet-rpc.monad.xyz')
  const runtime = createDemandRuntime(key, rpc, directory)
  const { ctx, token, account, store, journal } = runtime
  await runtime.validateChain()

  async function status(error?: string) {
    const [native, reward] = await Promise.all([ctx.publicClient.getBalance({ address: account.address }), sdk.balanceOf(ctx, token, account.address)])
    const day = utcDay(Math.floor(Date.now() / 1000))
    const report = {
      updatedAt: new Date().toISOString(), network: 'monad-testnet', chainId: 10143,
      creator: account.address, running: command === 'start' && running,
      mon: formatEther(native), mUSD: formatUnits(reward, 6),
      dailyCapMUsd: '12', utcDay: day,
      committedMUsd: formatUnits(store.bot.spend.committed[day] ?? 0n, 6), reservedMUsd: formatUnits(store.bot.spend.reserved[day] ?? 0n, 6),
      nextRequestAt: new Date(store.bot.nextRequestAt * 1000).toISOString(),
      operations: store.bot.operations.map(operation => ({ id: operation.id, kind: operation.intent.template.kind, requestId: operation.request?.requestId, taskId: operation.prepared?.taskId, jobId: operation.jobId?.toString(), reward: operation.quote?.amount, selected: operation.selected ?? false, closed: operation.closed, review: operation.review })),
      ...(error === undefined ? {} : { error }),
    }
    const temporary = join(directory, 'status.tmp')
    writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, join(directory, 'status.json'))
    if (command !== 'start') console.log(JSON.stringify(report, null, 2))
  }

  if (command === 'setup') {
    const deployer = sdk.wallet('monad-testnet', privateKeyToAccount(envLocal('DEPLOYER_PRIVATE_KEY') as Hex), rpc)
    if (getAddress(deployer.account.address) !== getAddress(config.hireling.allocation.ecosystem) || getAddress(deployer.account.address) === account.address) throw new Error('demand setup requires the configured ecosystem deployer and a distinct creator')
    const code = await ctx.publicClient.getCode({ address: account.address })
    if (code !== undefined && code !== '0x') throw new Error('demand creator must be a fresh independent EOA')
    const nativeAmount = await journal.once('setup/native-amount', async () => {
      const balance = await ctx.publicClient.getBalance({ address: account.address })
      return balance < parseEther('0.5') ? parseEther('0.5') - balance : 0n
    })
    const tokenAmount = await journal.once('setup/token-amount', async () => {
      const balance = await sdk.balanceOf(ctx, token, account.address)
      return balance < parseUnits('50', 6) ? parseUnits('50', 6) - balance : 0n
    })
    for (const [operation, amount, tx] of [
      ['setup/native', nativeAmount, { to: account.address, value: nativeAmount.toString(), data: '0x' as Hex }],
      ['setup/musd', tokenAmount, { to: token, value: '0', data: encodeFunctionData({ abi: sdk.factoryTokenAbi, functionName: 'transfer', args: [account.address, tokenAmount] }) }],
    ] as const) {
      if (amount === 0n) continue
      if (store.state.sends[operation] === undefined) {
        const latest = await ctx.publicClient.getTransactionCount({ address: deployer.account.address, blockTag: 'latest' })
        const pending = await ctx.publicClient.getTransactionCount({ address: deployer.account.address, blockTag: 'pending' })
        if (latest !== pending) throw new Error('deployer has pending sends; reconcile them before funding')
      }
      const receipt = await journal.send(operation, deployer, tx)
      demandLog('funded', { operation, creator: account.address, amount: amount.toString(), txHash: receipt.transactionHash, gasUsed: receipt.gasUsed.toString(), effectiveGasPrice: receipt.effectiveGasPrice.toString(), blockNumber: receipt.blockNumber.toString() })
    }
    await runtime.board.signIn(account)
    demandLog('board-auth', { result: 'pass', creator: account.address })
    await status()
    return
  }
  if (command === 'status') { await status(); return }
  do {
    let error: string | undefined
    try { await runtime.tick(isRunning) } catch (failure) { error = safeDemandError(failure); demandLog('attention', { error }) }
    try { await status(error) } catch { demandLog('attention', { error: 'status_unavailable' }) }
    if (command === 'once') { if (error !== undefined) process.exitCode = 1; return }
    for (let second = 0; second < 30 && isRunning(); second++) await new Promise(resolveWait => setTimeout(resolveWait, 1000))
  } while (isRunning())
  demandLog('stopped', { creator: account.address })
}

try { await main() } catch (failure) {
  reportCliFailure('Demand command failed', failure)
  process.exitCode = 1
}

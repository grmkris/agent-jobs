/** Real v1 bytecode on a local Monad fork, with the deployed ERC-8004 registries. Never broadcasts remotely. */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { type Abi, type Address, type Hex, createPublicClient, createWalletClient, encodeFunctionData, http, parseEther } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { monadTestnet } from 'viem/chains'
import { coreAbi, factoryV2Abi, hirelingHoldingAbi, stakeVaultAbi } from '../src/abi/index.ts'
import type { Ctx, Wallet } from '../src/actions.ts'
import { deployment } from '../src/deployment.ts'

export const hasAnvil = (() => { try { execFileSync('anvil', ['--version'], { stdio: 'ignore' }); return true } catch { return false } })()
export const forkEnabled = !!process.env.MONAD_TESTNET_RPC_URL && hasAnvil

function artifact(name: string) {
  return JSON.parse(readFileSync(new URL(`../../../contracts/out/${name}.sol/${name}.json`, import.meta.url), 'utf8')) as { abi: Abi; bytecode: { object: Hex } }
}

export async function startHirelingFork() {
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') { server.close(); reject(new Error('No local test port')); return }
      server.close(() => resolve(address.port))
    })
  })
  const url = `http://127.0.0.1:${port}`
  const node: ChildProcess = spawn('anvil', ['--fork-url', process.env.MONAD_TESTNET_RPC_URL!, '--network', 'monad', '--chain-id', '10143', '--port', String(port), '--silent'], { stdio: 'ignore' })
  const rpc = async (method: string, params: unknown[] = []) => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(2000) })
    const body = await response.json() as { result?: unknown; error?: { message: string } }
    if (body.error) throw new Error(body.error.message)
    return body.result
  }
  try {
    let ready = false
    for (let attempt = 0; attempt < 100; attempt++) {
      if (node.exitCode !== null) throw new Error('Local anvil exited before readiness')
      if (await rpc('eth_chainId').catch(() => undefined)) { ready = true; break }
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    if (!ready) throw new Error('Local anvil fork did not start')
    const publicClient = createPublicClient({ chain: monadTestnet, transport: http(url), pollingInterval: 10 })
    const wallet = () => createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain: monadTestnet, transport: http(url) })
    const admin = wallet(), creator = wallet(), worker = wallet(), contributor = wallet(), arbitrator = wallet()
    for (const account of [admin, creator, worker, contributor, arbitrator]) await rpc('anvil_setBalance', [account.account.address, `0x${parseEther('1000').toString(16)}`])
    async function deploy(name: string, args: unknown[] = []) {
      const a = artifact(name)
      const hash = await admin.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`Local ${name} deployment failed`)
      return receipt.contractAddress
    }
    const send = async (address: Address, abi: Abi, functionName: string, args: unknown[] = []) => {
      const receipt = await publicClient.waitForTransactionReceipt({ hash: await admin.writeContract({ address, abi, functionName, args }) })
      if (receipt.status !== 'success') throw new Error(`Local fixture ${functionName} failed`)
    }
    const d = deployment('monad-testnet')
    const implementation = await deploy('ERC8183WithAuthorization')
    const core = await deploy('ERC1967Proxy', [implementation, encodeFunctionData({ abi: coreAbi, functionName: 'initialize', args: [admin.account.address, admin.account.address] })])
    const factory = await deploy('Factory', ['Factory', 'FACTORY', [admin.account.address], [parseEther('1000000000')]])
    const feeSchedule = await deploy('FeeSchedule', [{ thresholds: [0n, parseEther('10000'), parseEther('100000'), parseEther('1000000')], bps: [3000, 1000, 300, 100], treasury: admin.account.address }])
    const vault = await deploy('StakeVault', [factory])
    const holding = await deploy('HirelingHolding', [core, vault, feeSchedule, d.identity, arbitrator.account.address, 120])
    const evaluator = await deploy('HirelingEvaluator', [core, holding, d.reputation])
    const t0 = Number((await publicClient.getBlock()).timestamp)
    const distributor = await deploy('EpochDistributor', [factory, vault, t0])
    const miningReserve = await deploy('MiningReserve', [factory, distributor, t0])
    const teamVesting = await deploy('TeamVesting', [admin.account.address, t0 + 86400, 86400 * 365, 86400])
    await send(core, coreAbi, 'setHookWhitelist', [holding, true])
    await send(holding, hirelingHoldingAbi, 'setEvaluator', [evaluator])
    await send(vault, stakeVaultAbi, 'bootstrapHolding', [holding])
    for (const account of [creator, worker, contributor]) await send(factory, factoryV2Abi, 'transfer', [account.account.address, parseEther('20000')])
    const stack = { kind: 'hireling-v1' as const, factory, holding, evaluator, openTokens: true }
    const ctx: Ctx = { publicClient, stack, deployment: { ...d, core, factory, stacks: { main: stack },
      hireling: { block: 0n, safe: admin.account.address, factory, vault, feeSchedule, distributor, miningReserve, teamVesting, t0 } } }
    return { ctx, admin: admin as Wallet, creator: creator as Wallet, worker: worker as Wallet, contributor: contributor as Wallet,
      arbitrator: arbitrator as Wallet, url, rpc, deploy, send, close: () => { node.kill() } }
  } catch (error) { node.kill(); throw error }
}

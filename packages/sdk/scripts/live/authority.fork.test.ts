/** Real deployed MetaMask/registry bytecode on a local Monad fork; never sends to the upstream RPC. */
import { spawn, type ChildProcess } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Hex, decodeEventLog, encodeFunctionData, parseEther } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { context, wallet } from '../../src/client.ts'
import { localTestPort } from '../../test/fork-port.ts'
import { advanceExecution, delegationHash, delegationTypedData, redeemCallsCalldata, type Delegation } from '../../src/delegation/index.ts'
import { agentWalletTypes, config } from '../privy/policy.ts'
import { fixtureAllowance, fixtureGrant, nestedRedemption, periodAbi, periodTerms } from './authority-grants.ts'
import { mintAbi, token } from './authority-allowance.ts'
import { registryAbi } from './authority-registration.ts'

const enabled = !!process.env.MONAD_TESTNET_RPC_URL

describe.skipIf(!enabled)('P0 authority on real Monad fork', () => {
  let node: ChildProcess
  let ctx: ReturnType<typeof context>
  let relay: ReturnType<typeof wallet>
  const operator = privateKeyToAccount(generatePrivateKey())
  const agent = privateKeyToAccount(generatePrivateKey())

  async function rpc(method: string, params: unknown[] = []) {
    return ctx.publicClient.request({ method: method as never, params: params as never })
  }
  async function send(to: `0x${string}`, data: Hex, authorizationList?: Parameters<typeof relay.sendTransaction>[0]['authorizationList']) {
    const hash = await relay.sendTransaction({ to, data, gas: 2_000_000n, ...(authorizationList ? { authorizationList } : {}) })
    const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 })
    expect(receipt.status).toBe('success')
    return receipt
  }
  async function sign(account: typeof operator, grant: Delegation): Promise<Delegation> {
    return { ...grant, signature: await account.signTypedData(JSON.parse(delegationTypedData(ctx.deployment, grant))) }
  }
  async function at(timestamp: number) {
    await rpc('evm_setNextBlockTimestamp', [timestamp])
    await rpc('evm_mine')
  }

  beforeAll(async () => {
    const port = await localTestPort()
    const url = `http://127.0.0.1:${port}`
    node = spawn('anvil', ['--fork-url', process.env.MONAD_TESTNET_RPC_URL!, '--network', 'monad', '--chain-id', '10143',
      '--accounts', '0', '--compute-units-per-second', '100', '--no-fork-node-info', '--port', String(port), '--silent'], { stdio: 'ignore' })
    ctx = context('monad-testnet', 'main', url)
    relay = wallet('monad-testnet', privateKeyToAccount(generatePrivateKey()), url)
    const until = Date.now() + 90_000
    while (Date.now() < until) {
      if (await ctx.publicClient.getChainId().catch(() => 0)) break
      if (node.exitCode !== null) throw new Error('Local P0 anvil stopped before readiness')
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    expect(await ctx.publicClient.getChainId()).toBe(10143)
    await rpc('anvil_setBalance', [relay.account.address, `0x${parseEther('100').toString(16)}`])
    for (const account of [operator, agent]) {
      const authorization = await account.signAuthorization({ contractAddress: ctx.deployment.delegation.delegator, chainId: 10143, nonce: 0 })
      await send(account.address, '0x', [authorization])
    }
  }, 120_000)
  afterAll(() => { node?.kill() })

  it('mints to the operator DeleGator, accepts upgraded agent consent, and limits registration to two calls', async () => {
    const identity = ctx.deployment.identity
    const now = Number((await ctx.publicClient.getBlock()).timestamp)
    const grant = await sign(operator, fixtureGrant(operator.address, relay.account.address, 1n, [identity],
      ['register(string)', 'setAgentWallet(uint256,address,uint256,bytes)'], 2, now + 600))
    const data = encodeFunctionData({ abi: registryAbi, functionName: 'register', args: ['https://hireling.xyz/fixtures/local-p0'] })
    const receipt = await send(ctx.deployment.delegation.manager, redeemCallsCalldata(grant, [{ target: identity, value: 0n, callData: data }]))
    const event = receipt.logs.flatMap(log => {
      try {
        const decoded = decodeEventLog({ abi: registryAbi, data: log.data, topics: log.topics })
        return decoded.eventName === 'Registered' ? [decoded.args as unknown as { agentId: bigint }] : []
      } catch { return [] }
    })[0]!
    const deadline = BigInt(now + 300)
    const signature = await agent.signTypedData({ domain: { name: 'ERC8004IdentityRegistry', version: '1', chainId: 10143, verifyingContract: identity },
      types: agentWalletTypes, primaryType: 'AgentWalletSet', message: { agentId: event.agentId, newWallet: agent.address, owner: operator.address, deadline } })
    const consent = encodeFunctionData({ abi: registryAbi, functionName: 'setAgentWallet', args: [event.agentId, agent.address, deadline, signature] })
    await send(ctx.deployment.delegation.manager, redeemCallsCalldata(grant, [{ target: identity, value: 0n, callData: consent }]))
    expect(await ctx.publicClient.readContract({ address: identity, abi: registryAbi, functionName: 'ownerOf', args: [event.agentId] })).toBe(operator.address)
    expect(await ctx.publicClient.readContract({ address: identity, abi: registryAbi, functionName: 'getAgentWallet', args: [event.agentId] })).toBe(agent.address)
    await expect(ctx.publicClient.call({ account: relay.account, to: ctx.deployment.delegation.manager,
      data: redeemCallsCalldata(grant, [{ target: identity, value: 0n, callData: data }]) })).rejects.toThrow('LimitedCallsEnforcer')
  }, 120_000)

  it('proves the exact 25 mUSD fixed weekly allowance start, cap, recipient, token, rollover and 30-day expiry', async () => {
    const manager = ctx.deployment.delegation.manager
    await send(token, encodeFunctionData({ abi: mintAbi, functionName: 'mint', args: [operator.address, 100_000_000n] }))
    const start = Number((await ctx.publicClient.getBlock()).timestamp) + 60
    const work = await sign(agent, fixtureGrant(agent.address, relay.account.address, 2n, [manager], ['redeemDelegations(bytes[],bytes32[],bytes[])'], 100, start + 31 * 86400))
    const allowance = await sign(operator, fixtureAllowance(operator.address, agent.address, token, 3n, start, 604800))
    const terms = periodTerms(token, 25_000_000n, 604800, start)
    expect(await ctx.publicClient.readContract({ address: config.delegation.enforcers.erc20PeriodTransfer, abi: periodAbi,
      functionName: 'getTermsInfo', args: [terms] })).toEqual([token, 25_000_000n, 604800n, BigInt(start)])
    const pull = nestedRedemption(work, allowance, advanceExecution(token, agent.address, 25_000_000n))
    const call = (data: Hex) => ctx.publicClient.call({ account: relay.account, to: manager, data })
    await expect(call(pull)).rejects.toThrow('transfer-not-started')
    await at(start)
    await expect(call(nestedRedemption(work, allowance, advanceExecution(token, operator.address, 1n)))).rejects.toThrow('AllowedCalldataEnforcer')
    await expect(call(nestedRedemption(work, allowance, advanceExecution(config.deployment.rewardTokens[1], agent.address, 1n)))).rejects.toThrow('invalid-contract')
    await send(manager, pull)
    await expect(call(nestedRedemption(work, allowance, advanceExecution(token, agent.address, 1n)))).rejects.toThrow('transfer-amount-exceeded')
    await at(start + 604800)
    expect(await ctx.publicClient.readContract({ address: config.delegation.enforcers.erc20PeriodTransfer, abi: periodAbi,
      functionName: 'getAvailableAmount', args: [delegationHash(allowance), manager, terms] })).toEqual([25_000_000n, true, 2n])
    await send(manager, pull)
    await at(start + 30 * 86400 + 1)
    await expect(call(pull)).rejects.toThrow('TimestampEnforcer')
  }, 180_000)
})

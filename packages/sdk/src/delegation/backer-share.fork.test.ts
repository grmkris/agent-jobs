/** Deployed enforcers on a local Monad fork. The coordinator runs this suite; all sends stay on anvil. */
import { spawn, type ChildProcess } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestClient, decodeEventLog, encodeFunctionData, http, parseEther, type Hex, type TestClient } from 'viem'
import { monadTestnet } from 'viem/chains'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { context, wallet } from '../client.ts'
import { identityAbi } from '../abi/identity.ts'
import { BACKER_SHARE_KEY, encodeBackerShare, prepareBackerShare } from '../backer-share.ts'
import { localTestPort } from '../../test/fork-port.ts'
import { buildGrant } from './grants.ts'
import { delegationTypedData, disableCalldata, redeemCallsCalldata, type Delegation } from './index.ts'

describe.skipIf(!process.env.MONAD_TESTNET_RPC_URL)('standing backer share on a Monad testnet fork', () => {
  let node: ChildProcess
  let ctx: ReturnType<typeof context>
  let relay: ReturnType<typeof wallet>
  let owner: ReturnType<typeof wallet>
  let test: TestClient<'anvil'>
  let agentId: bigint
  let work: Delegation
  const operator = privateKeyToAccount(generatePrivateKey())
  const agent = privateKeyToAccount(generatePrivateKey())

  async function sign(account: typeof operator, grant: Delegation): Promise<Delegation> {
    return { ...grant, signature: await account.signTypedData(JSON.parse(delegationTypedData(ctx.deployment, grant))) }
  }
  async function send(client: typeof relay, to: Hex, data: Hex) {
    const hash = await client.sendTransaction({ to, data, gas: 2_000_000n })
    const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 })
    expect(receipt.status).toBe('success')
    return receipt
  }
  function redeem(grant: Delegation, data: Hex) {
    const inner = redeemCallsCalldata(grant, [{ target: ctx.deployment.identity, value: 0n, callData: data }])
    return redeemCallsCalldata(work, [{ target: ctx.deployment.delegation.manager, value: 0n, callData: inner }])
  }
  async function permission(salt: bigint, calls = 2, duration = 600) {
    const start = Number((await ctx.publicClient.getBlock()).timestamp)
    return sign(
      operator,
      buildGrant(ctx, {
        kind: 'permission',
        delegator: operator.address,
        agent: agent.address,
        salt,
        start,
        expiry: start + duration,
        terms: { type: 'sidequest:backer-share', registry: ctx.deployment.identity, agentId, calls },
      }),
    )
  }
  const share = (bps: number) => prepareBackerShare(ctx.deployment.identity, agentId, bps).data
  const call = (data: Hex) =>
    ctx.publicClient.call({ account: relay.account, to: ctx.deployment.delegation.manager, data })

  beforeAll(async () => {
    const port = await localTestPort()
    const url = `http://127.0.0.1:${port}`
    node = spawn(
      'anvil',
      [
        '--fork-url',
        process.env.MONAD_TESTNET_RPC_URL!,
        '--network',
        'monad',
        '--chain-id',
        '10143',
        '--accounts',
        '0',
        '--compute-units-per-second',
        '100',
        '--no-fork-node-info',
        '--port',
        String(port),
        '--silent',
      ],
      { stdio: 'ignore' },
    )
    const initial = context('monad-testnet', 'main', url)
    relay = wallet('monad-testnet', privateKeyToAccount(generatePrivateKey()), url)
    owner = wallet('monad-testnet', operator, url)
    ctx = { ...initial, deployment: { ...initial.deployment, relay: relay.account.address } }
    test = createTestClient({ mode: 'anvil', transport: http(url) })
    const until = Date.now() + 90_000
    while (Date.now() < until) {
      if (await ctx.publicClient.getChainId().catch(() => 0)) break
      if (node.exitCode !== null) throw new Error('Local backer-share anvil stopped before readiness')
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    expect(await ctx.publicClient.getChainId()).toBe(monadTestnet.id)
    for (const account of [relay.account, operator, agent])
      await test.setBalance({ address: account.address, value: parseEther('100') })
    for (const account of [operator, agent]) {
      const authorization = await account.signAuthorization({
        contractAddress: ctx.deployment.delegation.delegator,
        chainId: 10143,
        nonce: 0,
      })
      const hash = await relay.sendTransaction({
        to: account.address,
        data: '0x',
        gas: 100_000n,
        authorizationList: [authorization],
      })
      expect((await ctx.publicClient.waitForTransactionReceipt({ hash })).status).toBe('success')
    }
    const receipt = await send(
      owner,
      ctx.deployment.identity,
      encodeFunctionData({
        abi: identityAbi,
        functionName: 'register',
        args: ['https://sidequest.exchange/fixtures/backer-share'],
      }),
    )
    const registered = receipt.logs.flatMap((log) => {
      try {
        const event = decodeEventLog({ abi: identityAbi, data: log.data, topics: log.topics })
        return event.eventName === 'Registered' ? [event.args.agentId] : []
      } catch {
        return []
      }
    })
    if (registered.length !== 1) throw new Error('Expected one operator-owned agent')
    agentId = registered[0]!
    expect(
      await ctx.publicClient.readContract({
        address: ctx.deployment.identity,
        abi: identityAbi,
        functionName: 'ownerOf',
        args: [agentId],
      }),
    ).toBe(operator.address)
    work = await sign(
      agent,
      buildGrant(ctx, {
        kind: 'agent-work',
        delegator: agent.address,
        salt: 1n,
        start: Number((await ctx.publicClient.getBlock()).timestamp),
      }),
    )
  }, 120_000)
  afterAll(() => {
    node?.kill()
  })

  it('redeems twice and refuses another ID/key, exhausted calls, expiry, and disabled authority', async () => {
    const manager = ctx.deployment.delegation.manager
    const granted = await permission(2n)
    await send(relay, manager, redeem(granted, share(1)))
    const wrongId = prepareBackerShare(ctx.deployment.identity, agentId + 1n, 1).data
    const wrongKey = encodeFunctionData({
      abi: identityAbi,
      functionName: 'setMetadata',
      args: [agentId, 'sidequest.otherSetting', encodeBackerShare(1)],
    })
    await expect(call(redeem(granted, wrongId))).rejects.toThrow('AllowedCalldataEnforcer')
    await expect(call(redeem(granted, wrongKey))).rejects.toThrow('AllowedCalldataEnforcer')
    await send(relay, manager, redeem(granted, share(10000)))
    expect(
      await ctx.publicClient.readContract({
        address: ctx.deployment.identity,
        abi: identityAbi,
        functionName: 'getMetadata',
        args: [agentId, BACKER_SHARE_KEY],
      }),
    ).toBe(encodeBackerShare(10000))
    await expect(call(redeem(granted, share(0)))).rejects.toThrow('LimitedCallsEnforcer')
    const expires = await permission(3n, 2, 60)
    await test.setNextBlockTimestamp({ timestamp: (await ctx.publicClient.getBlock()).timestamp + 61n })
    await test.mine({ blocks: 1 })
    await expect(call(redeem(expires, share(0)))).rejects.toThrow('TimestampEnforcer')
    const disabled = await permission(4n)
    await expect(call(redeem(disabled, share(0)))).resolves.toBeDefined()
    await send(owner, manager, disableCalldata(disabled))
    await expect(call(redeem(disabled, share(0)))).rejects.toThrow()
  }, 120_000)
})

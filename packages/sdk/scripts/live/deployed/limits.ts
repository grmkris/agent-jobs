import { type Address, type Hex, encodeFunctionData, toHex } from 'viem'
import * as sdk from '../../../src/index.ts'
import { periodAbi } from '../authority-grants.ts'
import { ORIGIN } from './guards.ts'
import { deployedFork } from './fork.ts'
import { verifyAtomic } from './atomic.ts'
import { Runtime, object, text, type Proof } from './runtime.ts'
import { ensureAllowance } from './worker.ts'
import { confirmGrant } from './signing.ts'
import { decodeGrantBatch } from '../../../../board/src/hire-batch.ts'

interface StoredGrant {
  hash: Hex
  delegation: unknown
  status: string
}

export async function grants(runtime: Runtime): Promise<StoredGrant[]> {
  const recovery = await runtime.browser.api<{ grants: StoredGrant[] }>(`/api/agents/${runtime.agent.id}/recovery`)
  return recovery.grants
}

async function chainLimits(runtime: Runtime): Promise<Record<string, unknown>> {
  const { chain } = runtime
  const inventory = await grants(runtime)
  const status = await runtime.browser.api<{
    allowances: Array<{
      hash: Hex
      token: Address
      limit: string
      left: string
      expiresAt: number
      periodEnd: number
    }>
  }>(`/api/agents/${runtime.agent.id}`)
  const active = status.allowances.find(
    (row) => row.token.toLowerCase() === chain.ctx.deployment.rewardTokens[0]!.toLowerCase(),
  )
  const published = runtime.run.get<{ txHash: Hex }>('a03/job')
  if (active === undefined || published === undefined || !inventory.some((row) => row.hash === active.hash))
    throw new Error('P8_LIVE_ALLOWANCE_GRANTS_UNAVAILABLE')
  // Recovery inventory intentionally omits signatures. Use the actual signed receipt calldata.
  const transaction = await chain.ctx.publicClient.getTransaction({ hash: published.txHash })
  const entries = decodeGrantBatch(transaction.input)
  const work = entries[0]!.grant
  const allowance = decodeGrantBatch(entries[0]!.execution.callData)[0]!.grant
  if (sdk.delegationHash(allowance) !== active.hash) throw new Error('P8_LIVE_ALLOWANCE_GRANTS_CHANGED')
  const period = allowance.caveats.find(
    (item) =>
      item.enforcer.toLowerCase() === chain.ctx.deployment.delegation.enforcers.erc20PeriodTransfer.toLowerCase(),
  )
  if (period === undefined) throw new Error('P8_PERIOD_ENFORCER_MISSING')
  const terms = await chain.ctx.publicClient.readContract({
    address: period.enforcer,
    abi: periodAbi,
    functionName: 'getTermsInfo',
    args: [period.terms],
  })
  if (
    terms[0].toLowerCase() !== active.token.toLowerCase() ||
    terms[1] !== BigInt(active.limit) ||
    terms[2] !== 604800n ||
    BigInt(active.expiresAt) !== terms[3] + 2592000n
  )
    throw new Error('P8_WRONG_FIXED_WEEK_OR_EXPIRY')
  const nested = (token: Address, recipient: Address) =>
    sdk.redeemCallsCalldata(work, [
      {
        target: chain.ctx.deployment.delegation.manager,
        value: 0n,
        callData: sdk.redeemCallsCalldata(allowance, [sdk.advanceExecution(token, recipient, 1n)]),
      },
    ])
  const refused = async (data: Hex, reason: string) => {
    try {
      await chain.ctx.publicClient.call({
        account: chain.ctx.deployment.relay,
        to: chain.ctx.deployment.delegation.manager,
        data,
      })
    } catch (error) {
      if (String(error).includes(reason)) return
      throw new Error('P8_WRONG_REFUSAL_LAYER', { cause: error })
    }
    throw new Error('P8_FORBIDDEN_ALLOWANCE_CALL_ACCEPTED')
  }
  await refused(nested(active.token, runtime.agent.operator), 'AllowedCalldataEnforcer')
  // The deployed manager's target allow-list rejects the wrong token before
  // the token contract's own address check can run.
  await refused(nested(chain.ctx.deployment.rewardTokens[1]!, runtime.agent.address), 'AllowedTargetsEnforcer')
  const fork = await deployedFork(await chain.ctx.publicClient.getBlockNumber())
  try {
    const read = () =>
      fork.client.readContract({
        address: period.enforcer,
        abi: periodAbi,
        functionName: 'getAvailableAmount',
        args: [active.hash, chain.ctx.deployment.delegation.manager, period.terms],
      })
    await fork.rpc('evm_setNextBlockTimestamp', [active.periodEnd])
    await fork.rpc('evm_mine')
    if ((await read())[0] !== terms[1]) throw new Error('P8_FIXED_PERIOD_DID_NOT_RESET')
    await fork.rpc('anvil_impersonateAccount', [runtime.agent.address])
    await fork.rpc('anvil_setBalance', [runtime.agent.address, toHex(10n ** 20n)])
    const amount = sdk.redeemCallsCalldata(allowance, [
      sdk.advanceExecution(active.token, runtime.agent.address, terms[1]),
    ])
    // Real token mint only on the local fork, to make the cap fixture independent of operator funding.
    const mint = encodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'mint',
          stateMutability: 'nonpayable',
          inputs: [
            { name: 'to', type: 'address' },
            { name: 'amount', type: 'uint256' },
          ],
          outputs: [],
        },
      ],
      functionName: 'mint',
      args: [runtime.agent.operator, terms[1] * 2n],
    })
    const mintHash = await fork.rpc<Hex>('eth_sendTransaction', [
      { from: runtime.agent.address, to: active.token, data: mint, gas: '0x30d40' },
    ])
    if ((await fork.client.waitForTransactionReceipt({ hash: mintHash })).status !== 'success')
      throw new Error('P8_LOCAL_REWARD_FIXTURE_FUNDING_REFUSED')
    const hash = await fork.rpc<Hex>('eth_sendTransaction', [
      {
        from: runtime.agent.address,
        to: chain.ctx.deployment.delegation.manager,
        data: amount,
        gas: '0xf4240',
      },
    ])
    if ((await fork.client.waitForTransactionReceipt({ hash })).status !== 'success' || (await read())[0] !== 0n)
      throw new Error('P8_PERIOD_CAP_NOT_CONSUMED')
    const excess = sdk.redeemCallsCalldata(allowance, [sdk.advanceExecution(active.token, runtime.agent.address, 1n)])
    let excessRefused = false
    try {
      await fork.client.call({
        account: runtime.agent.address,
        to: chain.ctx.deployment.delegation.manager,
        data: excess,
      })
    } catch (error) {
      excessRefused = String(error).includes('transfer-amount-exceeded')
    }
    if (!excessRefused) throw new Error('P8_LOCAL_OVER_CAP_ACCEPTED')
    await fork.rpc('evm_setNextBlockTimestamp', [active.periodEnd + 604800])
    await fork.rpc('evm_mine')
    if ((await read())[0] !== terms[1]) throw new Error('P8_SECOND_PERIOD_DID_NOT_RESET')
    await fork.rpc('evm_setNextBlockTimestamp', [active.expiresAt + 1])
    await fork.rpc('evm_mine')
    let expired = false
    try {
      await fork.client.call({
        account: runtime.agent.address,
        to: chain.ctx.deployment.delegation.manager,
        data: excess,
      })
    } catch (error) {
      expired = String(error).includes('TimestampEnforcer')
    }
    if (!expired) throw new Error('P8_EXPIRED_ALLOWANCE_ACCEPTED')
    return {
      allowanceHash: active.hash,
      duration: terms[2].toString(),
      expiresAt: active.expiresAt,
      liveRefusals: ['wrong recipient', 'wrong token'],
      timeTier: 'real signed browser allowance on a local fork of deployed state; no public timestamp manipulation',
      forkChecks: [
        'period rollover',
        'full cap consumption',
        'over-cap refusal',
        'next period rollover',
        '30-day expiry refusal',
      ],
    }
  } finally {
    await fork.close()
  }
}

export async function limits(runtime: Runtime): Promise<Proof> {
  await runtime.login()
  await ensureAllowance(runtime)
  const coding = await runtime.coding()
  const time = await chainLimits(runtime)
  const { chain, run } = runtime
  const base =
    run.get<Record<string, unknown>>('a04/offer') ??
    run.set('a04/offer', {
      title: `P8 fixture concurrent limit ${run.get<string>('run-id')!}`,
      brief: 'Fixture near-cap concurrent hire. Deliver the deployed Holding address.',
      acceptanceCriteria: ['The configured Holding address on chain 10143.'],
      token: chain.ctx.deployment.rewardTokens[0]!,
      reward: '12',
      mode: 'hire',
      creatorBond: '0',
      workerBond: '0',
      deliveryDeadline: Number((await chain.ctx.publicClient.getBlock()).timestamp) + 6 * 3600,
      windows: sdk.minimumOfferWindows(await sdk.readWindowBounds(chain.ctx)),
      deliverable: { accepts: ['onchain'] },
    })
  const results = await Promise.all([
    runtime.write(coding, 'create_task', { ...base, title: `${base.title} A` }, 'a04-concurrent-a', 1_500_000n),
    runtime.write(coding, 'create_task', { ...base, title: `${base.title} B` }, 'a04-concurrent-b', 1_500_000n),
  ])
  if (
    results.filter((result) => result.status === 'confirmed').length !== 1 ||
    results.filter((result) => result.status === 'approval').length !== 1
  )
    throw new Error('P8_CONCURRENT_LIMIT_NOT_ONE_HIRE_ONE_APPROVAL')
  const pending = object(results.find((result) => result.status === 'approval')!.approval)
  const approvalId = text(pending.id)
  await runtime.browser.page.goto(`${ORIGIN}/agent/${runtime.agent.agent_id}?tab=approvals`)
  const section = runtime.browser.page.locator('section').filter({ hasText: text(pending.operation_id) })
  await section.getByRole('button', { name: 'Review exact budget', exact: true }).click()
  await chain.reserve('a04/operator-approval', 1_500_000n)
  const reply = runtime.browser.page.waitForResponse(
    (response) => new URL(response.url()).pathname === `/api/approvals/${approvalId}/decide`,
  )
  await section.getByRole('button', { name: 'Sign and approve hire', exact: true }).click()
  await confirmGrant(runtime.browser, chain.ctx, `/api/approvals/${approvalId}/prepare`, {
    kind: 'allowance-once',
    delegator: runtime.agent.operator,
    agent: runtime.agent.address,
    token: chain.ctx.deployment.rewardTokens[0]!,
    amount: 12_000_000n,
  })
  const body = (await (await reply).json()) as { ok?: boolean; result?: unknown }
  if (body.ok !== true || object(body.result).status !== 'confirmed')
    throw new Error('P8_EXACT_OPERATOR_APPROVAL_NOT_EXECUTED')
  const approvedHash = text(object(object(object(body.result).result).sponsorship).txHash) as Hex
  await chain.finish('a04/operator-approval', [approvedHash])
  const approved = await verifyAtomic(runtime, approvedHash)
  if (approved.params.reward !== 12_000_000n) throw new Error('P8_ONE_OFF_AMOUNT_CHANGED')
  const hashes = [
    approvedHash,
    text(object(object(results.find((result) => result.status === 'confirmed')!.result).sponsorship).txHash) as Hex,
  ]
  return {
    checks: [
      'live wrong token and recipient refused',
      'fixed-period rollover, cap and expiry on deployed-state fork',
      'two concurrent near-cap hires yield one publish and one Approval',
      'browser signs exact one-off allowance; approval atomically escrows the unchanged amount',
    ],
    txHashes: hashes,
    details: {
      ...time,
      approvalId,
      exactAmount: approved.params.reward.toString(),
      token: approved.params.token,
    },
  }
}

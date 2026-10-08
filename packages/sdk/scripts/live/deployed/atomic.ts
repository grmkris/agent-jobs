import { type Hex, decodeFunctionData, encodeFunctionData, erc20Abi, parseEventLogs } from 'viem'
import * as sdk from '../../../src/index.ts'
import { decodeGrantBatch, redeemGrantBatch } from '../../../../board/src/hire-batch.ts'
import { periodAbi } from '../authority-grants.ts'
import { required } from './guards.ts'
import { deployedFork } from './fork.ts'
import { Runtime, object, text, type Proof } from './runtime.ts'
import { ensureAllowance } from './worker.ts'

/** Inspect actual relay calldata and the three economic events in its one receipt. */
export async function verifyAtomic(runtime: Runtime, hash: Hex) {
  const { chain } = runtime
  const receipt = await chain.record(hash)
  if (receipt.status !== 'success') throw new Error('P8_ATOMIC_PUBLISH_REVERTED')
  const tx = await chain.ctx.publicClient.getTransaction({ hash })
  if (
    tx.from.toLowerCase() !== chain.ctx.deployment.relay.toLowerCase() ||
    tx.to?.toLowerCase() !== chain.ctx.deployment.delegation.manager.toLowerCase()
  )
    throw new Error('P8_ATOMIC_RELAY_BINDING_MISMATCH')
  const entries = decodeGrantBatch(tx.input)
  if (entries.length !== 3) throw new Error('P8_NOT_THREE_ORDERED_HIRE_EXECUTIONS')
  const [pull, approval, publish] = entries
  const inner = decodeGrantBatch(pull!.execution.callData)
  if (inner.length !== 1) throw new Error('P8_ALLOWANCE_PULL_NOT_SINGLE')
  const transfer = decodeFunctionData({ abi: erc20Abi, data: inner[0]!.execution.callData })
  const approve = decodeFunctionData({ abi: erc20Abi, data: approval!.execution.callData })
  const published = decodeFunctionData({
    abi: sdk.sidequestHoldingAbi,
    data: publish!.execution.callData,
  })
  if (
    transfer.functionName !== 'transfer' ||
    approve.functionName !== 'approve' ||
    published.functionName !== 'publish'
  )
    throw new Error('P8_WRONG_HIRE_EXECUTION_ORDER')
  const params = published.args[0]
  const agent = runtime.agent.address
  const operator = runtime.agent.operator
  const holding = chain.ctx.stack.holding
  if (
    inner[0]!.grant.delegator.toLowerCase() !== operator.toLowerCase() ||
    inner[0]!.grant.delegate.toLowerCase() !== agent.toLowerCase() ||
    transfer.args[0].toLowerCase() !== agent.toLowerCase() ||
    transfer.args[1] !== params.reward ||
    approve.args[0].toLowerCase() !== holding.toLowerCase() ||
    approve.args[1] !== params.reward ||
    inner[0]!.execution.target.toLowerCase() !== params.token.toLowerCase() ||
    approval!.execution.target.toLowerCase() !== params.token.toLowerCase() ||
    publish!.execution.target.toLowerCase() !== holding.toLowerCase()
  )
    throw new Error('P8_ATOMIC_TOKEN_AMOUNT_OR_RECIPIENT_CHANGED')
  const transfers = parseEventLogs({
    abi: erc20Abi,
    logs: receipt.logs,
    eventName: 'Transfer',
  }).filter((log) => log.address.toLowerCase() === params.token.toLowerCase())
  const exact = (from: string, to: string) =>
    transfers.filter(
      (log) =>
        log.args.from.toLowerCase() === from.toLowerCase() &&
        log.args.to.toLowerCase() === to.toLowerCase() &&
        log.args.value === params.reward,
    ).length === 1
  const logs = parseEventLogs({
    abi: sdk.sidequestHoldingAbi,
    logs: receipt.logs,
    eventName: 'Published',
  }).filter(
    (log) =>
      log.address.toLowerCase() === holding.toLowerCase() && log.args.creator.toLowerCase() === agent.toLowerCase(),
  )
  if (!exact(operator, agent) || !exact(agent, holding) || logs.length !== 1)
    throw new Error('P8_ATOMIC_ESCROW_EVENTS_MISSING')
  return { tx, receipt, entries, params, jobId: logs[0]!.args.jobId }
}

/** Failed publish rollback uses real deployed bytecode on a fork, labelled separately. */
async function rollback(runtime: Runtime, transaction: Hex, blockNumber: bigint): Promise<void> {
  const fork = await deployedFork(blockNumber)
  try {
    const ctx = { ...runtime.chain.ctx, publicClient: fork.client }
    const tx = await runtime.chain.ctx.publicClient.getTransaction({ hash: transaction })
    const { params, entries } = await verifyAtomic(runtime, transaction)
    const addresses = [runtime.agent.operator, runtime.agent.address, ctx.stack.holding]
    const balances = () =>
      Promise.all(
        addresses.map((address) =>
          fork.client.readContract({
            address: params.token,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [address],
          }),
        ),
      )
    const approval = () =>
      fork.client.readContract({
        address: params.token,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [runtime.agent.address, ctx.stack.holding],
      })
    const before = await balances()
    const allowance = await approval()
    const pull = decodeGrantBatch(entries[0]!.execution.callData)[0]!.grant
    const period = pull.caveats.find(
      (item) => item.enforcer.toLowerCase() === ctx.deployment.delegation.enforcers.erc20PeriodTransfer.toLowerCase(),
    )!
    const available = () =>
      fork.client.readContract({
        address: period.enforcer,
        abi: periodAbi,
        functionName: 'getAvailableAmount',
        args: [sdk.delegationHash(pull), ctx.deployment.delegation.manager, period.terms],
      })
    const beforeAvailable = (await available())[0]
    await fork.rpc('anvil_impersonateAccount', [tx.from])
    await fork.rpc('anvil_setBalance', [tx.from, '0x56bc75e2d63100000'])
    // Same signed authority and exact funding; an expired deadline forces failure at publish.
    const broken = entries.map((entry, index) =>
      index !== 2
        ? entry
        : {
            ...entry,
            execution: {
              ...entry.execution,
              callData: encodeFunctionData({
                abi: sdk.sidequestHoldingAbi,
                functionName: 'publish',
                args: [{ ...params, deliveryDeadline: 0 }],
              }),
            },
          },
    )
    const hash = await fork.rpc<Hex>('eth_sendTransaction', [
      { from: tx.from, to: tx.to, data: redeemGrantBatch(broken), gas: '0x5b8d80' },
    ])
    const receipt = await fork.client.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'reverted') throw new Error('P8_FAILED_PUBLISH_DID_NOT_REVERT')
    const after = await balances()
    if (
      before.some((value, index) => after[index] !== value) ||
      (await approval()) !== allowance ||
      (await available())[0] !== beforeAvailable ||
      receipt.logs.length !== 0
    )
      throw new Error('P8_FAILED_PUBLISH_LEAKED_ECONOMIC_EFFECT')
    // Call traces locate the failure at Holding, rather than an expired outer grant.
    const trace = await fork.rpc<{ calls?: unknown[] }>('debug_traceTransaction', [hash, { tracer: 'callTracer' }])
    const inspect = (value: unknown): boolean => {
      if (value === null || typeof value !== 'object') return false
      const call = object(value)
      if (
        typeof call.to === 'string' &&
        call.to.toLowerCase() === ctx.stack.holding.toLowerCase() &&
        call.error !== undefined
      )
        return true
      return Array.isArray(call.calls) && call.calls.some(inspect)
    }
    if (!inspect(trace)) throw new Error('P8_ROLLBACK_WAS_NOT_A_PUBLISH_FAILURE')
  } finally {
    await fork.close()
  }
}

export async function atomicHire(runtime: Runtime): Promise<Proof> {
  await runtime.login()
  await ensureAllowance(runtime)
  const coding = await runtime.coding()
  const { chain, run } = runtime
  const grok = required('P8_GROK_AGENT_ID')
  const grokWallet = await sdk.agentWallet(chain.ctx, BigInt(grok))
  if (grokWallet.toLowerCase() === runtime.agent.address.toLowerCase()) throw new Error('P8_GROK_WORKER_IS_CREATOR')
  const args =
    run.get<Record<string, unknown>>('a03/offer') ??
    run.set('a03/offer', {
      title: `P8 fixture Grok hire ${run.get<string>('run-id')!}`,
      brief: 'Fixture hire: deliver a small illustration of a coding agent at work as a public artifact.',
      acceptanceCriteria: ['A working artifact URL containing the illustration.'],
      mode: 'hire',
      token: chain.ctx.deployment.rewardTokens[0]!,
      reward: '3',
      creatorBond: '0',
      workerBond: '0',
      deliveryDeadline: Number((await chain.ctx.publicClient.getBlock()).timestamp) + 6 * 3600,
      windows: sdk.minimumOfferWindows(await sdk.readWindowBounds(chain.ctx)),
      invite: { agentId: grok },
      deliverable: { accepts: ['artifact', 'url'] },
    })
  // The deployed relay's atomic batch used 1,652,660 gas in the retained
  // receipt; keep its 2 MON-cap reservation above that observed bound.
  const result = await runtime.write(coding, 'create_task', args, 'a03-hire', 2_000_000n)
  if (result.status !== 'confirmed') throw new Error('P8_IN_CAP_HIRE_REQUIRED_APPROVAL')
  const output = object(result.result)
  const hash = text(object(output.sponsorship).txHash) as Hex
  const verified = await verifyAtomic(runtime, hash)
  const listing = await sdk.getV1Listing(chain.ctx, verified.jobId)
  if (
    listing.creator.toLowerCase() !== runtime.agent.address.toLowerCase() ||
    listing.reward !== verified.params.reward
  )
    throw new Error('P8_CREATOR_OF_RECORD_MISMATCH')
  await rollback(runtime, hash, verified.receipt.blockNumber - 1n)
  run.set('a03/job', {
    taskId: text(output.taskId),
    jobId: verified.jobId.toString(),
    txHash: hash,
  })
  return {
    checks: [
      'named Grok worker and agent creator',
      'one confirmed relay transaction pulls exact reward, approves Holding and publishes escrow',
      'real deployed-bytecode fork proves failed publish rollback',
    ],
    txHashes: [hash],
    details: {
      workerAgentId: grok,
      workerWallet: grokWallet,
      taskId: output.taskId,
      jobId: verified.jobId.toString(),
      reward: verified.params.reward.toString(),
      token: verified.params.token,
      rollbackTier:
        'local fork immediately before the live receipt; expired publish leaves token balances, approval, allowance use and logs unchanged',
    },
  }
}

/** Measure the real relay hire batch, verify escrow, then cancel the fixture job. */
import { type Hex, decodeEventLog, encodeFunctionData, erc20Abi, keccak256, stringToHex } from 'viem'
import { advanceExecution, delegationHash, redeemCallsCalldata } from '../../../board/src/delegation.ts'
import { hirelingHoldingAbi } from '../../src/abi/hirelingHolding.ts'
import { config } from '../privy/policy.ts'
import { AuthorityChain } from './authority-chain.ts'
import { available, balance, token, workGrant } from './authority-allowance.ts'
import { fixtureAllowance, fixtureGrant, pinnedApproval, redemptionBatch } from './authority-grants.ts'
import { disableCalldata } from '../../../board/src/delegation.ts'

export async function proveGas(chain: AuthorityChain, details: unknown[]): Promise<void> {
  const holding = chain.ctx.stack.holding
  const manager = chain.ctx.deployment.delegation.manager
  const work = await workGrant(chain)
  const approval = await chain.agentGrant('approve', async () => pinnedApproval(chain.agent, chain.relay.account.address, token, holding, 5n,
    Number((await chain.ctx.publicClient.getBlock()).timestamp) + 86400))
  const start = await chain.journal.once('gas/weekly-start', async () => Number((await chain.ctx.publicClient.getBlock()).timestamp))
  const allowance = await chain.operatorGrant('gas/weekly-allowance', async () => fixtureAllowance(chain.operator.address, chain.agent, token, 6n, start, 7 * 86400))
  const params = await chain.journal.once('gas/publish-params', async () => {
    const now = Number((await chain.ctx.publicClient.getBlock()).timestamp)
    const margin = await chain.ctx.publicClient.readContract({ address: holding, abi: hirelingHoldingAbi, functionName: 'margin' })
    return { approver: chain.agent, arbitrator: config.roles.arbitrator,
      manifestHash: keccak256(stringToHex(`p0-${chain.runId}`)), policyHash: keccak256(stringToHex(`p0-policy-${chain.runId}`)),
      token, reward: 1_000_000n, creatorBond: 0n, workerBond: 0n, deliveryDeadline: now + 600,
      expiredAt: now + 600 + 120 + 120 + 300 + Number(margin), reviewWindow: 120, disputeWindow: 120, arbitrationWindow: 300 }
  })
  const hire = redemptionBatch([
    { grant: work, execution: { target: manager, value: 0n, callData: redeemCallsCalldata(allowance, [advanceExecution(token, chain.agent, params.reward)]) } },
    { grant: approval, execution: { target: token, value: 0n, callData: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [holding, params.reward] }) } },
    { grant: work, execution: { target: holding, value: 0n, callData: encodeFunctionData({ abi: hirelingHoldingAbi, functionName: 'publish', args: [params] }) } },
  ])
  const before = await chain.journal.once('gas/before', async () => ({ operator: await balance(chain, chain.operator.address), agent: await balance(chain, chain.agent) }))
  const receipt = await chain.send('gas/atomic-hire', manager, hire, 1_500_000n)
  const events = receipt.logs.filter(log => log.address.toLowerCase() === holding.toLowerCase()).flatMap(log => {
    try {
      const event = decodeEventLog({ abi: hirelingHoldingAbi, data: log.data, topics: log.topics })
      return event.eventName === 'Published' ? [event.args as { jobId: bigint }] : []
    } catch { return [] }
  })
  if (events.length !== 1) throw new Error('Atomic hire did not publish exactly one job')
  const jobId = events[0]!.jobId
  const listing = await chain.ctx.publicClient.readContract({ address: holding, abi: hirelingHoldingAbi, functionName: 'getListing', args: [jobId] })
  if (listing.creator.toLowerCase() !== chain.agent.toLowerCase() || listing.reward !== params.reward || listing.rewardSettled) throw new Error('Atomic hire did not escrow the fixture reward as the agent')
  if (await balance(chain, chain.operator.address) !== before.operator - params.reward || await balance(chain, chain.agent) !== before.agent ||
    (await available(chain, allowance))[0] !== 25_000_000n - params.reward) throw new Error('Atomic hire did not pull exactly the escrowed reward')
  // Trace gas for publish itself; the paid transaction gas also includes all three redemption entries.
  const publishGas = await chain.journal.once('gas/publish-trace', async () => {
    const trace = await chain.ctx.publicClient.request({ method: 'debug_traceTransaction' as never,
      params: [receipt.transactionHash, { tracer: 'callTracer' }] as never }) as unknown as { to?: string; input?: Hex; gasUsed?: Hex; calls?: unknown[] }
    function find(call: typeof trace): bigint | undefined {
      if (call.to?.toLowerCase() === holding.toLowerCase() && call.input?.slice(0, 10) === encodeFunctionData({ abi: hirelingHoldingAbi, functionName: 'publish', args: [params] }).slice(0, 10)) return BigInt(call.gasUsed!)
      for (const child of call.calls ?? []) {
        const gas = find(child as typeof trace)
        if (gas !== undefined) return gas
      }
      return undefined
    }
    // Some RPCs disable tracing. Receipt still establishes the paid gas for the full publish shape.
    const gas = find(trace)
    if (gas === undefined) throw new Error('Publish call was absent from transaction trace')
    return gas.toString()
  })
  await chain.send('gas/cancel-fixture', manager,
    redeemCallsCalldata(work, [{ target: holding, value: 0n, callData: encodeFunctionData({ abi: hirelingHoldingAbi, functionName: 'cancel', args: [jobId] }) }]), 900_000n)
  const cancelled = await chain.ctx.publicClient.readContract({ address: holding, abi: hirelingHoldingAbi, functionName: 'getListing', args: [jobId] })
  if (!cancelled.rewardSettled || cancelled.outcome !== 2 || await balance(chain, chain.agent) !== before.agent + params.reward) throw new Error('Cancelled fixture reward was not refunded')
  const revoke = await chain.operatorGrant('gas/revoke-grant', async () => fixtureGrant(chain.operator.address, chain.relay.account.address, 7n,
    [manager], ['disableDelegation((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))'], 1,
    Number((await chain.ctx.publicClient.getBlock()).timestamp) + 600))
  await chain.send('gas/disable-weekly-allowance', manager, redeemCallsCalldata(revoke, [{ target: manager, value: 0n, callData: disableCalldata(allowance) }]), 400_000n)
  const measurements = chain.receipts.filter(item => ['registration/register', 'registration/setAgentWallet', 'allowance/period-one', 'gas/atomic-hire'].includes(item.label))
  const recommended = Object.fromEntries(measurements.map(item => [item.label, (((BigInt(item.gasUsed) * 125n + 99n) / 100n + 49_999n) / 50_000n * 50_000n).toString()]))
  details.push({ fixture: true, jobId: jobId.toString(), publishCallGas: publishGas, atomicHire: receipt.transactionHash,
    pullAmount: params.reward.toString(), weeklyAllowance: { durationSeconds: 604800, lifetimeSeconds: 2592000, hash: delegationHash(allowance), disabledAfterProof: true },
    jobCleanup: 'cancelled and reward refunded to fixture agent; no active job or reserved bond remains',
    gasMeasurements: measurements, recommendedGasFloors: recommended, floorApplication: 'P2/P3 builders consume these measurements; existing V1_GAS payout floors are unchanged' })
}

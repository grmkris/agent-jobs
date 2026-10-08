import { type Hex } from 'viem'
import * as sdk from '../../../src/index.ts'
import { logWindowEnd, smallerLogSpan } from '../../../src/log-ranges.ts'
import { Runtime, object, text, type Proof } from './runtime.ts'
import { verifyAtomic } from './atomic.ts'
import { ensureAllowance } from './worker.ts'
import { creatorBond } from './backing.ts'

/** Kill a real Codex after the server sends confirmation but before local result persistence. */
export async function restart(runtime: Runtime): Promise<Proof> {
  await runtime.login()
  await ensureAllowance(runtime, ['a07-restart-hire'])
  const coding = await runtime.coding()
  const { run, chain } = runtime
  const label = 'a07-restart-hire'
  const args =
    run.get<Record<string, unknown>>('a07/offer') ??
    run.set('a07/offer', {
      title: `P8 fixture restart ${run.get<string>('run-id')}`,
      brief: 'Fixture restart acceptance. Deliver the deployed Holding address.',
      acceptanceCriteria: ['The configured Holding address on chain 10143.'],
      mode: 'hire',
      token: chain.ctx.deployment.rewardTokens[0]!,
      reward: '1',
      creatorBond: await creatorBond(runtime),
      workerBond: '0',
      deliveryDeadline: Number((await chain.ctx.publicClient.getBlock()).timestamp) + 6 * 3600,
      windows: sdk.minimumOfferWindows(await sdk.readWindowBounds(chain.ctx)),
      deliverable: { accepts: ['onchain'] },
    })
  const intent = run.freeze(`intent/${label}`, {
    ...args,
    operationKey: `p8-${run.get<string>('run-id')}-${label}`,
  })
  if (run.get(`interrupted/${label}`) === undefined) {
    await chain.reserve(label, 2_000_000n)
    await coding.interrupt('create_task', intent, label)
  }
  const original = run.get<{ operationId: Hex; txHash: Hex; boundary: string }>(`interrupted/${label}`)
  if (original === undefined) throw new Error('P8_INTERRUPT_MARKER_MISSING')
  const result = await runtime.write(coding, 'create_task', args, label, 2_000_000n)
  // SAFETY: runtime.write validates this confirmed sponsorship hash as 32-byte hex before returning.
  const recovered = text(object(object(result.result).sponsorship).txHash) as Hex
  if (text(object(result).operationId) !== original.operationId || recovered !== original.txHash)
    throw new Error('P8_RESTART_CHANGED_ECONOMIC_OPERATION')
  const verified = await verifyAtomic(runtime, recovered)
  const through = await chain.ctx.publicClient.getBlockNumber()
  let from = run.get<bigint>('firstBlock')!
  let span = 1_000n
  let published = 0
  while (from <= through) {
    const toBlock = logWindowEnd(from, through, span)
    try {
      const logs = await chain.ctx.publicClient.getContractEvents({
        address: chain.ctx.stack.holding,
        abi: sdk.sidequestHoldingAbi,
        eventName: 'Published',
        fromBlock: from,
        toBlock,
      })
      published += logs.filter(
        (log) => log.args.policyHash?.toLowerCase() === verified.params.policyHash.toLowerCase(),
      ).length
      from = toBlock + 1n
    } catch (error) {
      const smaller = smallerLogSpan(error, span)
      if (smaller === undefined) throw new Error('P8_RESTART_EVENT_READ_FAILED', { cause: error })
      // Retry this same inclusive range; a refused query never skips blocks.
      span = smaller
    }
  }
  if (published !== 1) throw new Error('P8_RESTART_DUPLICATE_PUBLISH')
  return {
    checks: [
      'real Codex process killed at the lost-response boundary',
      'new Codex process repeats the persisted key and arguments',
      'same operation ID and transaction hash',
      'exactly one Published event for the frozen offer',
    ],
    txHashes: [recovered],
    details: {
      operationId: original.operationId,
      boundary: original.boundary,
      taskId: object(result.result).taskId,
      verifiedThroughBlock: through.toString(),
      rotation: 'outside A07f; no wallet rotation performed',
    },
  }
}

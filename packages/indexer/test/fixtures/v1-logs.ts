/** Synthetic v1 chain logs for paging, atomic crash recovery, leases, rewind and D1 rebuild tests. */
import * as sdk from '@sidequest/sdk'
import { type Abi, type AbiEvent, type Address, type Hex, encodeAbiParameters, encodeEventTopics } from 'viem'
import type { RawLog } from '../../src/events.ts'

export const fixtureDeployment = sdk.deployment('monad-testnet')
const d = fixtureDeployment,
  pair = d.stacks.main!,
  start = Number(d.deployBlock)
const address = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`
const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`
const creator = address(20),
  worker = address(21),
  arbitrator = address(22),
  token = d.rewardTokens[0]!
let offset = 100
const logs: RawLog[] = []
function emit(abi: Abi, contract: Address, name: string, args: Record<string, unknown>) {
  const event = abi.find((item): item is AbiEvent => item.type === 'event' && item.name === name)!
  const topics = encodeEventTopics({ abi: [event], eventName: name, args } as never) as Hex[]
  const data = event.inputs.filter((input) => !input.indexed)
  const block = start + offset
  offset += 100
  logs.push({
    address: contract,
    block_number: block,
    log_index: 0,
    transaction_hash: hash(block),
    topic0: topics[0] ?? null,
    topic1: topics[1] ?? null,
    topic2: topics[2] ?? null,
    topic3: topics[3] ?? null,
    data: encodeAbiParameters(
      data,
      data.map((input) => args[input.name!]),
    ),
  })
}
for (const jobId of [9n, 10n, 8n]) {
  emit(sdk.sidequestHoldingAbi, pair.holding, 'Published', {
    jobId,
    creator,
    approver: creator,
    arbitrator,
    token,
    reward: 7_000_000n,
    creatorBond: 100n,
    workerBond: 200n,
    manifestHash: hash(1),
    policyHash: hash(Number(jobId)),
    deliveryDeadline: 1_800_000_000,
    expiredAt: 1_800_100_000,
    reviewWindow: 3600,
    disputeWindow: 7200,
    arbitrationWindow: 43200,
  })
  emit(sdk.sidequestHoldingAbi, pair.holding, 'Activated', {
    jobId,
    worker,
    agentId: 7n,
    selectionNonce: jobId,
    feeBps: 1000,
    fee: 700_000n,
    net: 6_300_000n,
    workerBond: 200n,
  })
  emit(sdk.coreAbi, d.core, 'JobSubmitted', { jobId, provider: worker, deliverable: hash(44) })
  if (jobId === 8n) {
    emit(sdk.sidequestEvaluatorAbi, pair.evaluator, 'EvidenceAttached', {
      jobId,
      verifier: address(23),
      digest: hash(30),
      submissionHash: hash(44),
      policyHash: hash(8),
      testedSha: hash(31),
      conclusion: 1,
      validUntil: 1_800_100_000n,
    })
    emit(sdk.sidequestEvaluatorAbi, pair.evaluator, 'Accepted', { jobId, approver: creator })
  } else {
    emit(sdk.sidequestEvaluatorAbi, pair.evaluator, 'Rejected', {
      jobId,
      approver: creator,
      violation: jobId === 10n ? 1 : 0,
      reasonHash: hash(45),
    })
    emit(sdk.sidequestEvaluatorAbi, pair.evaluator, 'Disputed', { jobId, worker })
    emit(sdk.sidequestEvaluatorAbi, pair.evaluator, 'Ruled', {
      jobId,
      arbitrator,
      forWorker: jobId === 9n,
      slashLoser: jobId === 10n,
      reasonHash: hash(46),
    })
  }
  if (jobId === 10n) {
    emit(sdk.sidequestHoldingAbi, pair.holding, 'BondSlashed', { jobId, side: 1, account: worker, amount: 200n })
    emit(sdk.coreAbi, d.core, 'JobRejected', { jobId, rejector: pair.evaluator, reason: hash(47) })
  } else {
    emit(sdk.coreAbi, d.core, 'JobCompleted', { jobId, evaluator: pair.evaluator, reason: hash(47) })
  }
  emit(sdk.sidequestHoldingAbi, pair.holding, 'RewardSettled', {
    jobId,
    to: jobId === 10n ? creator : worker,
    outcome: jobId === 10n ? 2 : 1,
    amount: 7_000_000n,
  })
}
export default { logs, toBlock: start + offset + 1000 }

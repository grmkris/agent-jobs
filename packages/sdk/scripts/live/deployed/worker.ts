import { type Address, type Hex, encodeFunctionData, parseAbi } from 'viem'
import * as sdk from '../../../src/index.ts'
import { ORIGIN } from './guards.ts'
import { Runtime, object, text, type Proof } from './runtime.ts'
import { confirmGrant } from './signing.ts'

export async function ensureAllowance(runtime: Runtime): Promise<void> {
  const funded = runtime.run.get('operator-reward-funding')
  if (funded === undefined) {
    const { wallet } = await runtime.creator()
    const tx = {
      chainId: 10143,
      to: runtime.chain.ctx.deployment.rewardTokens[0]!,
      value: '0',
      description: 'Fixture mUSD funding for the operator allowance',
      data: encodeFunctionData({
        abi: parseAbi(['function mint(address to,uint256 amount)']),
        functionName: 'mint',
        args: [runtime.agent.operator, 40_000_000n],
      }),
    }
    const receipt = await runtime.chain.send('operator-reward-funding', wallet, tx)
    runtime.run.set('operator-reward-funding', receipt.transactionHash)
  }
  const status = await runtime.browser.api<{
    allowances: Array<{ token: Address; limit: string }>
  }>(`/api/agents/${runtime.agent.id}`)
  const token = runtime.chain.ctx.deployment.rewardTokens[0]!
  if (status.allowances.some((row) => row.token.toLowerCase() === token.toLowerCase() && BigInt(row.limit) > 0n)) return
  await runtime.browser.page.goto(`${ORIGIN}/agent/${runtime.agent.agent_id}?tab=manage`)
  const card = runtime.browser.page.locator('article').filter({ hasText: runtime.agent.name })
  await card.locator('summary').filter({ hasText: 'Change or renew the weekly budget' }).click()
  await card.getByRole('combobox', { name: 'Token jobs are paid in', exact: true }).selectOption(token.toLowerCase())
  await card.getByRole('textbox', { name: 'Weekly budget', exact: true }).fill('25')
  await card.getByRole('button', { name: 'Review budget', exact: true }).click()
  const response = runtime.browser.page.waitForResponse(
    (reply) => new URL(reply.url()).pathname === `/api/agents/${runtime.agent.id}/allowance-confirm`,
  )
  await card.getByRole('button', { name: 'Sign budget', exact: true }).click()
  await confirmGrant(runtime.browser, runtime.chain.ctx, `/api/agents/${runtime.agent.id}/allowance-prepare`, {
    kind: 'allowance',
    delegator: runtime.agent.operator,
    agent: runtime.agent.address,
    token,
    amount: 25_000_000n,
  })
  if (!(await response).ok()) throw new Error('P8_INITIAL_ALLOWANCE_REFUSED')
  const after = await runtime.browser.api<{ allowances: Array<{ token: Address; limit: string }> }>(
    `/api/agents/${runtime.agent.id}`,
  )
  if (!after.allowances.some((row) => row.token.toLowerCase() === token.toLowerCase() && BigInt(row.limit) > 0n))
    throw new Error('P8_ALLOWANCE_NOT_LIVE')
}

interface Prepared {
  taskId: string
  transactions: sdk.TxRequest[]
  sign?: { typedData: string }
  nonce?: string
}

/** The creator is a fixture key; apply/activation/delivery are the real Codex MCP. */
export async function worker(runtime: Runtime): Promise<Proof> {
  await runtime.login()
  await ensureAllowance(runtime)
  const coding = await runtime.coding()
  const guide = await coding.call('get_instructions', { role: 'worker' }, 'a02-instructions')
  if (
    guide.item.result?.isError === true ||
    typeof guide.output !== 'string' ||
    !guide.output.includes('Persist a unique operationKey')
  )
    throw new Error('P8_WORKER_INSTRUCTIONS_MISSING')
  const { chain, run } = runtime
  const { wallet, board } = await runtime.creator()
  const token = chain.ctx.deployment.rewardTokens[0]!
  const windows = sdk.minimumOfferWindows(await sdk.readWindowBounds(chain.ctx))
  const args =
    run.get<Record<string, unknown>>('a02/offer') ??
    run.set('a02/offer', {
      title: `P8 fixture worker ${run.get<string>('run-id')!}`,
      brief:
        'Fixture acceptance: identify the configured deployed Holding contract on Monad testnet. The on-chain address is the fixture deliverable.',
      acceptanceCriteria: ['The onchain deliverable names the configured Holding on chain 10143.'],
      token,
      reward: '1',
      creatorBond: '0',
      workerBond: '0',
      mode: 'hire',
      deliveryDeadline: Number((await chain.ctx.publicClient.getBlock()).timestamp) + 6 * 3600,
      windows,
      deliverable: { accepts: ['onchain'] },
      idempotencyKey: `p8-${run.get<string>('run-id')!}-worker`,
    })
  // Idempotency key and full offer are durable before the first HTTP write.
  const prepared = await chain.journal.once('a02/created', () => board.call<Prepared>('create_task', args))
  for (const [index, tx] of prepared.transactions.entries()) {
    const receipt = await chain.send(`a02/publish/${index}`, wallet, tx)
    await board.call('report_transaction', {
      taskId: prepared.taskId,
      txHash: receipt.transactionHash,
    })
  }
  const task = await board.call<{ jobId: string }>('get_task', { taskId: prepared.taskId })
  const jobId = BigInt(task.jobId)
  run.freeze('a02/job', { jobId: task.jobId, taskId: prepared.taskId })
  const applied = await runtime.write(
    coding,
    'apply',
    {
      taskId: prepared.taskId,
      agentId: runtime.agent.agent_id,
      note: 'P8 fixture: deployed Holding address verification',
    },
    'a02-apply',
    0n,
  )
  const applicationId = text(object(applied.result).applicationId)
  const selected = await chain.journal.once('a02/selection', () =>
    board.call<Prepared>('select_worker', { taskId: prepared.taskId, applicationId }),
  )
  if (selected.sign === undefined || selected.nonce === undefined) throw new Error('P8_CREATOR_SELECTION_INCOMPLETE')
  const signature = await chain.journal.once('a02/selection-signature', () =>
    sdk.signTypedDataJson(wallet, selected.sign!.typedData),
  )
  await board.call('submit_selection', {
    taskId: prepared.taskId,
    nonce: selected.nonce,
    signature,
  })
  const activated = await runtime.write(
    coding,
    'prepare_activation',
    { taskId: prepared.taskId },
    'a02-activate',
    1_500_000n,
  )
  const active = await sdk.getJob(chain.ctx, jobId)
  if (
    !['Funded', 'Submitted', 'Completed'].includes(active.statusName) ||
    active.provider.toLowerCase() !== runtime.agent.address.toLowerCase()
  )
    throw new Error('P8_WORKER_ACTIVATION_NOT_FUNDED')
  const listing = await sdk.getV1Listing(chain.ctx, jobId)
  const before = await chain.journal.once('a02/payment-before', () => chain.balance(token, runtime.agent.address))
  const delivered = await runtime.write(
    coding,
    'submit_work',
    {
      taskId: prepared.taskId,
      deliverable: { kind: 'onchain', chainId: 10143, address: chain.ctx.stack.holding },
    },
    'a02-deliver',
    1_500_000n,
  )
  if (!['Submitted', 'Completed'].includes((await sdk.getJob(chain.ctx, jobId)).statusName))
    throw new Error('P8_WORKER_SUBMISSION_NOT_ON_CHAIN')
  const acceptance = await chain.journal.once('a02/accept-prepared', () =>
    board.call<Prepared>('approve_work', { taskId: prepared.taskId }),
  )
  const hashes: Hex[] = []
  for (const [index, tx] of acceptance.transactions.entries()) {
    const receipt = await chain.send(`a02/accept/${index}`, wallet, tx)
    hashes.push(receipt.transactionHash)
    await board.call('report_transaction', {
      taskId: prepared.taskId,
      txHash: receipt.transactionHash,
    })
  }
  const settled = await chain.journal.once('a02/settle-prepared', () =>
    board.call<{ transactions: sdk.TxRequest[] }>('settlement_actions', {
      taskId: prepared.taskId,
    }),
  )
  for (const [index, tx] of settled.transactions.entries()) {
    const receipt = await chain.send(`a02/settle/${index}`, wallet, tx)
    hashes.push(receipt.transactionHash)
    await board.call('report_transaction', {
      taskId: prepared.taskId,
      txHash: receipt.transactionHash,
    })
  }
  const [terminal, balance, finalListing] = await Promise.all([
    sdk.getJob(chain.ctx, jobId),
    chain.balance(token, runtime.agent.address),
    sdk.getV1Listing(chain.ctx, jobId),
  ])
  const net = listing.reward - listing.fee
  if (terminal.statusName !== 'Completed' || balance - before !== net || finalListing.outcome !== 1)
    throw new Error('P8_EXACT_NET_PAYMENT_NOT_PROVEN')
  for (const output of [activated, delivered])
    hashes.push(text(object(object(output.result).sponsorship).txHash) as Hex)
  return {
    checks: [
      'browser OAuth consent and isolated Codex MCP',
      'fixture creator publishes escrow',
      'Codex applies, activates and submits without browser agent signing',
      'chain-funded activation and finalized delivery',
      'completed outcome and exact net token payment',
    ],
    txHashes: hashes,
    details: {
      jobId: task.jobId,
      taskId: prepared.taskId,
      token,
      gross: listing.reward.toString(),
      fee: listing.fee.toString(),
      net: net.toString(),
      received: (balance - before).toString(),
    },
  }
}

/**
 * The MetaMask Agent Wallet's lifecycle on Monad testnet (CP3, wallet matrix demo path 2), sign-only because
 * MetaMask's infrastructure does not send on 10143: the cast worker owns an ERC-8004 agent whose agent wallet is set
 * to the MetaMask address by the MetaMask wallet's own `AgentWalletSet` signature; the MetaMask wallet signs in to
 * the board, enters a contest (two EIP-712 authorisations) and is paid by the approver's award with no transaction
 * of its own.
 *
 *   BOARD_URL=https://… bun packages/sdk/scripts/board-mm-contest.ts   (from the repo root; .env.local loaded; `mm` signed in)
 *
 * With TASK_ID the MetaMask wallet only enters that existing contest (ENTRY_REPO, ENTRY_BRANCH, ENTRY_SHA name the
 * finished commit) and leaves the award to its approver.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Hex, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import * as sdk from '../src/index.ts'
import { check, checks, env, log } from './lib/common.ts'
import { metamaskAddress, metamaskSignMessage, metamaskSignTypedData } from './lib/metamask.ts'

const BOARD = env('BOARD_URL')
const RPC = env('MONAD_TESTNET_RPC_URL')
const CHAIN = 10143
const ENTRY = {
  repo: env('ENTRY_REPO', 'https://github.com/grmkris/runner-spike-fixture'),
  branch: env('ENTRY_BRANCH', 'dispatch/cb0b4323adb67f08'),
  sha: env('ENTRY_SHA', 'c850f7a58015bafe065257f263a2ecc01da56dfe'),
}
const EXISTING = process.env.TASK_ID
const STATE = join(import.meta.dirname, '.state.json')
const state = JSON.parse(readFileSync(STATE, 'utf8')) as Record<string, string>

const ctx = sdk.context('monad-testnet', 'demo', RPC)
const creatorAccount = privateKeyToAccount(env('TESTNET_CREATOR_PRIVATE_KEY') as Hex)
const ownerAccount = privateKeyToAccount(env('TESTNET_WORKER_PRIVATE_KEY') as Hex)
const creator = sdk.wallet('monad-testnet', creatorAccount, RPC)
const owner = sdk.wallet('monad-testnet', ownerAccount, RPC)
const mmAddress = await metamaskAddress()


// 1. An ERC-8004 agent owned by the cast worker, its agent wallet set to the MetaMask address by MetaMask's signature.
const identity = ctx.deployment.identity
if (state.metamaskAgentId === undefined) {
  const id = await sdk.registerAgent(ctx, owner, 'https://github.com/grmkris/agent-jobs#testnet-metamask-agent')
  state.metamaskAgentId = id.toString()
  writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`)
  log('owner', `registered agent ${id}`)
}
const agentId = BigInt(state.metamaskAgentId as string)
if ((await sdk.agentWallet(ctx, agentId)).toLowerCase() !== mmAddress.toLowerCase()) {
  const block = await ctx.publicClient.getBlock()
  const deadline = block.timestamp + 240n
  const typed = JSON.stringify({
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      AgentWalletSet: [
        { name: 'agentId', type: 'uint256' },
        { name: 'newWallet', type: 'address' },
        { name: 'owner', type: 'address' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'AgentWalletSet',
    domain: { name: 'ERC8004IdentityRegistry', version: '1', chainId: CHAIN, verifyingContract: identity },
    message: { agentId: agentId.toString(), newWallet: mmAddress, owner: ownerAccount.address, deadline: deadline.toString() },
  })
  const sig = await metamaskSignTypedData(typed, CHAIN)
  const hash = await owner.writeContract({
    address: identity,
    abi: parseAbi(['function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes signature)']),
    functionName: 'setAgentWallet',
    args: [agentId, mmAddress, deadline, sig],
  })
  await ctx.publicClient.waitForTransactionReceipt({ hash })
  log('owner', `setAgentWallet(${agentId}, MetaMask) with MetaMask's signature → https://testnet.monadscan.com/tx/${hash}`)
}
check(`agent ${agentId}'s wallet is the MetaMask address`, (await sdk.agentWallet(ctx, agentId)).toLowerCase() === mmAddress.toLowerCase())

// 2. Sign-in and the entry, signed by MetaMask.
const pub = sdk.boardClient(BOARD)
const ent = sdk.boardClient(BOARD)
await pub.signIn(creatorAccount)
await ent.signIn({ address: mmAddress, type: 'json-rpc', signMessage: ({ message }: { message: string }) => metamaskSignMessage(message, CHAIN) } as never)
check('MetaMask signed in to the board', (await ent.call('whoami')).address.toLowerCase() === mmAddress.toLowerCase())

let taskId: string
if (EXISTING === undefined) {
  const t0 = Math.floor(Date.now() / 1000)
  const created = await pub.call('create_task', {
    title: 'Contest: CI workflow for runner-spike-fixture (MetaMask entrant)',
    brief: 'Submit a finished branch of grmkris/runner-spike-fixture whose GitHub check "test" passes.',
    acceptanceCriteria: ['A GitHub check run named "test" completes with conclusion "success" on the submitted SHA.'],
    token: 'mEUR',
    reward: '2',
    creatorBond: '1',
    workerBond: '0',
    deliveryDeadline: t0 + 30 * 60,
    selectionDeadline: t0 + 15 * 60,
    mode: 'contest',
    stack: 'demo',
    requiredChecks: ['test'],
  })
  taskId = created.taskId as string
  for (const [i, h] of (await sdk.sendAll(creator, ctx.publicClient, created.transactions)).entries()) {
    log('publisher', `${created.transactions[i].description} → https://testnet.monadscan.com/tx/${h}`)
    await pub.call('report_transaction', { taskId, txHash: h })
  }
} else {
  taskId = EXISTING
}
const prepared = await ent.call('prepare_entry', { taskId, agentId: agentId.toString(), ...ENTRY })
const budgetSignature = await metamaskSignTypedData(prepared.sign[0].typedData, CHAIN)
const submitSignature = await metamaskSignTypedData(prepared.sign[1].typedData, CHAIN)
await ent.call('submit_entry', { taskId, candidateId: prepared.candidateId, budgetSignature, submitSignature })
log('metamask', `entered candidate ${prepared.candidateId}: two EIP-712 signatures, no transaction`)
if (EXISTING !== undefined) checks.done()

// 3. The approver awards; MetaMask is paid without sending anything.
const mEUR = ctx.deployment.rewardTokens[1]!
const before = await sdk.balanceOf(ctx, mEUR, mmAddress)
const awardTx = await pub.call('award', { taskId, candidateId: prepared.candidateId })
for (const [i, h] of (await sdk.sendAll(creator, ctx.publicClient, awardTx.transactions)).entries()) {
  log('approver', `${awardTx.transactions[i].description} → https://testnet.monadscan.com/tx/${h}`)
  await pub.call('report_transaction', { taskId, txHash: h })
}
const after = await sdk.balanceOf(ctx, mEUR, mmAddress)
const done = await pub.call('get_task', { taskId })
check('awarded: Completed', done.chain.status === 'completed', `job ${done.jobId} ${done.chain.status}`)
check('the MetaMask wallet was paid 2 mEUR', after - before === 2_000_000n, `${after - before}`)
checks.done()

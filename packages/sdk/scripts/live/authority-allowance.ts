import { type Address, encodeFunctionData, erc20Abi, parseAbi } from 'viem'
import { delegationHash, advanceExecution, redeemCallsCalldata, type Delegation } from '../../src/delegation/index.ts'
import { config } from '../privy/policy.ts'
import { AuthorityChain } from './authority-chain.ts'
import { fixtureGrant, fixtureAllowance, nestedRedemption, periodAbi } from './authority-grants.ts'

export const mintAbi = parseAbi(['function mint(address to,uint256 amount)'])
export const token = config.deployment.rewardTokens[0] as Address

export async function workGrant(chain: AuthorityChain): Promise<Delegation> {
  return chain.agentGrant('work', async () =>
    fixtureGrant(
      chain.agent,
      chain.relay.account.address,
      2n,
      [chain.ctx.deployment.delegation.manager, chain.ctx.stack.holding],
      [
        'redeemDelegations(bytes[],bytes32[],bytes[])',
        'publish((address,address,bytes32,bytes32,address,uint256,uint256,uint256,uint48,uint48,uint32,uint32,uint32))',
        'cancel(uint256)',
        'settle(uint256)',
      ],
      100,
      Number((await chain.ctx.publicClient.getBlock()).timestamp) + 86400,
    ),
  )
}

export async function balance(chain: AuthorityChain, account: Address): Promise<bigint> {
  return chain.ctx.publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account],
  })
}

export async function available(chain: AuthorityChain, allowance: Delegation) {
  return chain.ctx.publicClient.readContract({
    address: config.delegation.enforcers.erc20PeriodTransfer,
    abi: periodAbi,
    functionName: 'getAvailableAmount',
    args: [delegationHash(allowance), chain.ctx.deployment.delegation.manager, allowance.caveats[0]!.terms],
  })
}

export async function proveAllowance(chain: AuthorityChain, details: unknown[]): Promise<void> {
  await chain.send(
    'allowance/mint-fixture-token',
    token,
    encodeFunctionData({ abi: mintAbi, functionName: 'mint', args: [chain.operator.address, 100_000_000n] }),
    150_000n,
  )
  const work = await workGrant(chain)
  const start = await chain.journal.once(
    'allowance/start',
    async () => Number((await chain.ctx.publicClient.getBlock()).timestamp) + 30,
  )
  const duration = 90
  const allowance = await chain.operatorGrant('allowance/short-period', async () =>
    fixtureAllowance(chain.operator.address, chain.agent, token, 3n, start, duration),
  )
  const terms = await chain.ctx.publicClient.readContract({
    address: config.delegation.enforcers.erc20PeriodTransfer,
    abi: periodAbi,
    functionName: 'getTermsInfo',
    args: [allowance.caveats[0]!.terms],
  })
  if (
    terms[0].toLowerCase() !== token.toLowerCase() ||
    terms[1] !== 25_000_000n ||
    terms[2] !== BigInt(duration) ||
    terms[3] !== BigInt(start)
  )
    throw new Error('Onchain period terms differ from MetaMask-checked encoding')
  const pull = nestedRedemption(work, allowance, advanceExecution(token, chain.agent, 25_000_000n))
  const startProof = await chain.journal.once('allowance/not-started', async () => {
    if (Number((await chain.ctx.publicClient.getBlock()).timestamp) >= start)
      throw new Error('Fixture start elapsed before its negative proof; stop rather than renew authority')
    const current = await available(chain, allowance)
    if (current[0] !== 0n || current[2] !== 0n) throw new Error('Allowance was available before its start')
    await chain.expectedRevert('allowance/before-start', pull, 'transfer-not-started')
    return { available: '0', period: '0', contractRefusal: 'transfer-not-started' }
  })
  await chain.waitUntil(start)
  await chain.journal.once('allowance/invalid-arguments', async () => {
    await chain.expectedRevert(
      'allowance/wrong-recipient',
      nestedRedemption(work, allowance, advanceExecution(token, chain.operator.address, 1n)),
      'AllowedCalldataEnforcer',
    )
    await chain.expectedRevert(
      'allowance/wrong-token',
      nestedRedemption(work, allowance, advanceExecution(config.deployment.rewardTokens[1], chain.agent, 1n)),
      'invalid-contract',
    )
    return true
  })
  const before = await chain.journal.once('allowance/before', async () => ({
    operator: await balance(chain, chain.operator.address),
    agent: await balance(chain, chain.agent),
  }))
  const first = await chain.send('allowance/period-one', chain.ctx.deployment.delegation.manager, pull, 650_000n)
  const exhausted = await chain.journal.once('allowance/exhausted', async () => {
    const current = await available(chain, allowance)
    if (current[0] !== 0n || current[2] !== 1n) throw new Error('First period cap was not consumed exactly')
    await chain.expectedRevert(
      'allowance/over-cap',
      nestedRedemption(work, allowance, advanceExecution(token, chain.agent, 1n)),
      'transfer-amount-exceeded',
    )
    return { available: '0', period: '1', overCapRefused: true, wrongRecipientRefused: true, wrongTokenRefused: true }
  })
  await chain.waitUntil(start + duration)
  const rollover = await chain.journal.once('allowance/rollover', async () => {
    const current = await available(chain, allowance)
    if (current[0] !== 25_000_000n || current[1] !== true || current[2] < 2n)
      throw new Error('Allowance did not replenish at rollover')
    return { available: current[0].toString(), isNewPeriod: current[1], period: current[2].toString() }
  })
  const second = await chain.send('allowance/period-two', chain.ctx.deployment.delegation.manager, pull, 650_000n)
  if (
    (await balance(chain, chain.operator.address)) !== before.operator - 50_000_000n ||
    (await balance(chain, chain.agent)) !== before.agent + 50_000_000n
  )
    throw new Error('Nested redemption moved an unexpected token amount')
  // Disable the accelerated fixture allowance through a separate, one-call operator grant.
  const revoke = await chain.operatorGrant('allowance/revoke-grant', async () =>
    fixtureGrant(
      chain.operator.address,
      chain.relay.account.address,
      4n,
      [chain.ctx.deployment.delegation.manager],
      ['disableDelegation((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))'],
      1,
      Number((await chain.ctx.publicClient.getBlock()).timestamp) + 600,
    ),
  )
  const disableAbi = parseAbi([
    'struct Caveat { address enforcer; bytes terms; bytes args; }',
    'struct Delegation { address delegate; address delegator; bytes32 authority; Caveat[] caveats; uint256 salt; bytes signature; }',
    'function disableDelegation(Delegation delegation)',
  ])
  await chain.send(
    'allowance/disable-short-period',
    chain.ctx.deployment.delegation.manager,
    redeemCallsCalldata(revoke, [
      {
        target: chain.ctx.deployment.delegation.manager,
        value: 0n,
        callData: encodeFunctionData({ abi: disableAbi, functionName: 'disableDelegation', args: [allowance] }),
      },
    ]),
    400_000n,
  )
  details.push({
    fixture: true,
    durationSeconds: duration,
    weeklyBoundary: 'Seven-day rollover is a separate local Monad fork proof',
    encoding:
      '116 packed bytes; byte-for-byte equality with @metamask/delegation-core 3.0.0; onchain getTermsInfo matched',
    start,
    startProof,
    exhausted,
    rollover,
    nestedTransactions: [first.transactionHash, second.transactionHash],
    operatorTokenDelta: '-50000000',
    agentTokenDelta: '50000000',
    acceleratedAllowanceDisabled: true,
  })
}

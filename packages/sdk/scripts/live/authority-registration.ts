import { readFileSync } from 'node:fs'
import { type Abi, type Address, decodeEventLog, encodeFunctionData } from 'viem'
import { redeemCallsCalldata } from '../../src/delegation/index.ts'
import { fixtureGrant } from './authority-grants.ts'
import { AuthorityChain } from './authority-chain.ts'

export const registryAbi = JSON.parse(readFileSync(new URL('../../../../contracts/abi/erc8004/IdentityRegistry.json', import.meta.url), 'utf8')) as Abi

export async function proveRegistration(chain: AuthorityChain, details: unknown[]): Promise<void> {
  await chain.initialize()
  await chain.upgrades()
  const identity = chain.ctx.deployment.identity
  const grant = await chain.operatorGrant('registration/grant', async () => fixtureGrant(
    chain.operator.address, chain.relay.account.address, 1n, [identity],
    ['register(string)', 'setAgentWallet(uint256,address,uint256,bytes)'], 2,
    Number((await chain.ctx.publicClient.getBlock()).timestamp) + 600,
  ))
  const register = encodeFunctionData({ abi: registryAbi, functionName: 'register',
    args: [`https://sidequest.exchange/fixtures/spec-v2-p0/${chain.runId}`] })
  const receipt = await chain.send('registration/register', chain.ctx.deployment.delegation.manager,
    redeemCallsCalldata(grant, [{ target: identity, value: 0n, callData: register }]), 800_000n)
  const registered = receipt.logs.filter(log => log.address.toLowerCase() === identity.toLowerCase()).flatMap(log => {
    try {
      const event = decodeEventLog({ abi: registryAbi, data: log.data, topics: log.topics })
      return event.eventName === 'Registered' ? [event.args as unknown as { agentId: bigint; owner: Address }] : []
    } catch { return [] }
  })
  if (registered.length !== 1 || registered[0]!.owner.toLowerCase() !== chain.operator.address.toLowerCase()) throw new Error('Registration did not mint exactly one fixture NFT to the DeleGator')
  const agentId = registered[0]!.agentId
  const deadline = await chain.journal.once('registration/deadline', async () => (await chain.ctx.publicClient.getBlock()).timestamp + 300n)
  const signature = await chain.agentTyped('registration/consent', 'AgentWalletSet', {
    agentId: agentId.toString(), newWallet: chain.agent, owner: chain.operator.address, deadline: deadline.toString(),
  })
  const consent = encodeFunctionData({ abi: registryAbi, functionName: 'setAgentWallet', args: [agentId, chain.agent, deadline, signature] })
  await chain.send('registration/setAgentWallet', chain.ctx.deployment.delegation.manager,
    redeemCallsCalldata(grant, [{ target: identity, value: 0n, callData: consent }]), 600_000n)
  const owner = await chain.ctx.publicClient.readContract({ address: identity, abi: registryAbi, functionName: 'ownerOf', args: [agentId] }) as Address
  const agentWallet = await chain.ctx.publicClient.readContract({ address: identity, abi: registryAbi, functionName: 'getAgentWallet', args: [agentId] }) as Address
  if (owner.toLowerCase() !== chain.operator.address.toLowerCase() || agentWallet.toLowerCase() !== chain.agent.toLowerCase()) throw new Error('Registry owner/agentWallet readback mismatch')
  details.push({ fixture: true, agentId: agentId.toString(), owner, agentWallet,
    operatorDeleGatorVerified: true, upgradedAgentConsentAccepted: true, registrationGrantCalls: 2, registrationGrantLifetime: 600,
    transactions: chain.receipts.filter(item => /upgrade|registration\//.test(item.label)) })
}

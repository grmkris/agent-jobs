/** Persist each provider request before signing and recover its exact result after restarts. */
import * as sdk from '@agent-jobs/sdk'
import { type Hex, type SignedAuthorization, recoverTypedDataAddress } from 'viem'
import { recoverAuthorizationAddress } from 'viem/utils'
import { AgentStore } from './agents.ts'
import { assertAgentEnvelope, assertExactAgentTypedData } from './agent-signing-scope.ts'
import { GrantStore } from './grants.ts'
import type { Sql } from './store.ts'
import { prepareAgentSignRequest, finishAgentSignRequest, type AgentSignRequest } from './agent-signing-store.ts'

export interface RoutineSigner {
  signTypedData(walletId: string, typedData: string, operationKey: string): Promise<Hex>
  signAuthorization(walletId: string, contract: `0x${string}`, chainId: number, nonce: number, operationKey: string): Promise<SignedAuthorization<number>>
}

export class AgentSigning {
  readonly agents: AgentStore
  readonly grants: GrantStore

  constructor(readonly sql: Sql, readonly context: sdk.Ctx, readonly provider: RoutineSigner, readonly now: () => number) {
    this.agents = new AgentStore(sql, now)
    this.grants = new GrantStore(sql, context)
  }

  #agent(id: string) {
    const agent = this.agents.get(id)
    if (agent.state === 'revoked' || agent.address === null || agent.privy_wallet_id === null || agent.chain_id !== this.context.deployment.chainId
      || agent.registry.toLowerCase() !== this.context.deployment.identity.toLowerCase()) throw new Error('Agent is unavailable for routine signing')
    return { ...agent, address: agent.address, privy_wallet_id: agent.privy_wallet_id }
  }

  #request(id: string, purpose: string, request: unknown): AgentSignRequest {
    const agent = this.#agent(id)
    return prepareAgentSignRequest(this.sql, { agentId: id, purpose, walletId: agent.privy_wallet_id, request, now: this.now() })
  }

  #save(row: AgentSignRequest, result: unknown): void {
    finishAgentSignRequest(this.sql, row, result)
  }

  async #typed(id: string, purpose: string, typedData: string, verify: () => Promise<string>): Promise<Hex> {
    const agent = this.#agent(id)
    assertAgentEnvelope(this.context, typedData, agent.address)
    const row = this.#request(id, purpose, { method: 'eth_signTypedData_v4', typedData })
    if (row.result_json !== null) return JSON.parse(row.result_json) as Hex
    assertExactAgentTypedData(typedData, await verify())
    this.#agent(id)
    const signature = await this.provider.signTypedData(agent.privy_wallet_id, typedData, row.id)
    const typed = JSON.parse(typedData) as Parameters<typeof recoverTypedDataAddress>[0]
    const recovered = await recoverTypedDataAddress({ ...typed, signature })
    if (recovered.toLowerCase() !== agent.address.toLowerCase()) throw new Error('Routine signature does not recover to the bound agent')
    this.#save(row, signature)
    return signature
  }

  /** The board reconstructs current job, listing, selection and net quote before every tool signature. */
  signTool(id: string, operationId: Hex, typedData: string, verify: () => Promise<string>): Promise<Hex> {
    const type = assertAgentEnvelope(this.context, typedData, this.#agent(id).address).primaryType
    if (!['Selection', 'SetBudgetAuthorization', 'SubmitAuthorization'].includes(type)) throw new Error('Not a routine tool signature')
    return this.#typed(id, `tool:${operationId}`, typedData, verify)
  }

  signGrant(id: string, hash: Hex): Promise<Hex> {
    const agent = this.#agent(id)
    const row = this.grants.get(hash)
    if (row === undefined || row.owner.toLowerCase() !== agent.operator.toLowerCase() || row.delegator.toLowerCase() !== agent.address.toLowerCase()
      || !['prepared', 'live'].includes(row.status)) throw new Error('Grant does not belong to this agent')
    const spec = this.grants.spec(hash)
    if (!['agent-work', 'agent-approve', 'agent-approve-once', 'agent-sweep'].includes(spec.kind)) throw new Error('Grant kind is outside routine authority')
    const typedData = sdk.delegationTypedData(this.context.deployment, sdk.parseDelegation(row.delegation_json))
    return this.#typed(id, `grant:${hash}`, typedData, async () => {
      if (row.expires_at <= this.now() || spec.start > this.now()) throw new Error('Grant is outside its signing window')
      if (spec.kind === 'agent-sweep' && spec.operator.toLowerCase() !== agent.operator.toLowerCase()) throw new Error('Sweep must name this operator')
      if (spec.kind === 'agent-approve-once') this.grants.approvedHire(agent.operator, spec)
      return sdk.delegationTypedData(this.context.deployment, sdk.buildGrant(this.context, spec))
    })
  }

  signConsent(id: string, purpose: string, consent: sdk.AgentWalletConsent): Promise<Hex> {
    const agent = this.#agent(id)
    const typedData = sdk.agentWalletTypedData(this.context.deployment, consent)
    return this.#typed(id, `consent:${purpose}`, typedData, async () => {
      if (agent.agent_id !== consent.agentId.toString() || consent.owner.toLowerCase() !== agent.operator.toLowerCase()
        || consent.newWallet.toLowerCase() !== agent.address.toLowerCase() || consent.deadline <= BigInt(this.now()) || consent.deadline > BigInt(this.now() + 600)) throw new Error('Consent differs from the registered agent and owner')
      const owner = await this.context.publicClient.readContract({ address: agent.registry, abi: sdk.identityAbi, functionName: 'ownerOf', args: [consent.agentId] })
      if (owner.toLowerCase() !== agent.operator.toLowerCase()) throw new Error('Registry owner differs from the operator')
      return sdk.agentWalletTypedData(this.context.deployment, consent)
    })
  }

  async signUpgrade(id: string, nonce: number): Promise<SignedAuthorization<number>> {
    const agent = this.#agent(id)
    if (agent.state !== 'created') throw new Error('Only a new agent can be upgraded')
    if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error('Invalid upgrade nonce')
    const contract = this.context.deployment.delegation.delegator
    const chainId = this.context.deployment.chainId
    const row = this.#request(id, 'upgrade', { method: 'eth_sign7702Authorization', contract, chainId, nonce })
    if (row.result_json !== null) return JSON.parse(row.result_json) as SignedAuthorization<number>
    const current = await this.context.publicClient.getTransactionCount({ address: agent.address, blockTag: 'pending' })
    if (current !== nonce) throw new Error('Upgrade nonce differs from the agent account')
    this.#agent(id)
    const authorization = await this.provider.signAuthorization(agent.privy_wallet_id, contract, chainId, nonce, row.id)
    if (authorization.address.toLowerCase() !== contract.toLowerCase() || authorization.chainId !== chainId || authorization.nonce !== nonce
      || (await recoverAuthorizationAddress({ authorization })).toLowerCase() !== agent.address.toLowerCase()) throw new Error('Upgrade signature is outside the authorized account and chain')
    this.#save(row, authorization)
    return authorization
  }
}

/** Execute a hosted agent action from one frozen intent, signing request and relay journal. */
import * as sdk from '@agent-jobs/sdk'
import { type Address, type Hex } from 'viem'
import { AgentStore, type AgentOperationRow, type ApprovalRow } from './agents.ts'
import { AgentSigning } from './agent-signing.ts'
import { GrantStore, grantSpecJson, parseGrantSpec } from './grants.ts'
import { ensureAgentGrants } from './agent-grant-renewal.ts'
import { mapAgentCalls, type ApprovedAgentAction } from './agent-call-mapper.ts'
import { SponsorDesk, type NamedSponsorEntry, type SponsorResult } from './sponsor.ts'
import type { Sql } from './store.ts'
import { AgentLifecycle } from './agent-lifecycle.ts'

export interface AgentPreparedCall {
  readonly transactions?: readonly sdk.TxRequest[]
  readonly sign?: { readonly typedData: string; readonly description?: string }
  readonly [key: string]: unknown
}

export interface AgentToolRequest {
  readonly tool: string
  readonly args: Record<string, unknown>
  readonly caller: { readonly address: Address }
}

export interface AgentExecutorDeps {
  readonly sql: Sql
  readonly now: () => number
  readonly context: sdk.Ctx
  readonly sponsor: SponsorDesk
  readonly signing: AgentSigning
  readonly prepareTool: (request: AgentToolRequest) => Promise<AgentPreparedCall>
  readonly verifyToolSigning: (request: AgentToolRequest & { typedData: string }) => Promise<string>
}

export interface AgentExecuteInput {
  readonly agentId: string
  readonly boardId: string
  readonly operationKey: string
  readonly tool: string
  readonly args: Record<string, unknown>
}

export type AgentExecuteResult =
  | { readonly status: 'confirmed' | 'rejected'; readonly operationId: Hex; readonly result: unknown }
  | { readonly status: 'approval'; readonly operationId: Hex; readonly approval: ApprovalRow }
  | { readonly status: 'pending' | 'reverted' | 'dropped'; readonly operationId: Hex; readonly result: SponsorResult }

function publicOutput(output: AgentPreparedCall): Record<string, unknown> {
  const { sign: _sign, transactions: _transactions, next: _next, ...result } = output
  return result
}

function jsonOutput(output: AgentPreparedCall): AgentPreparedCall {
  return JSON.parse(JSON.stringify(output, (_, value) => typeof value === 'bigint' ? value.toString() : value)) as AgentPreparedCall
}

export class AgentExecutor {
  readonly agents: AgentStore
  readonly grants: GrantStore
  #queue: Promise<unknown> = Promise.resolve()

  constructor(readonly deps: AgentExecutorDeps) {
    this.agents = new AgentStore(deps.sql, deps.now)
    this.grants = new GrantStore(deps.sql, deps.context)
  }

  execute(input: AgentExecuteInput): Promise<AgentExecuteResult> {
    const result = this.#queue.then(() => this.#execute(input))
    this.#queue = result.catch(() => undefined)
    return result
  }

  async #finish(operation: AgentOperationRow, address: Address, sent: SponsorResult): Promise<AgentExecuteResult> {
    if (sent.status === 'pending') return { status: 'pending', operationId: operation.id, result: sent }
    if (sent.status !== 'confirmed') {
      this.agents.saveOperation(operation.id, 'failed', { result: sent })
      return { status: sent.status, operationId: operation.id, result: sent }
    }
    const action = this.agents.step<AgentPreparedCall>(operation.id, 'action')!
    const result = { ...publicOutput(action), sponsorship: sent }
    const reported = this.agents.step(operation.id, 'reported')
    if (reported === undefined) {
      if (typeof action.taskId === 'string' || typeof JSON.parse(operation.intent_json).taskId === 'string') {
        const taskId = action.taskId ?? JSON.parse(operation.intent_json).taskId
        await this.deps.prepareTool({ tool: 'report_transaction', args: { taskId, txHash: sent.txHash }, caller: { address } })
      }
      if (typeof action.operationId === 'string') {
        await this.deps.prepareTool({ tool: 'report_operation', args: { operationId: action.operationId, txHash: sent.txHash }, caller: { address } })
      }
      this.agents.freezeStep(operation.id, 'reported', true)
    }
    this.agents.saveOperation(operation.id, 'confirmed', { result })
    this.deps.sql.run("UPDATE approvals SET status='executed' WHERE operation_id=? AND status='approved'", operation.id)
    return { status: 'confirmed', operationId: operation.id, result }
  }

  async #approved(operation: AgentOperationRow): Promise<ApprovedAgentAction> {
    const approval = this.agents.approval(operation.id)
    if (approval.status !== 'approved') throw new Error('Action requires an approved operator decision')
    const agent = this.agents.get(operation.agent_id)
    const request = JSON.parse(approval.request_json) as { token: Address; amount: string }
    const decision = JSON.parse(approval.decision_json ?? '{}') as { allowanceHash: Hex }
    const step = approval.kind === 'unstake' ? 'approved-grant-spec' : `approved-grant-spec:${decision.allowanceHash}`
    let spec = this.agents.step<string>(operation.id, step)
    if (spec === undefined) {
      const base = { delegator: agent.address!, salt: BigInt(operation.id), operationId: operation.id, amount: BigInt(request.amount) }
      let template: sdk.GrantSpec
      if (approval.kind === 'unstake') template = { ...base, kind: 'unstake', start: this.deps.now() }
      else {
        const allowance = this.grants.spec(decision.allowanceHash)
        if (allowance.kind !== 'allowance-once') throw new Error('Approved hire requires an exact one-off allowance')
        template = { ...base, kind: 'agent-approve-once', start: allowance.start, token: request.token }
      }
      spec = this.agents.freezeStep(operation.id, step, grantSpecJson(template))
    }
    const prepared = this.grants.prepare(agent.operator, parseGrantSpec(spec))
    await this.grants.confirm(prepared.hash, await this.deps.signing.signGrant(agent.id, prepared.hash))
    return approval.kind === 'unstake' ? { unstakeHash: prepared.hash } : { approvalHash: prepared.hash, allowanceHash: decision.allowanceHash }
  }

  async #action(input: AgentExecuteInput, operation: AgentOperationRow, address: Address): Promise<AgentPreparedCall> {
    const saved = this.agents.step<AgentPreparedCall>(operation.id, 'action')
    if (saved !== undefined) return saved
    let prepared = this.agents.step<AgentPreparedCall>(operation.id, 'prepared')
    if (prepared === undefined) {
      prepared = jsonOutput(await this.deps.prepareTool({ tool: input.tool, args: { ...input.args, idempotencyKey: operation.id }, caller: { address } }))
      this.agents.freezeStep(operation.id, 'prepared', prepared)
      this.agents.saveOperation(operation.id, 'prepared', { prepared })
    }
    let action = prepared
    if (prepared.sign !== undefined) {
      const typedData = prepared.sign.typedData
      const signature = await this.deps.signing.signTool(input.agentId, operation.id, typedData,
        () => this.deps.verifyToolSigning({ tool: input.tool, args: input.args, caller: { address }, typedData }))
      this.agents.saveOperation(operation.id, 'signed', { signatures: { primary: signature } })
      let args: Record<string, unknown>
      let tool: string
      if (input.tool === 'select_worker') {
        tool = 'submit_selection'
        args = { ...input.args, nonce: JSON.parse(typedData).message.nonce, signature }
      } else if (input.tool === 'prepare_activation') {
        tool = 'build_activation'
        args = { ...input.args, budgetSignature: signature }
      } else throw new Error('Signing tool has no authorized continuation')
      action = jsonOutput(await this.deps.prepareTool({ tool, args, caller: { address } }))
    }
    return this.agents.freezeStep(operation.id, 'action', action)
  }

  async #execute(input: AgentExecuteInput): Promise<AgentExecuteResult> {
    const agent = this.agents.get(input.agentId)
    if (agent.address === null || agent.privy_wallet_id === null || agent.state !== 'active' || agent.chain_id !== this.deps.context.deployment.chainId) throw new Error('Agent is not active on this chain')
    const operation = this.agents.begin(input.agentId, input.operationKey, input.boardId, input.tool, input.args)
    if (operation.stage === 'confirmed') return { status: 'confirmed', operationId: operation.id, result: JSON.parse(operation.result_json!) }
    if (operation.sponsor_operation_id !== null) {
      // Resume the original signed send before preparing calls, renewing grants or calling the routine signer.
      const sent = await this.deps.sponsor.submit(agent.address, [], operation.action_key)
      return this.#finish(operation, agent.address, sent)
    }
    if (operation.stage === 'failed') throw new Error('This operation is terminal; inspect its stored result')
    if (operation.stage === 'sending') {
      const action = this.agents.step<AgentPreparedCall>(operation.id, 'action')
      if (action === undefined || (action.transactions?.length ?? 0) !== 0) throw new Error('Sending operation is missing its relay link')
      const result = publicOutput(action)
      this.agents.saveOperation(operation.id, 'confirmed', { result })
      return { status: 'confirmed', operationId: operation.id, result }
    }
    let approved: ApprovedAgentAction = {}
    if (operation.stage === 'approval') {
      const approval = new AgentLifecycle({ sql: this.deps.sql, context: this.deps.context, now: this.deps.now, sponsor: this.deps.sponsor }).recoverApproval(operation.id, agent.operator)
      if (approval.status === 'pending') return { status: 'approval', operationId: operation.id, approval }
      if (approval.status === 'rejected') {
        this.agents.saveOperation(operation.id, 'failed', { result: approval })
        return { status: 'rejected', operationId: operation.id, result: approval }
      }
    }
    await this.deps.sponsor.ready()
    const action = await this.#action(input, operation, agent.address)
    if (input.tool === 'request_unstake' && this.agents.operation(operation.id).stage !== 'approval') {
      const call = action.transactions?.[0]
      if (call === undefined || action.transactions?.length !== 1 || typeof action.amount !== 'string') throw new Error('Unstake preparation requires its exact single vault call')
      const approval = this.agents.requestApproval(this.agents.operation(operation.id), 'unstake', { amount: action.amount, call })
      return { status: 'approval', operationId: operation.id, approval }
    }
    if (this.agents.operation(operation.id).stage === 'approval') approved = await this.#approved(operation)
    const transactions = action.transactions ?? []
    if (transactions.length === 0) {
      const result = publicOutput(action)
      this.agents.saveOperation(operation.id, 'sending')
      this.agents.saveOperation(operation.id, 'confirmed', { result })
      return { status: 'confirmed', operationId: operation.id, result }
    }
    const entriesStep = approved.allowanceHash === undefined ? 'entries' : `entries:${approved.allowanceHash}`
    let entries = this.agents.step<NamedSponsorEntry[]>(operation.id, entriesStep)
    if (entries === undefined) {
      await ensureAgentGrants(this.deps.context, this.agents, this.grants, this.deps.signing, agent.id, operation.id, this.deps.now())
      const mapped = await mapAgentCalls(this.deps.context, this.grants, { address: agent.address, operator: agent.operator }, transactions, this.deps.now(), approved)
      if (mapped.approval !== undefined) {
        if (approved.allowanceHash !== undefined) throw new Error('The approved exact allowance is unavailable; this operation has not been sent')
        const approval = this.agents.requestApproval(this.agents.operation(operation.id), 'hire-over-limit', mapped.approval)
        return { status: 'approval', operationId: operation.id, approval }
      }
      entries = this.agents.freezeStep(operation.id, entriesStep, mapped.entries)
    }
    const sent = await this.deps.sponsor.submit(agent.address, entries, operation.action_key, operation.id)
    return this.#finish(this.agents.operation(operation.id), agent.address, sent)
  }
}

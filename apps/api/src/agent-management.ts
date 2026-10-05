/** Private management RPC: SIWE controls decisions; Privy binds server wallet creation to its owner. */
import { AgentLifecycle, AgentOnboarding, AgentSigning, AgentStore, BoardError, GrantStore, RelaySender, SponsorDesk, type Sql } from '@agent-jobs/board'
import * as sdk from '@agent-jobs/sdk'
import { type Address, type Hex, isAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { privyOperator } from './privy-operator.ts'
import type { AgentRouteRequest } from './routes/agents.ts'

function text(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value.length === 0 || value.length > 1000) throw new BoardError('invalid', `Require ${key}`)
  return value
}

function hex(body: Record<string, unknown>, key: string, size: number): Hex {
  const value = text(body, key)
  if (!new RegExp(`^0x[0-9a-fA-F]{${size}}$`).test(value)) throw new BoardError('invalid', `Invalid ${key}`)
  return value as Hex
}

export async function agentManagement(input: {
  readonly request: AgentRouteRequest
  readonly sql: Sql
  readonly context: sdk.Ctx
  readonly operator: Address
  readonly privyToken?: string
  readonly bindings: Record<string, unknown>
  readonly relayKey: Hex
  readonly rpcUrl: string
  readonly now: () => number
  readonly execute: (agentId: string, tool: string, args: Record<string, unknown>, key: string, approvalId?: string, boardId?: string) => Promise<unknown>
}) {
  const { request, sql, context, operator, bindings, now } = input
  const { action, body } = request
  const id = request.id ?? ''
  const agents = new AgentStore(sql, now)
  const sponsor = new SponsorDesk({ sql, ctx: context, now, ...(/^0x[0-9a-fA-F]{64}$/.test(input.relayKey) ? { relay: { account: privateKeyToAccount(input.relayKey), rpcUrl: input.rpcUrl } } : {}), fail: (code, message) => new BoardError(code, message) })
  const lifecycle = new AgentLifecycle({ sql, context, now, sponsor })
  if (action === 'list') return { agents: agents.list(operator) }
  if (action === 'approvals') return { approvals: agents.approvals(operator) }
  if (action === 'status') return lifecycle.status(id, operator)
  if (action === 'recovery') {
    const agent = agents.owned(id, operator)
    const grants = new GrantStore(sql, context)
    return { agent, grants: [...grants.list(operator), ...grants.list(agent.address ?? operator)].filter(row => {
      const spec = grants.spec(row.delegation_hash)
      return row.delegator.toLowerCase() === agent.address?.toLowerCase() || (spec.kind === 'allowance' || spec.kind === 'allowance-once') && spec.agent.toLowerCase() === agent.address?.toLowerCase()
    }).map(row => ({ hash: row.delegation_hash, delegation: sdk.parseDelegation(row.delegation_json), status: row.status })) }
  }
  if (action === 'allowance-prepare') {
    const token = text(body, 'token')
    const amount = text(body, 'amount')
    if (!isAddress(token) || !/^[1-9][0-9]{0,77}$/.test(amount)) throw new BoardError('invalid', 'Invalid allowance token or amount')
    return lifecycle.prepareAllowance(id, operator, { key: text(body, 'key'), token, amount: BigInt(amount) })
  }
  if (action === 'allowance-confirm') return lifecycle.confirmAllowance(id, operator, text(body, 'key'), hex(body, 'hash', 64), hex(body, 'signature', 130))
  if (action === 'stop-access') return lifecycle.stopAccess(id, operator)
  if (action === 'revoke') return lifecycle.revoke(id, operator)
  if (action === 'approval-prepare') return lifecycle.prepareApproval(id, operator)
  if (action === 'approval-decide' || action === 'approval-retry') {
    const approval = action === 'approval-decide' ? await lifecycle.decideApproval(id, operator, body.approved === true, body.signature === undefined ? undefined : hex(body, 'signature', 130)) : agents.approval(id)
    const agent = agents.owned(approval.agent_id, operator)
    if (approval.status !== 'approved') return { approval }
    const operation = agents.operation(approval.operation_id)
    return input.execute(agent.id, operation.tool, JSON.parse(operation.intent_json) as Record<string, unknown>, operation.action_key, approval.id, operation.board_id)
  }
  if (action === 'execute') {
    const agent = agents.owned(id, operator)
    const tool = text(body, 'tool')
    if (!['sweep_earnings', 'request_unstake', 'withdraw_stake', 'check_operation'].includes(tool)) throw new BoardError('forbidden', 'This website action is unavailable')
    const args = typeof body.args === 'object' && body.args !== null ? body.args as Record<string, unknown> : {}
    return input.execute(agent.id, tool, args, text(body, 'operationKey'))
  }
  const appSecret = String(bindings.PRIVY_APP_SECRET ?? '')
  const signerKey = String(bindings.PRIVY_SIGNER_KEY ?? '')
  if (appSecret === '' || appSecret === 'unset' || signerKey === '' || signerKey === 'unset') throw new BoardError('unavailable', 'Privy agent management is unavailable')
  const provider = new sdk.PrivyServer({ appId: String(bindings.PRIVY_APP_ID ?? ''), appSecret, sign: await sdk.p256AuthorizationSigner(signerKey) })
  if (action === 'signer-removed') {
    const agent = agents.owned(id, operator)
    if (agent.state !== 'revoked' || agent.privy_wallet_id === null) throw new BoardError('conflict', 'Stop hosted access first')
    const wallet = await provider.getWallet(agent.privy_wallet_id)
    if (wallet.address.toLowerCase() !== agent.address?.toLowerCase() || wallet.signers.some(signer => signer.signerId === bindings.PRIVY_SIGNER_ID)) throw new BoardError('conflict', 'Privy has not confirmed removal of the routine signer')
    sql.run('UPDATE agents SET revoke_json=? WHERE id=?', JSON.stringify({ ...JSON.parse(agent.revoke_json), signerRemoved: true, signerRemovedAt: now() }), id)
    return lifecycle.status(id, operator)
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.relayKey)) throw new BoardError('unavailable', 'The relay is unavailable')
  const onboarding = new AgentOnboarding({ sql, context, now, sponsor, signing: new AgentSigning(sql, context, provider, now), signerId: String(bindings.PRIVY_SIGNER_ID ?? ''), policyId: String(bindings.PRIVY_POLICY_ID ?? ''),
    relay: new RelaySender(sql, context, privateKeyToAccount(input.relayKey), input.rpcUrl, now) })
  if (action === 'create') {
    if (input.privyToken === undefined) throw new BoardError('unauthenticated', 'A current Privy session is required')
    const userId = await privyOperator({ token: input.privyToken, appId: String(bindings.PRIVY_APP_ID ?? ''), appSecret, operator, now: now() })
    if (userId === undefined) throw new BoardError('forbidden', 'The Privy user does not own this embedded operator wallet')
    return onboarding.create({ id: text(body, 'id'), operator, userId, name: text(body, 'name') }, provider)
  }
  agents.owned(id, operator)
  if (action === 'resume') return onboarding.resume(id)
  if (action === 'registration-prepare') return onboarding.prepareRegistration(id, operator)
  if (action === 'registration-confirm') return onboarding.register(id, operator, hex(body, 'hash', 64), hex(body, 'signature', 130))
  throw new BoardError('not-found', 'No such agent lifecycle action')
}

/** The reserved management object's MCP and operator action runtime. */
import { AgentDirectory, AgentStore, AgentSigning, AgentExecutor, AgentLifecycle, AgentPermissions, BoardError, SponsorDesk, failureFromReply, migrateAgentSchema, SPONSOR_OBJECT_NAME, type Sql } from '@sidequest/board'
import * as sdk from '@sidequest/sdk'
import { type Address, type Hex, encodeFunctionData, erc20Abi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { BoardCall, BoardReply } from './board.ts'
import { resolveOAuth } from './oauth.ts'
import { networkTool, permittedTool, requiredToolScope } from './mcp-policy.ts'
import { resourceBoard } from './oauth-validation.ts'
import { toJson } from './tools.ts'
import { fromD1 } from '@sidequest/indexer'
import { publishAgentOffer, type OfferBucket } from './agent-offers.ts'
import { tenantAgentRequest } from './agent-requests.ts'
import { reportRelayWatchFailure, watchRelay } from './relay-watch.ts'
import { agentFeedEvents, approvalUrl, recordAgentEvents } from './feed-agent.ts'
import { directoryAudience, directoryPort } from './directory-object.ts'

const key32 = (key: string) => /^0x[0-9a-fA-F]{64}$/.test(key)

export interface AgentExecuteRequest {
  env: BoardCall['env']
  tool: string
  args: Record<string, unknown>
  agentId: string
  resource: string
  bearer?: string
  ip?: string
  operator?: Address
}

export async function runAgent(runtime: { req: AgentExecuteRequest; bindings: Record<string, unknown>; sql: Sql; stateId: string }): Promise<string> {
  const { req, bindings, sql } = runtime
  const namespace = bindings.Board as { idFromName(name: string): { toString(): string }; get(id: unknown): { call(req: BoardCall): Promise<string>; verifyAgentSigning(req: BoardCall & { typedData: string }): Promise<string> } }
  if (namespace.idFromName(SPONSOR_OBJECT_NAME).toString() !== runtime.stateId || req.env.network !== bindings.NETWORK) throw new BoardError('forbidden', 'management object identity mismatch')
  migrateAgentSchema(sql)
  if (req.operator === undefined) {
    const grant = await resolveOAuth(sql, req.bearer, req.resource, Math.floor(Date.now() / 1000))
    if (grant === undefined || !grant.agentIds.includes(req.agentId) || !permittedTool(grant, req.tool)
      || resourceBoard(req.resource, new URL(req.resource).origin) !== req.env.boardId) throw new BoardError('forbidden', 'This connection does not grant this agent, tool or board')
  }
  const agents = new AgentStore(sql, () => Math.floor(Date.now() / 1000))
  const agent = req.operator === undefined ? agents.get(req.agentId) : agents.owned(req.agentId, req.operator)
  agents.touch(agent.id)
  const { operationKey, managedAgentId: _managedAgentId, ...args } = req.args
  if (requiredToolScope(req.tool) !== 'sidequest:read' && typeof operationKey !== 'string') throw new BoardError('invalid', 'Every write requires a stable operationKey; retry with the same key')
  if (req.tool === 'apply' || req.tool === 'submit_quote') {
    if (args.agentId !== undefined && args.agentId !== agent.agent_id) throw new BoardError('forbidden', 'Use this connection\'s registered agentId')
    args.agentId = agent.agent_id
  }
  const ctx = sdk.context(req.env.network, 'main', req.env.rpcUrl)
  const sponsor = new SponsorDesk({ sql, ctx, now: () => Math.floor(Date.now() / 1000), ...(key32(req.env.relayKey) ? { relay: { account: privateKeyToAccount(req.env.relayKey as Hex), rpcUrl: req.env.rpcUrl } } : {}), fail: (code, message) => new BoardError(code, message) })
  if (req.tool === 'agent_status') return toJson({ ok: true, result: await new AgentLifecycle({ sql, context: ctx, now: () => Math.floor(Date.now() / 1000), sponsor }).status(agent.id, agent.operator) })
  if (req.tool === 'list_approvals') return toJson({ ok: true, result: { approvals: agents.approvals(agent.operator).filter(row => row.agent_id === agent.id) } })
  if (!networkTool(req.env.network, req.tool)) throw new BoardError('forbidden', 'This tool is not available on this network yet')
  const permissions = new AgentPermissions({ sql, context: ctx, now: () => Math.floor(Date.now() / 1000) })
  if (req.tool === 'get_supported_permissions') return toJson({ ok: true, result: sdk.supportedPermissions(ctx.deployment) })
  if (req.tool === 'get_permissions') return toJson({ ok: true, result: { permissions: permissions.list(agent) } })
  if (req.tool === 'revoke_permission') return toJson({ ok: true, result: permissions.stop(agent, String(args.permissionId ?? '')) })
  if (req.tool === 'check_operation') {
    const operation = agents.operation(String(args.operationId ?? ''))
    if (operation.agent_id !== agent.id) throw new BoardError('forbidden', 'Operation belongs to another agent')
    const result = operation.sponsor_operation_id === null ? operation : await sponsor.operation(agent.address!, operation.sponsor_operation_id)
    return toJson({ ok: true, result })
  }
  const prepare = (tool: string, input: Record<string, unknown>): BoardCall => tenantAgentRequest(req, agent.address!, tool, input)
  const tenant = namespace.get(namespace.idFromName(req.env.boardId))
  if (requiredToolScope(req.tool) === 'sidequest:read') return tenant.call(prepare(req.tool, args))
  const signerKey = typeof bindings.PRIVY_SIGNER_KEY === 'string' ? bindings.PRIVY_SIGNER_KEY : ''
  const appSecret = typeof bindings.PRIVY_APP_SECRET === 'string' ? bindings.PRIVY_APP_SECRET : ''
  const provider = new sdk.PrivyServer({ appId: String(bindings.PRIVY_APP_ID ?? ''), appSecret, sign: async payload => {
    if (signerKey === '' || signerKey === 'unset') throw new BoardError('unavailable', 'Hosted agent signing is unavailable')
    return (await sdk.p256AuthorizationSigner(signerKey))(payload)
  } })
  const signing = new AgentSigning(sql, ctx, provider, () => Math.floor(Date.now() / 1000))
  if (req.tool === 'advertise_service' || req.tool === 'withdraw_service') {
    if (agent.agent_id === null) throw new BoardError('conflict', 'Register this agent before listing it')
    const audience = directoryAudience(new URL(req.resource).origin)
    const directory = new AgentDirectory({ agents, signing, audience, boardId: req.env.boardId, port: directoryPort(bindings, { network: req.env.network, rpcUrl: req.env.rpcUrl, audience, agentId: agent.agent_id }) })
    const listing = req.tool === 'advertise_service'
      ? await directory.advertise(agent.id, operationKey as string, args.service)
      : await directory.withdraw(agent.id, operationKey as string, args.serviceId === undefined ? {} : { serviceId: String(args.serviceId) })
    return toJson({ ok: true, result: { listing } })
  }
  const executor = new AgentExecutor({ sql, now: () => Math.floor(Date.now() / 1000), context: ctx, signing,
    sponsor,
    verifyAction: action => publishAgentOffer({ sql: fromD1(bindings.Database as never), bucket: bindings.Manifests as OfferBucket | undefined,
      boardId: req.env.boardId, action, now: Math.floor(Date.now() / 1000) }),
    prepareTool: async input => {
      if (input.tool === 'sweep_earnings') {
        const token = String(input.args.token ?? '')
        if (![...ctx.deployment.rewardTokens, ctx.deployment.factory].some(address => address.toLowerCase() === token.toLowerCase())) throw new BoardError('forbidden', 'Sweep only configured tokens')
        const amount = await ctx.publicClient.readContract({ address: token as Address, abi: erc20Abi, functionName: 'balanceOf', args: [agent.address!] })
        if (amount === 0n) throw new BoardError('conflict', 'This token balance is empty')
        return { token, amount: amount.toString(), transactions: [{ to: token as Address, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [agent.operator, amount] }), value: '0', description: 'Move earnings to your operator wallet', chainId: ctx.deployment.chainId }] }
      }
      if (input.tool === 'request_permissions') {
        return { request: permissions.parse(agent, input.args.permission as sdk.PermissionRequest, input.args.standing === true) }
      }
      if (input.tool === 'use_permission') {
        return permissions.use(agent, String(input.args.permissionId ?? ''), typeof input.args.transfer === 'object' && input.args.transfer !== null ? { transfer: input.args.transfer as { amount?: unknown } } : {})
      }
      const reply = JSON.parse(await tenant.call(prepare(input.tool, input.args))) as BoardReply
      if (!reply.ok) throw failureFromReply(reply)
      const action = reply.result as import('@sidequest/board').AgentPreparedCall
      return action
    },
    verifyToolSigning: input => tenant.verifyAgentSigning({ ...prepare(input.tool, input.args), typedData: input.typedData }),
  })
  try {
    const key = typeof operationKey === 'string' ? operationKey : crypto.randomUUID()
    const result = await executor.execute({ agentId: agent.id, boardId: req.env.boardId, tool: req.tool, args, operationKey: key })
    // Inbox rows for the agent and its operator, plus the operator's signing link; never fails the action.
    const now = Math.floor(Date.now() / 1000)
    await recordAgentEvents(bindings.Database === undefined ? undefined : fromD1(bindings.Database as never), req.env.network, agent.operator,
      agentFeedEvents({ network: req.env.network, agent, tool: req.tool, operationKey: key, result, now }), now)
    // An approval tells the agent where its operator signs, so it can forward the link instead of asking how.
    return toJson({ ok: true, result: result.status === 'approval' ? { ...result, approveUrl: approvalUrl(req.env.network, agent, result.approval.id) } : result })
  } catch (error) {
    // A floor refusal sent nothing; alert the owners now instead of waiting for the indexer's next balance check.
    if ((error as { reason?: unknown }).reason === 'floor' && bindings.Database !== undefined) {
      await watchRelay(fromD1(bindings.Database as never), { network: req.env.network, now: Math.floor(Date.now() / 1000), relay: ctx.deployment.relay, balance: () => ctx.publicClient.getBalance({ address: ctx.deployment.relay }) })
        .catch(reportRelayWatchFailure)
    }
    throw error
  }
}

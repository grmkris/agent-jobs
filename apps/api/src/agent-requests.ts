/** Trusted request context across the edge, management object and tenant continuation. */
import type { Address } from 'viem'
import type { BoardCall } from './board.ts'
import type { AgentExecuteRequest } from './agent-runtime.ts'
import type { AgentRouteRequest } from './routes/agents.ts'

export interface AgentManagementRequest {
  readonly env: BoardCall['env']
  readonly request: AgentRouteRequest
  readonly bearer?: string
  readonly privyToken?: string
  readonly ip?: string
}

export function managementRequest(
  env: BoardCall['env'],
  request: AgentRouteRequest,
  bearer: string | undefined,
  headers: Readonly<Record<string, string | undefined>>,
): AgentManagementRequest {
  const ip = headers['cf-connecting-ip']
  const privyToken = headers['x-privy-token']
  return {
    env,
    request,
    ...(bearer === undefined ? {} : { bearer }),
    ...(privyToken === undefined ? {} : { privyToken }),
    ...(ip === undefined ? {} : { ip }),
  }
}

export function operatorRequest(
  request: AgentManagementRequest,
  operator: Address,
  action: {
    readonly agentId: string
    readonly tool: string
    readonly args: Record<string, unknown>
    readonly key: string
    readonly boardId?: string | undefined
  },
): AgentExecuteRequest {
  return {
    env: { ...request.env, boardId: action.boardId ?? request.env.boardId },
    tool: action.tool,
    args: { ...action.args, operationKey: action.key },
    agentId: action.agentId,
    resource: `${request.env.uri}${request.env.boardId === 'public' ? '' : `/b/${request.env.boardId}`}/mcp`,
    operator,
    ...(request.bearer === undefined ? {} : { bearer: request.bearer }),
    ...(request.ip === undefined ? {} : { ip: request.ip }),
  }
}

export function tenantAgentRequest(
  request: AgentExecuteRequest,
  address: Address,
  tool: string,
  args: Record<string, unknown>,
): BoardCall {
  return {
    tool,
    args,
    env: request.env,
    caller: address,
    agentAuth: {
      agentId: request.agentId,
      resource: request.resource,
      ...(request.operator === undefined ? {} : { operator: true }),
    },
    ...(request.ip === undefined ? {} : { ip: request.ip }),
    ...(request.bearer === undefined ? {} : { bearer: request.bearer }),
  }
}

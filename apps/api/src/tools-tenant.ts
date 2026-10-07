/**
 * The registry tools (ADR-0008), answered by the API Worker itself rather than a board's Durable Object: they read
 * and write the board registry in D1, which no single board owns. Listed next to the board tools over MCP and REST.
 */
import {
  type CreateBoardInput,
  PUBLIC_BOARD_ID,
  type TenantConfig,
  TenantError,
  type TenantToken,
  tenantDefaults,
  tenantRefusal,
  validateBoardInput,
} from '@sidequest/board'
import type { AsyncSql } from '@sidequest/indexer'
import type * as sdk from '@sidequest/sdk'
import type { Address } from 'viem'
import { createBoard, getBoard, listBoards, updateBoard } from './registry.ts'

interface TenantToolDeps {
  readonly sql: AsyncSql
  readonly deployment: sdk.Deployment
  readonly resolveToken: (address: Address) => Promise<TenantToken>
  readonly now: () => number
}

export interface TenantTool {
  readonly description: string
  readonly inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: readonly string[] }
  readonly run: (
    deps: TenantToolDeps,
    caller: Address | undefined,
    tenant: TenantConfig,
    args: Record<string, unknown>,
  ) => Promise<unknown>
}

const str = (description: string) => ({ type: 'string', description })
const strs = (description: string) => ({ type: 'array', items: { type: 'string' }, description })

const boardProperties = {
  name: str('Display name (1–80 characters).'),
  stacks: strs('Stacks the board offers (main); default: every deployed stack.'),
  defaultStack: str('The stack a new offer uses when the publisher names none; default: the first of `stacks`.'),
  rewardTokens: strs(
    'Reward tokens the board offers: known symbols or any ERC-20 addresses; default: every known token.',
  ),
  deliverableDefault: {
    type: 'object',
    description: 'What a new offer accepts when the publisher does not say (ADR-0006): {accepts: [...], target?}.',
  },
  defaultApprover: str('Optional: the approver of every new offer unless the publisher names one.'),
  allowedOrigins: strs(
    'Origins (https://host[:port], or http://localhost:*) whose pages may call this board from the browser and sign in with their own domain.',
  ),
  drip: {
    type: 'boolean',
    description:
      'Testnet only: give each address that signs in through this board a small MON drip from the relay, once.',
  },
  sponsor: {
    type: 'string',
    enum: ['none', 'privy', 'pimlico'],
    description: 'Reserved: how the host sponsors gas. Only "none" does anything today.',
  },
  verifiers: {
    type: 'object',
    description:
      'Evidence producers this board trusts: {"<producer-id>": ["0x…verifier"]}. A producer must be registered on the evaluator by the admin to attach evidence on-chain.',
  },
  webhookUrl: str('Optional https URL the board POSTs signed events to on task state changes.'),
}

const secretHex = () =>
  [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('')

function inputOf(config: TenantConfig): CreateBoardInput {
  return {
    slug: config.id,
    name: config.name,
    stacks: config.stacks,
    defaultStack: config.defaultStack,
    rewardTokens: config.rewardTokens,
    ...(config.deliverableDefault === undefined ? {} : { deliverableDefault: config.deliverableDefault }),
    ...(config.defaultApprover === undefined ? {} : { defaultApprover: config.defaultApprover }),
    allowedOrigins: config.allowedOrigins,
    drip: config.drip,
    sponsor: config.sponsor,
    verifiers: config.verifiers,
    ...(config.webhookUrl === undefined ? {} : { webhookUrl: config.webhookUrl }),
  }
}

/** What anyone may see of a board: its config, which carries no secret. */
export const boardView = (config: TenantConfig, relay?: string) => ({
  ...config,
  ...(relay === undefined ? {} : { relay }),
  public: config.id === PUBLIC_BOARD_ID,
})

export const tenantTools: Record<string, TenantTool> = {
  list_boards: {
    description:
      'Every hosted board: slug, name, stacks, reward tokens, defaults and allowed origins. No sign-in needed.',
    inputSchema: { type: 'object', properties: {} },
    run: async (deps, _caller, tenant) => {
      const boards = await listBoards(deps.sql)
      const pub = tenant.id === PUBLIC_BOARD_ID ? [tenant] : []
      return { boards: [...pub, ...boards].map((config) => boardView(config, deps.deployment.relay)) }
    },
  },

  get_board: {
    description: 'One board by slug (default: the board this call came to).',
    inputSchema: { type: 'object', properties: { boardId: str('The board slug.') } },
    run: async (deps, _caller, tenant, a) => {
      const id = typeof a.boardId === 'string' ? a.boardId : tenant.id
      if (id === tenant.id) return { board: boardView(tenant, deps.deployment.relay) }
      const stored = await getBoard(deps.sql, id)
      if (stored === undefined) throw new TenantError('invalid', `no board "${id}"`)
      return { board: boardView(stored.config, deps.deployment.relay) }
    },
  },

  create_board: {
    description:
      'Create a board of your own (self-serve): pick a slug, the stacks and reward tokens it offers, defaults for new offers, and the origins that may embed it. You become its owner. Its tools live at /b/<slug>/api and /b/<slug>/mcp. Returns the webhook secret once when a webhook URL is set.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: str('3–32 characters of a-z, 0-9 and "-"; the board id in every route.'),
        ...boardProperties,
      },
      required: ['slug', 'name'],
    },
    run: async (deps, caller, _tenant, a) => {
      if (caller === undefined) throw new TenantError('forbidden', 'sign in first (auth_challenge → auth_login)')
      const input = a as unknown as CreateBoardInput
      const config = await validateBoardInput(input, deps.deployment, caller, deps.now(), deps.resolveToken)
      const webhookSecret = config.webhookUrl === undefined ? null : secretHex()
      const created = await createBoard(deps.sql, config, webhookSecret, deps.now())
      if (!created) throw new TenantError('invalid', `board "${config.id}" already exists`)
      return { board: boardView(config, deps.deployment.relay), ...(webhookSecret === null ? {} : { webhookSecret }) }
    },
  },

  update_board: {
    description:
      'Owner: change a board you created. Fields you leave out keep their value; `rotateWebhookSecret: true` returns a new secret once.',
    inputSchema: {
      type: 'object',
      properties: {
        boardId: str('The board slug (default: this board).'),
        ...boardProperties,
        rotateWebhookSecret: { type: 'boolean' },
      },
    },
    run: async (deps, caller, tenant, a) => {
      if (caller === undefined) throw new TenantError('forbidden', 'sign in first (auth_challenge → auth_login)')
      const id = typeof a.boardId === 'string' ? a.boardId : tenant.id
      if (id === PUBLIC_BOARD_ID) throw new TenantError('forbidden', 'the hosted board has no owner')
      const stored = await getBoard(deps.sql, id)
      if (stored === undefined) throw new TenantError('invalid', `no board "${id}"`)
      if (stored.config.owner === null || stored.config.owner.toLowerCase() !== caller.toLowerCase())
        throw new TenantError('forbidden', 'only the board owner may change it')
      const merged: CreateBoardInput = { ...inputOf(stored.config), ...(a as Partial<CreateBoardInput>), slug: id }
      const config: TenantConfig = {
        ...(await validateBoardInput(merged, deps.deployment, stored.config.owner, deps.now(), deps.resolveToken)),
        createdAt: stored.config.createdAt,
      }
      const rotate =
        a.rotateWebhookSecret === true || (config.webhookUrl !== undefined && stored.webhookSecret === null)
      const webhookSecret = rotate ? secretHex() : config.webhookUrl === undefined ? null : undefined
      await updateBoard(deps.sql, config, webhookSecret, deps.now())
      return {
        board: boardView(config, deps.deployment.relay),
        ...(rotate && webhookSecret !== undefined && webhookSecret !== null ? { webhookSecret } : {}),
      }
    },
  },
}

/** Board tools whose arguments a tenant shapes: the board's defaults filled in, stacks and tokens outside it refused. */
const PUBLISH_TOOLS: ReadonlySet<string> = new Set(['create_task', 'request_quotes'])

export function tenantArgs(tenant: TenantConfig, tool: string, args: Record<string, unknown>): Record<string, unknown> {
  if (!PUBLISH_TOOLS.has(tool)) return args
  const refusal = tenantRefusal(tenant, args)
  if (refusal !== undefined) throw new TenantError('invalid', refusal)
  const filled = tenantDefaults(tenant, args)
  const again = tenantRefusal(tenant, filled)
  if (again !== undefined) throw new TenantError('invalid', again)
  return filled
}

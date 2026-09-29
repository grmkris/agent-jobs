/**
 * Tenant boards (ADR-0008): a host app (a game, a product site, an OS instance) gets a board of its own, addressed by
 * slug (`/b/<slug>/api`, `/b/<slug>/mcp`). A board is a row in the registry plus one Durable Object; its config says
 * which stacks and reward tokens it offers, what a new offer defaults to, which origins may embed it, and whether new
 * sign-ins get a MON drip on testnet. Nothing here moves money: a board owner controls listing policy, never funds.
 *
 * Pure values and functions; the API Worker owns the registry storage.
 */
import type * as sdk from '@agent-jobs/sdk'
import { type Address, getAddress, isAddress } from 'viem'
import { type DeliverableSpec, validateSpec } from './deliverable.ts'

export interface TenantToken {
  readonly address: Address
  readonly symbol: string
  readonly decimals: number
}

export type SponsorMode = 'none' | 'privy' | 'pimlico'

export interface TenantConfig {
  /** The slug in the route. `public` is the hosted board that predates tenants. */
  readonly id: string
  readonly name: string
  /** The wallet that created the board and may update it; null for `public`. */
  readonly owner: Address | null
  readonly stacks: readonly sdk.StackName[]
  readonly defaultStack: sdk.StackName
  /** The reward tokens an offer on this board may name: a subset of the deployment's allowlist. */
  readonly rewardTokens: readonly Address[]
  readonly tokens: readonly TenantToken[]
  /** What a new offer accepts when the publisher does not say (ADR-0006); absent → git only. */
  readonly deliverableDefault?: DeliverableSpec
  /** The approver of a new offer when the publisher does not name one; absent → the creator. */
  readonly defaultApprover?: Address
  /** Origins (scheme://host[:port]) whose pages may call this board from the browser and sign in with their own domain. */
  readonly allowedOrigins: readonly string[]
  /** Testnet only: the relay sends a small MON drip to an address on its first sign-in through this board. */
  readonly drip: boolean
  /** Reserved: how the host sponsors gas (D6). Only `none` does anything today. */
  readonly sponsor: SponsorMode
  /** Evidence producers this board trusts: a producer id → the verifier addresses it signs with (ADR-0008, D10). */
  readonly verifiers: Readonly<Record<string, readonly Address[]>>
  /** Where the board POSTs signed events on task state changes; the secret lives next to it, never in this object. */
  readonly webhookUrl?: string
  readonly createdAt: number
}

export const BOARD_SLUG = /^[a-z0-9-]{3,32}$/
export const PUBLIC_BOARD_ID = 'public'

/** What `create_board` takes. Tokens by symbol or address; origins as scheme://host[:port]. */
export interface CreateBoardInput {
  readonly slug: string
  readonly name: string
  readonly stacks?: readonly string[]
  readonly defaultStack?: string
  readonly rewardTokens?: readonly string[]
  readonly deliverableDefault?: DeliverableSpec
  readonly defaultApprover?: string
  readonly allowedOrigins?: readonly string[]
  readonly drip?: boolean
  readonly sponsor?: string
  readonly verifiers?: Readonly<Record<string, readonly string[]>>
  readonly webhookUrl?: string
}

export class TenantError extends Error {
  constructor(
    readonly code: 'invalid' | 'forbidden',
    message: string,
  ) {
    super(message)
  }
}

/** The pre-tenant hosted board as a tenant: every stack, every reward token, no drip, no extra origins. */
export function publicTenant(deployment: sdk.Deployment, tokens: readonly TenantToken[]): TenantConfig {
  return {
    id: PUBLIC_BOARD_ID,
    name: 'agent-jobs',
    owner: null,
    stacks: Object.keys(deployment.stacks) as sdk.StackName[],
    defaultStack: 'main',
    rewardTokens: deployment.rewardTokens,
    tokens,
    allowedOrigins: [],
    drip: false,
    sponsor: 'none',
    verifiers: {},
    createdAt: 0,
  }
}

/** The origin (scheme://host[:port]) of a URL-ish string, or undefined. */
export function originOf(value: string | undefined | null): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  try {
    const u = new URL(value)
    return u.origin === 'null' ? undefined : u.origin
  } catch {
    return undefined
  }
}

/**
 * Whether a page at `origin` may use this board from the browser: the API's own host (Explore proxies same-origin
 * through it), one of the board's allowed origins, or any localhost port when `http://localhost:*` is allowed.
 */
export function isAllowedOrigin(tenant: TenantConfig, origin: string | undefined, selfHost: string): boolean {
  if (origin === undefined) return false
  let host: string
  try {
    host = new URL(origin).host
  } catch {
    return false
  }
  if (host === selfHost) return true
  for (const allowed of tenant.allowedOrigins) {
    if (allowed === origin) return true
    if (allowed === 'http://localhost:*' && /^http:\/\/localhost(:\d+)?$/.test(origin)) return true
  }
  return false
}

/** Resolves a token the caller named (symbol or address) to one of the board's tokens, or undefined. */
export function tenantToken(tenant: TenantConfig, token: string | undefined): TenantToken | undefined {
  if (token === undefined) return undefined
  if (isAddress(token)) return tenant.tokens.find((t) => t.address.toLowerCase() === token.toLowerCase())
  return tenant.tokens.find((t) => t.symbol.toLowerCase() === token.toLowerCase())
}

/** Why a publish-shaped call (`create_task`, `request_quotes`, `pick_quote`) is not allowed on this board, if it is not. */
export function tenantRefusal(tenant: TenantConfig, args: Record<string, unknown>): string | undefined {
  const stack = args.stack
  if (typeof stack === 'string' && !tenant.stacks.includes(stack as sdk.StackName)) {
    return `board "${tenant.id}" offers stacks ${tenant.stacks.join(', ')}, not "${stack}"`
  }
  const tokens = typeof args.token === 'string' ? [args.token] : Array.isArray(args.tokens) ? (args.tokens as unknown[]).filter((t): t is string => typeof t === 'string') : []
  for (const t of tokens) {
    if (tenantToken(tenant, t) === undefined) {
      return `board "${tenant.id}" pays in ${tenant.tokens.map((x) => x.symbol).join(', ')}, not "${t}"`
    }
  }
  return undefined
}

/** The same args with the board's defaults filled in where the caller said nothing. */
export function tenantDefaults(tenant: TenantConfig, args: Record<string, unknown>): Record<string, unknown> {
  return {
    ...args,
    ...(args.stack === undefined ? { stack: tenant.defaultStack } : {}),
    ...(args.approver === undefined && tenant.defaultApprover !== undefined ? { approver: tenant.defaultApprover } : {}),
    ...(args.deliverable === undefined && tenant.deliverableDefault !== undefined ? { deliverable: tenant.deliverableDefault } : {}),
  }
}

/**
 * Checks and normalises what a creator asks for; `resolveToken` reads symbol and decimals for an allowlisted address.
 * Throws `TenantError('invalid', …)` with the first problem.
 */
export async function validateBoardInput(
  input: CreateBoardInput,
  deployment: sdk.Deployment,
  owner: Address,
  now: number,
  resolveToken: (address: Address) => Promise<TenantToken>,
): Promise<TenantConfig & { readonly owner: Address }> {
  if (!BOARD_SLUG.test(input.slug)) throw new TenantError('invalid', 'slug must be 3–32 characters of a-z, 0-9 and "-"')
  if (input.slug === PUBLIC_BOARD_ID) throw new TenantError('invalid', `"${PUBLIC_BOARD_ID}" is the hosted board`)
  const name = input.name.trim()
  if (name === '' || name.length > 80) throw new TenantError('invalid', 'name must be 1–80 characters')
  const deployed = Object.keys(deployment.stacks) as sdk.StackName[]
  const stacks = (input.stacks ?? deployed).map((s) => {
    if (!deployed.includes(s as sdk.StackName)) throw new TenantError('invalid', `unknown stack "${s}"; deployed: ${deployed.join(', ')}`)
    return s as sdk.StackName
  })
  if (stacks.length === 0) throw new TenantError('invalid', 'a board offers at least one stack')
  const defaultStack = (input.defaultStack ?? stacks[0]) as sdk.StackName
  if (!stacks.includes(defaultStack)) throw new TenantError('invalid', `defaultStack "${defaultStack}" is not one of the board's stacks`)
  const allowed = deployment.rewardTokens.map((a) => a.toLowerCase())
  const wanted = input.rewardTokens ?? deployment.rewardTokens
  const tokens: TenantToken[] = []
  for (const t of wanted) {
    const address = isAddress(t) ? getAddress(t) : deployment.rewardTokens.find((a) => a.toLowerCase() === t.toLowerCase())
    let resolved: TenantToken | undefined
    if (address !== undefined && allowed.includes(address.toLowerCase())) resolved = await resolveToken(address)
    else {
      for (const a of deployment.rewardTokens) {
        const r = await resolveToken(a)
        if (r.symbol.toLowerCase() === t.toLowerCase()) {
          resolved = r
          break
        }
      }
    }
    if (resolved === undefined) throw new TenantError('invalid', `"${t}" is not an allowlisted reward token on this deployment`)
    if (!tokens.some((x) => x.address === resolved.address)) tokens.push(resolved)
  }
  if (tokens.length === 0) throw new TenantError('invalid', 'a board pays in at least one reward token')
  const allowedOrigins = (input.allowedOrigins ?? []).map((o) => {
    if (o === 'http://localhost:*') return o
    const origin = originOf(o)
    if (origin === undefined || origin !== o || !/^https?:$/.test(new URL(o).protocol)) {
      throw new TenantError('invalid', `origin "${o}" must be scheme://host[:port] with no path (or http://localhost:*)`)
    }
    if (new URL(o).protocol === 'http:' && !/^http:\/\/localhost(:\d+)?$/.test(o)) throw new TenantError('invalid', `origin "${o}" must be https (http only for localhost)`)
    return origin
  })
  if (input.deliverableDefault !== undefined) validateSpec(input.deliverableDefault)
  if (input.defaultApprover !== undefined && !isAddress(input.defaultApprover)) throw new TenantError('invalid', 'defaultApprover must be a 0x address')
  const sponsor = (input.sponsor ?? 'none') as SponsorMode
  if (!['none', 'privy', 'pimlico'].includes(sponsor)) throw new TenantError('invalid', 'sponsor is none, privy or pimlico')
  const verifiers: Record<string, Address[]> = {}
  for (const [producer, addrs] of Object.entries(input.verifiers ?? {})) {
    if (!/^[a-z0-9-]{1,32}$/.test(producer)) throw new TenantError('invalid', `producer id "${producer}" must be a-z, 0-9 and "-"`)
    verifiers[producer] = addrs.map((a) => {
      if (!isAddress(a)) throw new TenantError('invalid', `verifier "${a}" is not a 0x address`)
      return getAddress(a)
    })
  }
  if (input.webhookUrl !== undefined && !input.webhookUrl.startsWith('https://')) throw new TenantError('invalid', 'webhookUrl must be https')
  return {
    id: input.slug,
    name,
    owner,
    stacks,
    defaultStack,
    rewardTokens: tokens.map((t) => t.address),
    tokens,
    ...(input.deliverableDefault === undefined ? {} : { deliverableDefault: input.deliverableDefault }),
    ...(input.defaultApprover === undefined ? {} : { defaultApprover: getAddress(input.defaultApprover) }),
    allowedOrigins,
    drip: input.drip === true,
    sponsor,
    verifiers,
    ...(input.webhookUrl === undefined ? {} : { webhookUrl: input.webhookUrl }),
    createdAt: now,
  }
}

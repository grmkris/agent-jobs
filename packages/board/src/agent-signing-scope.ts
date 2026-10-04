/** Exact envelopes and field schemas, checked in addition to Privy's allowlist. */
import * as sdk from '@agent-jobs/sdk'
import { type Address, isAddress } from 'viem'
import { canonicalAgentArgs } from './agents.ts'

export interface AgentTypedData {
  domain: Record<string, unknown>
  types: Record<string, readonly { name: string; type: string }[]>
  primaryType: string
  message: Record<string, unknown>
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Malformed typed data object')
  return value as Record<string, unknown>
}

function keys(value: Record<string, unknown>, names: readonly string[]): void {
  if (Object.keys(value).toSorted().join(',') !== [...names].toSorted().join(',')) throw new Error('Typed data fields differ from the exact schema')
}

export function parseAgentTypedData(json: string): AgentTypedData {
  const raw = object(JSON.parse(json))
  keys(raw, ['domain', 'types', 'primaryType', 'message'])
  if (typeof raw.primaryType !== 'string') throw new Error('Invalid primary type')
  return { domain: object(raw.domain), types: object(raw.types) as AgentTypedData['types'], primaryType: raw.primaryType, message: object(raw.message) }
}

/** Reconstruct expected data from trusted SDK builders or authoritative board records before using this comparison. */
export function assertExactAgentTypedData(actual: string, expected: string): void {
  const value = parseAgentTypedData(actual)
  const trusted = parseAgentTypedData(expected)
  if (canonicalAgentArgs(value) !== canonicalAgentArgs(trusted)) throw new Error('Signing request differs from the frozen authorized action')
}

function integer(value: unknown, bits: number): void {
  if (!(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) throw new Error('Invalid typed data integer')
  if (BigInt(value) >= 1n << BigInt(bits)) throw new Error('Typed data integer exceeds its field')
}

function fields(message: Record<string, unknown>, schema: readonly { name: string; type: string }[]): void {
  keys(message, schema.map(field => field.name))
  for (const field of schema) {
    const value = message[field.name]
    if (field.type === 'address' && (typeof value !== 'string' || !isAddress(value))) throw new Error('Invalid typed data address')
    if (field.type === 'bytes32' && (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value))) throw new Error('Invalid typed data hash')
    if (field.type.startsWith('uint')) integer(value, Number(field.type.slice(4)))
  }
}

/** No extra schemas, message fields or domain fields can enter a routine signing call. */
export function assertAgentEnvelope(ctx: sdk.GrantContext, json: string, address: Address): AgentTypedData {
  const typed = parseAgentTypedData(json)
  const definitions = {
    Selection: { domain: sdk.holdingDomain(ctx.deployment.chainId, ctx.stack.holding), types: sdk.selectionTypes },
    SetBudgetAuthorization: { domain: sdk.coreDomain(ctx.deployment.chainId, ctx.deployment.core), types: sdk.setBudgetTypes },
    SubmitAuthorization: { domain: sdk.coreDomain(ctx.deployment.chainId, ctx.deployment.core), types: sdk.submitTypes },
    Delegation: { domain: sdk.delegationDomain(ctx.deployment), types: sdk.DELEGATION_TYPES },
    AgentWalletSet: { domain: { name: 'ERC8004IdentityRegistry', version: '1', chainId: ctx.deployment.chainId, verifyingContract: ctx.deployment.identity }, types: sdk.agentWalletTypes },
  }
  const definition = definitions[typed.primaryType as keyof typeof definitions]
  if (definition === undefined) throw new Error('Primary type is outside the routine signing policy')
  const expected = parseAgentTypedData(sdk.typedDataJson(definition.domain, definition.types, typed.primaryType, {}))
  if (canonicalAgentArgs(typed.domain) !== canonicalAgentArgs(expected.domain) || canonicalAgentArgs(typed.types) !== canonicalAgentArgs(expected.types)) throw new Error('Domain or types are outside the routine signing policy')
  const schema = typed.types[typed.primaryType]!
  fields(typed.message, schema)
  if (typed.primaryType === 'Delegation') {
    if (String(typed.message.delegator).toLowerCase() !== address.toLowerCase() || String(typed.message.delegate).toLowerCase() !== ctx.deployment.relay.toLowerCase()) throw new Error('Delegation signer or delegate differs from the bound agent and relay')
    if (typed.message.authority !== sdk.ROOT_AUTHORITY || !Array.isArray(typed.message.caveats)) throw new Error('Delegation must use root authority and exact template caveats')
    for (const caveat of typed.message.caveats) fields(object(caveat), typed.types.Caveat!)
  }
  if (typed.primaryType === 'AgentWalletSet' && String(typed.message.newWallet).toLowerCase() !== address.toLowerCase()) throw new Error('Consent wallet is not this agent')
  if (typed.primaryType === 'SetBudgetAuthorization' || typed.primaryType === 'SubmitAuthorization') {
    if (String(typed.message.signer).toLowerCase() !== address.toLowerCase() || typed.message.optParamsHash !== sdk.EMPTY_HASH) throw new Error('Authorization signer or optional parameters mismatch')
  }
  return typed
}

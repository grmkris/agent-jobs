/**
 * The Privy policy behind the execution budget (ADR-0005). A creator's embedded wallet carries one policy for the
 * board's signer; its rules are the union of that wallet's live grants, one rule per task. A token rule allows
 * exactly one shape: an ERC-20 `transfer(to, amount)` on the grant's token, on this chain, with no value, `amount` at
 * most the cap, before the expiry; `to` is free (the worker may pay anyone). A call rule allows calls to one
 * function of one contract, with at most the cap in native value, before the expiry. An x402 rule allows signing
 * EIP-3009 payment authorizations on the chain's USDC, each at most the per-payment cap, before the expiry. Privy checks each transaction
 * on its own; the cumulative cap is the board's ledger.
 */
import { type AbiFunction, type Address, parseAbiItem } from 'viem'

export type BudgetRuleInput = TokenRuleInput | CallRuleInput | X402RuleInput

export interface TokenRuleInput {
  readonly kind?: 'token'
  readonly taskId: string
  readonly chainId: number
  readonly token: Address
  /** Base units. */
  readonly cap: bigint
  /** Unix seconds. */
  readonly expiresAt: number
}

/** A call budget: calls to `target`'s one `function` only, each with at most `cap` native value. */
export interface CallRuleInput {
  readonly kind: 'call'
  readonly taskId: string
  readonly chainId: number
  readonly target: Address
  /** Human-readable ABI of the allowed function. */
  readonly function: string
  /** Wei. */
  readonly cap: bigint
  /** Unix seconds. */
  readonly expiresAt: number
}

/** An x402 budget: EIP-3009 payment authorizations on `token`, each at most `perCall`. */
export interface X402RuleInput {
  readonly kind: 'x402'
  readonly taskId: string
  readonly chainId: number
  readonly token: Address
  /** Base units. */
  readonly perCall: bigint
  /** Unix seconds. */
  readonly expiresAt: number
}

export interface PolicyCondition {
  readonly field_source: string
  readonly field: string
  readonly operator: string
  readonly value: string
  readonly abi?: readonly unknown[]
  readonly typed_data?: { readonly types: Record<string, ReadonlyArray<{ name: string; type: string }>>; readonly primary_type: string }
}

/** EIP-3009's signed message, the one an x402 `exact` payment on EVM is. */
export const TRANSFER_WITH_AUTHORIZATION = [
  { name: 'from', type: 'address' },
  { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' },
  { name: 'nonce', type: 'bytes32' },
] as const

export interface PolicyRule {
  readonly name: string
  readonly method: string
  readonly action: 'ALLOW' | 'DENY'
  readonly conditions: readonly PolicyCondition[]
}

export const ERC20_TRANSFER_ABI = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const

/** Rule names are how a grant's rule is found again: `budget-<taskId>`. */
export const budgetRuleName = (taskId: string) => `budget-${taskId}`

export function budgetRule(g: BudgetRuleInput): PolicyRule {
  if (g.kind === 'x402') {
    return {
      name: budgetRuleName(g.taskId),
      method: 'eth_signTypedData_v4',
      action: 'ALLOW',
      conditions: [
        { field_source: 'ethereum_typed_data_domain', field: 'chainId', operator: 'eq', value: String(g.chainId) },
        // Privy compares strings case-sensitively: the board always signs with the checksummed address.
        { field_source: 'ethereum_typed_data_domain', field: 'verifyingContract', operator: 'eq', value: g.token },
        {
          field_source: 'ethereum_typed_data_message',
          field: 'value',
          operator: 'lte',
          value: g.perCall.toString(),
          typed_data: { types: { TransferWithAuthorization: [...TRANSFER_WITH_AUTHORIZATION] }, primary_type: 'TransferWithAuthorization' },
        },
        { field_source: 'system', field: 'current_unix_timestamp', operator: 'lt', value: String(g.expiresAt) },
      ],
    }
  }
  if (g.kind === 'call') {
    const fn = parseAbiItem(g.function) as AbiFunction
    return {
      name: budgetRuleName(g.taskId),
      method: 'eth_sendTransaction',
      action: 'ALLOW',
      conditions: [
        { field_source: 'ethereum_transaction', field: 'chain_id', operator: 'eq', value: String(g.chainId) },
        { field_source: 'ethereum_transaction', field: 'to', operator: 'eq', value: g.target },
        { field_source: 'ethereum_transaction', field: 'value', operator: 'lte', value: g.cap.toString() },
        // Privy decodes the calldata with this one-function ABI: any other function fails to match.
        { field_source: 'ethereum_calldata', field: 'function_name', operator: 'eq', value: fn.name, abi: [fn] },
        { field_source: 'system', field: 'current_unix_timestamp', operator: 'lt', value: String(g.expiresAt) },
      ],
    }
  }
  return {
    name: budgetRuleName(g.taskId),
    method: 'eth_sendTransaction',
    action: 'ALLOW',
    conditions: [
      // Privy compares chain ids as decimal strings; a number silently matches nothing.
      { field_source: 'ethereum_transaction', field: 'chain_id', operator: 'eq', value: String(g.chainId) },
      { field_source: 'ethereum_transaction', field: 'to', operator: 'eq', value: g.token },
      { field_source: 'ethereum_transaction', field: 'value', operator: 'eq', value: '0' },
      { field_source: 'ethereum_calldata', field: 'transfer.amount', operator: 'lte', value: g.cap.toString(), abi: ERC20_TRANSFER_ABI },
      { field_source: 'system', field: 'current_unix_timestamp', operator: 'lt', value: String(g.expiresAt) },
    ],
  }
}

/** Privy caps policy names at 50 characters; the board keeps the policy id, the name is for people. */
export const budgetPolicyName = (wallet: Address) => `aj-budget ${wallet.slice(0, 10).toLowerCase()}…${wallet.slice(-6).toLowerCase()}`

/** The whole policy body for one creator wallet: every live grant's rule, ordered by task for a stable body. */
export function budgetPolicyBody(wallet: Address, grants: readonly BudgetRuleInput[], ownerUserId?: string) {
  return {
    version: '1.0',
    chain_type: 'ethereum',
    name: budgetPolicyName(wallet),
    rules: grants.toSorted((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0)).map(budgetRule),
    ...(ownerUserId === undefined ? {} : { owner: { user_id: ownerUserId } }),
  }
}

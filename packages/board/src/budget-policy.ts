/**
 * The Privy policy behind the execution budget (ADR-0005). A creator's embedded wallet carries one policy for the
 * board's signer; its rules are the union of that wallet's live grants, one rule per task. A rule allows exactly one
 * shape: an ERC-20 `transfer(to, amount)` on the grant's token, on this chain, with no value, `amount` at most the
 * cap, before the expiry. `to` is free (the worker may pay anyone). Privy checks each transaction on its own; the
 * cumulative cap is the board's ledger.
 */
import type { Address } from 'viem'

export interface BudgetRuleInput {
  readonly taskId: string
  readonly chainId: number
  readonly token: Address
  /** Base units. */
  readonly cap: bigint
  /** Unix seconds. */
  readonly expiresAt: number
}

export interface PolicyCondition {
  readonly field_source: string
  readonly field: string
  readonly operator: string
  readonly value: string
  readonly abi?: readonly unknown[]
}

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

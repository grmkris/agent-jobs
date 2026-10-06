/** OAuth scopes are checked by both discovery and the Durable Object executing the action. */
import type { OAuthGrant } from './oauth.ts'

const READ_TOOLS = new Set([
  'get_instructions', 'whoami', 'protocol_info', 'list_tasks', 'get_task', 'task_index', 'list_quote_requests',
  'list_quotes', 'get_budget', 'list_applications', 'get_stake', 'list_delegations', 'fee_quote', 'mining_proof', 'list_boards',
  'get_board', 'list_directory', 'get_directory_agent', 'list_approvals', 'agent_status', 'get_supported_permissions', 'get_permissions', 'inbox',
])
const HIRE_TOOLS = new Set(['create_task', 'request_quotes', 'pick_quote', 'select_worker', 'cancel_task', 'approve_work', 'reject_work', 'x402_pay'])
const WORK_TOOLS = new Set(['apply', 'submit_quote', 'prepare_activation', 'submit_work', 'dispute', 'add_statement', 'advertise_service', 'withdraw_service'])
const SHARED_TOOLS = new Set(['settlement_actions', 'request_unstake', 'cancel_unstake', 'withdraw_stake', 'sweep_earnings', 'check_operation',
  'request_permissions', 'use_permission', 'revoke_permission'])
/** Permissions on demand (ADR-0015) stay testnet-only until their mainnet promotion. */
export const PERMISSION_TOOLS = new Set(['get_supported_permissions', 'get_permissions', 'request_permissions', 'use_permission', 'revoke_permission'])
/** A hosted agent's own directory listing (WS8) stays testnet-only until its signer rules reach mainnet. */
export const LISTING_TOOLS = new Set(['advertise_service', 'withdraw_service'])
/** x402 waits for the testnet routine signer policy; mainnet remains hidden. */
export const X402_TOOLS = new Set(['x402_pay'])

export function networkTool(network: string, name: string): boolean {
  return network !== 'monad-mainnet' || (!PERMISSION_TOOLS.has(name) && !LISTING_TOOLS.has(name) && !X402_TOOLS.has(name))
}
const CONTINUATIONS = new Set(['submit_selection', 'build_activation', 'report_transaction', 'report_operation'])

export function requiredToolScope(name: string): 'sidequest:read' | 'sidequest:hire' | 'sidequest:work' | 'write' | undefined {
  if (READ_TOOLS.has(name)) return 'sidequest:read'
  if (HIRE_TOOLS.has(name)) return 'sidequest:hire'
  if (WORK_TOOLS.has(name)) return 'sidequest:work'
  if (SHARED_TOOLS.has(name)) return 'write'
  return undefined
}

export function permittedTool(grant: Pick<OAuthGrant, 'scopes'>, name: string, internal = false): boolean {
  if (internal && CONTINUATIONS.has(name)) return grant.scopes.includes('sidequest:hire') || grant.scopes.includes('sidequest:work')
  const scope = requiredToolScope(name)
  if (scope === 'write') return grant.scopes.includes('sidequest:hire') || grant.scopes.includes('sidequest:work')
  return scope !== undefined && grant.scopes.includes(scope)
}

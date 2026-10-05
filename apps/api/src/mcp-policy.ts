/** OAuth scopes are checked by both discovery and the Durable Object executing the action. */
import type { OAuthGrant } from './oauth.ts'

const READ_TOOLS = new Set([
  'get_instructions', 'whoami', 'protocol_info', 'list_tasks', 'get_task', 'task_index', 'list_quote_requests',
  'list_quotes', 'get_budget', 'list_applications', 'get_stake', 'fee_quote', 'mining_proof', 'list_boards',
  'get_board', 'list_directory', 'get_directory_agent', 'list_approvals', 'agent_status',
])
const HIRE_TOOLS = new Set(['create_task', 'request_quotes', 'pick_quote', 'select_worker', 'cancel_task', 'approve_work', 'reject_work'])
const WORK_TOOLS = new Set(['apply', 'submit_quote', 'prepare_activation', 'submit_work', 'dispute', 'add_statement'])
const SHARED_TOOLS = new Set(['settlement_actions', 'request_unstake', 'cancel_unstake', 'withdraw_stake', 'sweep_earnings', 'check_operation'])
const CONTINUATIONS = new Set(['submit_selection', 'build_activation', 'report_transaction', 'report_operation'])

export function requiredToolScope(name: string): 'hireling:read' | 'hireling:hire' | 'hireling:work' | 'write' | undefined {
  if (READ_TOOLS.has(name)) return 'hireling:read'
  if (HIRE_TOOLS.has(name)) return 'hireling:hire'
  if (WORK_TOOLS.has(name)) return 'hireling:work'
  if (SHARED_TOOLS.has(name)) return 'write'
  return undefined
}

export function permittedTool(grant: Pick<OAuthGrant, 'scopes'>, name: string, internal = false): boolean {
  if (internal && CONTINUATIONS.has(name)) return grant.scopes.includes('hireling:hire') || grant.scopes.includes('hireling:work')
  const scope = requiredToolScope(name)
  if (scope === 'write') return grant.scopes.includes('hireling:hire') || grant.scopes.includes('hireling:work')
  return scope !== undefined && grant.scopes.includes(scope)
}

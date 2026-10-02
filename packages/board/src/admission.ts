export const readOnlyHostedTools = new Set([
  'protocol_info', 'whoami', 'list_tasks', 'get_task', 'list_quote_requests', 'list_quotes', 'get_budget', 'task_index',
  'list_pools', 'get_pool', 'pledged_by', 'list_applications', 'list_candidates', 'list_disputes',
  'get_dispute_bundle', 'settlement_actions', 'list_boards', 'get_board', 'auth_challenge', 'auth_login',
  'list_directory', 'get_directory_agent',
  'telegram_status',
  'sponsor_status', 'sponsor_operation',
  'get_stake', 'fee_quote', 'collect_actions',
])

export const drainHostedTools = new Set([
  'submit_work', 'report_transaction', 'approve_work', 'reject_work', 'dispute', 'add_statement',
  'request_evidence', 'arbiter_lease', 'prepare_ruling', 'submit_ruling', 'cancel_ruling', 'revoke_budget', 'cancel_task', 'pool_refund', 'sponsor_revoke',
])

export const recoveryHostedTools = new Set([
  'submit_work', 'report_transaction', 'approve_work', 'reject_work', 'dispute', 'add_statement',
  'request_evidence', 'arbiter_lease', 'prepare_ruling', 'submit_ruling', 'cancel_ruling', 'revoke_budget', 'cancel_task', 'pool_refund', 'sponsor_revoke',
])

export const disabledP0HostedTools = new Set([
  'create_pool', 'pledge', 'launch_pool',
])

/**
 * Every tool which can reach the hosted board.  Production admission is open, but an
 * unknown tool must still fail closed instead of becoming a write by accident.
 * Keep this list alongside the API tool registry when adding a new hosted tool.
 */
export const hostedToolNames = new Set([
  ...readOnlyHostedTools,
  ...drainHostedTools,
  ...disabledP0HostedTools,
  'auth_challenge', 'auth_login', 'whoami', 'create_task', 'request_quotes', 'submit_quote', 'pick_quote',
  'spend_budget', 'spend_budget_call', 'upgrade_account', 'budget_grant_prepare', 'budget_grant_confirm', 'get_budget',
  'revoke_budget', 'report_transaction', 'list_applications', 'select_worker', 'submit_selection', 'publish_transactions',
  'cancel_task', 'approve_work', 'reject_work', 'apply', 'prepare_activation', 'build_activation', 'submit_work',
  'dispute', 'add_statement', 'prepare_entry', 'submit_entry', 'award', 'request_evidence', 'arbiter_lease',
  'prepare_ruling', 'submit_ruling', 'cancel_ruling', 'settlement_actions', 'list_boards', 'get_board', 'create_board', 'update_board',
  'prepare_agent_profile', 'prepare_directory_enrollment', 'enroll_directory', 'prepare_heartbeat', 'post_heartbeat',
  'prepare_service_ad', 'publish_service_ad', 'prepare_revoke_service_ad', 'revoke_service_ad',
  'telegram_status', 'telegram_link_prepare', 'telegram_link_confirm', 'telegram_unlink',
  'sponsor_status', 'sponsor_prepare', 'sponsor_confirm', 'sponsor_revoke', 'sponsor_submit', 'sponsor_operation',
  'top_up', 'stake', 'request_unstake', 'withdraw_stake', 'get_stake', 'fee_quote', 'collect_actions',
])

export interface HostedAdmission {
  readonly drain: boolean
}

export const openAdmission: HostedAdmission = { drain: false }

/** Missing or malformed runtime values drain; admission is otherwise open. */
export function parseHostedAdmission(drain: string): HostedAdmission {
  return { drain: drain !== '0' && drain.toLowerCase() !== 'false' }
}

export function admissionFailure(admission: HostedAdmission, network: string, _board: string, tool: string, caller: string | undefined): string | undefined {
  if (network !== 'monad-mainnet' || readOnlyHostedTools.has(tool)) return undefined
  if (!hostedToolNames.has(tool)) return 'unknown hosted tool'
  if (admission.drain && !drainHostedTools.has(tool)) return 'production hosted writes are in drain mode'
  if (disabledP0HostedTools.has(tool)) return 'hosted pools are disabled in production'
  if (recoveryHostedTools.has(tool) && caller !== undefined) return undefined
  if (admission.drain && drainHostedTools.has(tool)) return 'production recovery requires an authenticated wallet'
  if (admission.drain) return 'production hosted writes are in drain mode'
  if (caller === undefined || !/^0x[0-9a-fA-F]{40}$/.test(caller)) return 'production hosted admission requires an authenticated wallet'
  return undefined
}

export function hostedTargetBoard(board: string, tool: string, args: Record<string, unknown>): string {
  if (tool === 'create_board') return typeof args.slug === 'string' ? args.slug : ''
  if (tool === 'update_board') return typeof args.boardId === 'string' ? args.boardId : board
  return board
}

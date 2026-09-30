export const readOnlyHostedTools = new Set([
  'protocol_info', 'whoami', 'list_tasks', 'get_task', 'list_quote_requests', 'list_quotes', 'get_budget', 'task_index',
  'list_pools', 'get_pool', 'pledged_by', 'list_applications', 'list_candidates', 'list_disputes',
  'get_dispute_bundle', 'settlement_actions', 'list_boards', 'get_board', 'auth_challenge', 'auth_login',
  'list_directory', 'get_directory_agent',
])

export const drainHostedTools = new Set([
  'submit_work', 'report_transaction', 'approve_work', 'reject_work', 'dispute', 'add_statement',
  'request_evidence', 'arbiter_lease', 'prepare_ruling', 'submit_ruling', 'revoke_budget', 'cancel_task', 'pool_refund',
])

export const recoveryHostedTools = new Set([
  'submit_work', 'report_transaction', 'approve_work', 'reject_work', 'dispute', 'add_statement',
  'request_evidence', 'arbiter_lease', 'prepare_ruling', 'submit_ruling', 'revoke_budget', 'cancel_task', 'pool_refund',
])

export const disabledP0HostedTools = new Set([
  'create_pool', 'pledge', 'launch_pool', 'upgrade_account', 'spend_budget', 'spend_budget_call',
  'budget_grant_prepare', 'budget_grant_confirm',
])

export interface HostedAdmission {
  readonly enabled: boolean
  readonly drain: boolean
  readonly wallets: readonly string[]
  readonly boards: readonly string[]
  readonly actions: readonly string[]
}

export const openAdmission: HostedAdmission = { enabled: false, drain: false, wallets: [], boards: [], actions: [] }

const normalized = (value: string) => value.split(',').map(item => item.trim().toLowerCase()).filter(Boolean)

export function parseHostedAdmission(wallets: string, boards: string, drain: string, actions = ''): HostedAdmission {
  const allowedWallets = normalized(wallets).filter(item => /^0x[0-9a-f]{40}$/.test(item))
  const allowedBoards = normalized(boards).filter(item => /^[a-z0-9-]{3,32}$/.test(item))
  return { enabled: true, drain: drain !== '0' && drain.toLowerCase() !== 'false', wallets: allowedWallets, boards: allowedBoards, actions: normalized(actions) }
}

export function admissionFailure(admission: HostedAdmission, network: string, board: string, tool: string, caller: string | undefined): string | undefined {
  if (network !== 'monad-mainnet' || readOnlyHostedTools.has(tool)) return undefined
  if (admission.drain && !drainHostedTools.has(tool)) return 'production hosted writes are in drain mode'
  if (disabledP0HostedTools.has(tool)) return 'this hosted feature is disabled for production P0'
  if (recoveryHostedTools.has(tool) && caller !== undefined) return undefined
  if (admission.drain && drainHostedTools.has(tool)) return 'production recovery requires an authenticated wallet'
  if (admission.drain) return 'production hosted writes are in drain mode'
  if (!admission.enabled || caller === undefined || !admission.wallets.includes(caller.toLowerCase()) || !admission.boards.includes(board.toLowerCase()) || !admission.actions.includes(tool)) {
    return 'production hosted admission requires an approved wallet and board'
  }
  return undefined
}

export function hostedTargetBoard(board: string, tool: string, args: Record<string, unknown>): string {
  if (tool === 'create_board') return typeof args.slug === 'string' ? args.slug : ''
  if (tool === 'update_board') return typeof args.boardId === 'string' ? args.boardId : board
  return board
}

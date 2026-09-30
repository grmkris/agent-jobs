import { expect, test } from 'vitest'
import { admissionFailure, parseHostedAdmission } from './admission.ts'

const wallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const admission = parseHostedAdmission(wallet, 'ops', '0', 'create_task,create_board,submit_work')

test('testnet hosted writes remain open', () => {
  expect(admissionFailure(admission, 'monad-testnet', 'other', 'create_pool', '0xdef')).toBeUndefined()
})

test('production reads remain public but writes require both wallet and board', () => {
  expect(admissionFailure(admission, 'monad-mainnet', 'other', 'protocol_info', undefined)).toBeUndefined()
  expect(admissionFailure(admission, 'monad-mainnet', 'ops', 'create_task', undefined)).toContain('approved wallet')
  expect(admissionFailure(admission, 'monad-mainnet', 'ops', 'create_task', '0xdef')).toContain('approved wallet')
  expect(admissionFailure(admission, 'monad-mainnet', 'other', 'create_task', '0xabc')).toContain('approved wallet')
  expect(admissionFailure(admission, 'monad-mainnet', 'ops', 'create_task', wallet)).toBeUndefined()
})

test('drain mode refuses every production hosted write', () => {
  const draining = parseHostedAdmission(wallet, 'ops', '1', 'create_pool')
  expect(admissionFailure(draining, 'monad-mainnet', 'ops', 'create_board', wallet)).toContain('drain')
  expect(admissionFailure(draining, 'monad-mainnet', 'ops', 'protocol_info', undefined)).toBeUndefined()
})

test('drain retains proof, settlement reconciliation, and revocation paths', () => {
  const draining = parseHostedAdmission(wallet, 'ops', '1', 'submit_work,approve_work,request_evidence,submit_ruling,revoke_budget,report_transaction')
  for (const tool of ['submit_work', 'approve_work', 'request_evidence', 'submit_ruling', 'revoke_budget', 'report_transaction']) {
    expect(admissionFailure(draining, 'monad-mainnet', 'other', tool, wallet)).toBeUndefined()
  }
  for (const tool of ['create_task', 'create_pool', 'launch_pool', 'upgrade_account', 'request_quotes']) {
    expect(admissionFailure(draining, 'monad-mainnet', 'ops', tool, '0xabc')).toContain('drain')
  }
})

test('existing-party recovery tools remain available to the service for authorization', () => {
  const restricted = parseHostedAdmission(wallet, 'ops', '0', '')
  for (const tool of ['submit_work', 'report_transaction', 'approve_work', 'reject_work', 'dispute', 'add_statement', 'request_evidence', 'arbiter_lease', 'prepare_ruling', 'submit_ruling', 'revoke_budget', 'cancel_task', 'pool_refund']) {
    expect(admissionFailure(restricted, 'monad-mainnet', 'unlisted', tool, wallet)).toBeUndefined()
  }
})

test('malformed wallet and board entries fail closed', () => {
  const malformed = parseHostedAdmission('0xabc,not-an-address', 'ops,not a slug', '0', 'create_task')
  expect(admissionFailure(malformed, 'monad-mainnet', 'ops', 'create_task', wallet)).toContain('approved wallet')
  expect(malformed.wallets).toEqual([])
  expect(malformed.boards).toEqual(['ops'])
})

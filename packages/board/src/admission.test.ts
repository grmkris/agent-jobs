import { expect, test } from 'vitest'
import { admissionFailure, parseHostedAdmission, recoveryHostedTools } from './admission.ts'

const wallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const admission = parseHostedAdmission('0')

test('testnet policy remains open', () => {
  expect(admissionFailure(admission, 'monad-testnet', 'other', 'create_pool', undefined)).toBeUndefined()
})

test('production reads are public and every authenticated wallet and board can write', () => {
  expect(admissionFailure(admission, 'monad-mainnet', 'other', 'protocol_info', undefined)).toBeUndefined()
  expect(admissionFailure(admission, 'monad-mainnet', 'ops', 'create_task', undefined)).toContain('authenticated wallet')
  expect(admissionFailure(admission, 'monad-mainnet', 'ops', 'create_task', '0xdef')).toContain('authenticated wallet')
  for (const board of ['public', 'ops', 'new-board']) expect(admissionFailure(admission, 'monad-mainnet', board, 'create_task', wallet)).toBeUndefined()
})

test('account upgrades and budgets are open; pools remain disabled', () => {
  for (const tool of ['upgrade_account', 'spend_budget', 'spend_budget_call', 'budget_grant_prepare', 'budget_grant_confirm']) {
    expect(admissionFailure(admission, 'monad-mainnet', 'public', tool, wallet)).toBeUndefined()
  }
  for (const tool of ['create_pool', 'pledge', 'launch_pool']) expect(admissionFailure(admission, 'monad-mainnet', 'public', tool, wallet)).toContain('disabled')
})

test('drain retains authenticated proof, settlement, appeal, and revocation', () => {
  const draining = parseHostedAdmission('1')
  for (const tool of recoveryHostedTools) {
    expect(admissionFailure(draining, 'monad-mainnet', 'other', tool, wallet)).toBeUndefined()
    expect(admissionFailure(draining, 'monad-mainnet', 'other', tool, undefined)).toContain('authenticated')
  }
  for (const tool of ['create_task', 'create_pool', 'launch_pool', 'upgrade_account', 'request_quotes']) {
    expect(admissionFailure(draining, 'monad-mainnet', 'ops', tool, wallet)).toContain('drain')
  }
})

test('malformed drain values and unknown tools fail closed', () => {
  for (const value of ['', 'no', 'off', ' 0 ']) expect(parseHostedAdmission(value).drain).toBe(true)
  for (const value of ['0', 'false', 'FALSE']) expect(parseHostedAdmission(value).drain).toBe(false)
  expect(admissionFailure(admission, 'monad-mainnet', 'public', 'future_unknown_mutator', wallet)).toContain('unknown')
})

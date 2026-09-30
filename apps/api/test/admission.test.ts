import { admissionFailure, parseHostedAdmission, readOnlyHostedTools, recoveryHostedTools } from '@agent-jobs/board'
import { expect, test } from 'vitest'
import { hostedCallFailure } from '../src/hosted-admission.ts'
import { tools } from '../src/tools.ts'
import { tenantTools } from '../src/tools-tenant.ts'
import { directoryTools } from '../src/directory.ts'

const wallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const stranger = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const allTools = Object.keys({ ...tools, ...tenantTools, ...directoryTools })
const policy = parseHostedAdmission(wallet, 'public,ops', '0', allTools.join(','))

test('every REST/MCP tool is a read, existing-party recovery, or deny-by-default write', () => {
  const denied = parseHostedAdmission('', '', '0', '')
  for (const tool of allTools) {
    if (readOnlyHostedTools.has(tool)) {
      expect(admissionFailure(denied, 'monad-mainnet', 'public', tool, undefined), tool).toBeUndefined()
    } else {
      expect(admissionFailure(denied, 'monad-mainnet', 'public', tool, undefined), tool).toBeDefined()
      if (!recoveryHostedTools.has(tool)) expect(admissionFailure(denied, 'monad-mainnet', 'public', tool, wallet), tool).toBeDefined()
    }
    expect(admissionFailure(denied, 'monad-testnet', 'public', tool, undefined), tool).toBeUndefined()
  }
  expect(admissionFailure(policy, 'monad-mainnet', 'public', 'future_unknown_mutator', wallet)).toBeDefined()
})

test.each(['workers.dev', 'direct REST', 'MCP', 'embed'])('%s dispatch does not trust caller, origin, delegated wallet, or nested batch arguments', () => {
  const malicious = { caller: wallet, address: wallet, origin: 'https://hireling.xyz', boardId: 'ops', network: 'monad-testnet', steps: [{ caller: wallet, tool: 'create_task' }], admission: { enabled: false } }
  for (const tool of ['create_task', 'request_quotes', 'apply', 'publish_transactions', 'select_worker', 'prepare_activation', 'create_board', 'update_board', 'upgrade_account', 'create_pool']) {
    expect(hostedCallFailure(policy, 'monad-mainnet', 'public', tool, malicious, stranger), tool).toBeDefined()
    expect(hostedCallFailure(policy, 'monad-mainnet', 'public', tool, malicious, undefined), tool).toBeDefined()
  }
})

test('alternate and newly created boards are checked by target; revocation closes new writes', () => {
  expect(hostedCallFailure(policy, 'monad-mainnet', 'other', 'create_task', {}, wallet)).toBeDefined()
  expect(hostedCallFailure(policy, 'monad-mainnet', 'public', 'create_board', { slug: 'other' }, wallet)).toBeDefined()
  expect(hostedCallFailure(policy, 'monad-mainnet', 'public', 'update_board', { boardId: 'other' }, wallet)).toBeDefined()
  expect(hostedCallFailure(policy, 'monad-mainnet', 'public', 'create_board', { slug: 'ops' }, wallet)).toBeUndefined()
  const revoked = parseHostedAdmission('', 'public,ops', '0', allTools.join(','))
  expect(hostedCallFailure(revoked, 'monad-mainnet', 'public', 'create_task', {}, wallet)).toBeDefined()
  expect(hostedCallFailure(revoked, 'monad-mainnet', 'public', 'submit_work', {}, wallet)).toBeUndefined()
})

test('drain cannot be bypassed with an approved wallet/action and preserves authenticated recovery', () => {
  const draining = { ...policy, drain: true }
  for (const tool of allTools) {
    if (readOnlyHostedTools.has(tool) || recoveryHostedTools.has(tool)) continue
    expect(hostedCallFailure(draining, 'monad-mainnet', 'public', tool, {}, wallet), tool).toBeDefined()
  }
  for (const tool of recoveryHostedTools) expect(hostedCallFailure(draining, 'monad-mainnet', 'other', tool, {}, wallet), tool).toBeUndefined()
})

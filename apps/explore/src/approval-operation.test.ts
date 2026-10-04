import * as sdk from '@agent-jobs/sdk'
import { describe, expect, it } from 'vitest'
import { approvalSigner, approvalTypedData, frozenOperation, frozenTransactions, signatureFollowup, type FrozenOperation } from './approval-operation.ts'
import type { Approval } from './fleet.ts'

const deployment = sdk.deployment('monad-testnet')
const wallet = '0x1111111111111111111111111111111111111111'
const other = '0x2222222222222222222222222222222222222222'
const now = 1_800_000_000
const stringify = (value: unknown) => JSON.stringify(value, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))
const activation = (): FrozenOperation => ({
  tool: 'prepare_activation',
  args: { taskId: 'task-17' },
  boardId: 'public',
  from: wallet,
  chainId: deployment.chainId,
  result: {
    sign: {
      description: 'Budget authorization',
      typedData: stringify({
        domain: sdk.coreDomain(deployment.chainId, deployment.core),
        types: sdk.setBudgetTypes,
        primaryType: 'SetBudgetAuthorization',
        message: {
          signer: wallet,
          jobId: '17',
          token: other,
          amount: '2100000',
          optParamsHash: sdk.EMPTY_HASH,
          nonce: '3',
          deadline: String(now + 600),
        },
      }),
    },
  },
})
function changed(change: (typed: Record<string, any>) => void): FrozenOperation {
  const op = activation()
  const typed = JSON.parse(op.result.sign!.typedData) as Record<string, any>
  change(typed)
  op.result.sign!.typedData = JSON.stringify(typed)
  return op
}

describe('approval signer and frozen wallet output', () => {
  it('accepts only the agent signer and expected network', () => {
    expect(() => approvalSigner(wallet, wallet.toUpperCase(), 10143, 10143)).not.toThrow()
    expect(() => approvalSigner(wallet, other, 10143, 10143)).toThrow(/Select this agent/)
    expect(() => approvalSigner(wallet, wallet, 10143, 143)).toThrow(/correct network/)
    expect(() => approvalSigner(wallet, undefined, 10143, 10143)).toThrow()
  })
  it('rejects another chain, malformed target/calldata, and native value before a wallet prompt', () => {
    const tx = {
      description: 'activate',
      chainId: 10143,
      to: wallet,
      data: '0x12345678',
      value: '0',
    }
    expect(frozenTransactions([tx], 10143)).toEqual([tx])
    for (const invalid of [
      { ...tx, chainId: 143 },
      { ...tx, to: '0x1' },
      { ...tx, data: '0x123' },
      { ...tx, value: '1' },
    ])
      expect(() => frozenTransactions([invalid], 10143)).toThrow(/frozen transaction/)
  })
  it('requires a frozen board, chain, and sending wallet', () => {
    const op = activation()
    expect(frozenOperation({ payload: op } as unknown as Approval)).toEqual(op)
    for (const payload of [
      { ...op, from: other.slice(0, 20) },
      { ...op, boardId: undefined },
      { ...op, args: [] },
    ])
      expect(() => frozenOperation({ payload } as unknown as Approval)).toThrow(/no executable/)
  })
})

describe('contract-defined typed signature review', () => {
  it('accepts a worker budget for its own wallet, the configured core, and exact schema', () => {
    const op = activation()
    expect(approvalTypedData(op, deployment, now)).toBe(op.result.sign!.typedData)
    expect(signatureFollowup(op, '0xsigned')).toEqual({
      tool: 'build_activation',
      args: { taskId: 'task-17', budgetSignature: '0xsigned' },
    })
  })
  it('refuses different contracts, chains, signers, hook parameters, schema, expiry, and unsafe integers', () => {
    for (const mutate of [
      (typed: Record<string, any>) => {
        typed.domain.verifyingContract = other
      },
      (typed: Record<string, any>) => {
        typed.domain.chainId = 143
      },
      (typed: Record<string, any>) => {
        typed.message.signer = other
      },
      (typed: Record<string, any>) => {
        typed.message.optParamsHash = `0x${'0'.repeat(64)}`
      },
      (typed: Record<string, any>) => {
        typed.types.SetBudgetAuthorization[3].type = 'uint128'
      },
      (typed: Record<string, any>) => {
        typed.message.deadline = String(now)
      },
      (typed: Record<string, any>) => {
        typed.message.nonce = (2n ** 72n).toString()
      },
      (typed: Record<string, any>) => {
        typed.message.amount = '-1'
      },
      (typed: Record<string, any>) => {
        typed.message.extra = 'unreviewed'
      },
    ])
      expect(() => approvalTypedData(changed(mutate), deployment, now)).toThrow()
  })
  it('accepts a selection for a configured holding and refuses a changed frozen nonce', () => {
    const op = activation()
    op.tool = 'select_worker'
    op.result.nonce = '7'
    op.result.sign!.typedData = stringify({
      domain: sdk.holdingDomain(deployment.chainId, deployment.stacks.main!.holding),
      types: sdk.selectionTypes,
      primaryType: 'Selection',
      message: {
        jobId: '17',
        worker: other,
        agentId: '21',
        termsHash: `0x${'1'.repeat(64)}`,
        activateBy: String(now + 600),
        nonce: '7',
      },
    })
    expect(approvalTypedData(op, deployment, now)).toBe(op.result.sign!.typedData)
    expect(signatureFollowup(op, '0xsigned')).toEqual({
      tool: 'submit_selection',
      args: { taskId: 'task-17', nonce: '7', signature: '0xsigned' },
    })
    op.result.nonce = '8'
    expect(() => approvalTypedData(op, deployment, now)).toThrow(/nonce changed/)
  })
  it('refuses arbitrary typed-data instructions', () => {
    const op = activation()
    op.tool = 'budget_grant_prepare'
    expect(() => approvalTypedData(op, deployment, now)).toThrow(/not a supported/)
    expect(() => signatureFollowup(op, '0xsigned')).toThrow(/not a supported/)
  })
})

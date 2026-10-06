import * as sdk from '@agent-jobs/sdk'
import { encodeErrorResult } from 'viem'
import { describe, expect, it } from 'vitest'
import { contractErrorName, friendlyError } from './txErrors.ts'

describe('friendly transaction errors', () => {
  it('a cancelled wallet prompt says nothing was sent', () => {
    expect(friendlyError(Object.assign(new Error('User rejected the request.'), { code: 4001 }))).toMatch(/cancelled/)
  })
  it('missing gas points to the wallet', () => {
    expect(friendlyError(new Error('insufficient funds for gas * price + value'))).toMatch(/MON for gas/)
  })
  it("decodes our contracts' errors from a viem cause chain", () => {
    const data = encodeErrorResult({ abi: sdk.hirelingHoldingAbi, errorName: 'SelectionExpired' })
    const e = Object.assign(new Error('Execution reverted'), { cause: { cause: { data } } })
    expect(contractErrorName(e)).toBe('SelectionExpired')
    expect(friendlyError(e)).toMatch(/selection expired/)
  })
  it('names an error it has no sentence for', () => {
    const data = encodeErrorResult({ abi: sdk.hirelingEvaluatorAbi, errorName: 'NotProvider' })
    expect(friendlyError(Object.assign(new Error('x'), { data }))).toBe('The contract refused it (NotProvider).')
  })
  it('decodes the v1 stake vault: closed before launch, reserved stake', () => {
    const closed = encodeErrorResult({ abi: sdk.stakeVaultAbi, errorName: 'NotBootstrapped' })
    expect(friendlyError(Object.assign(new Error('x'), { data: closed }))).toMatch(/Staking opens at launch/)
    const reserved = encodeErrorResult({ abi: sdk.stakeVaultAbi, errorName: 'InsufficientAvailable', args: [1n, 2n] })
    expect(friendlyError(Object.assign(new Error('x'), { data: reserved }))).toMatch(/bonds on live jobs stay staked/)
  })
})

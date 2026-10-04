import { describe, expect, it } from 'vitest'
import { encodeFunctionData, keccak256, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { coreAbi, hirelingEvaluatorAbi } from './abi/index.ts'
import { assertWorkerTransaction, validateSignedWorkerTransaction, type WorkerGrant } from './agent-wallet.ts'

describe('restricted worker transaction', () => {
  const account = privateKeyToAccount(`0x${'01'.repeat(32)}`)
  const target = '0x2222222222222222222222222222222222222222' as const
  const data = encodeFunctionData({ abi: coreAbi, functionName: 'submit', args: [3n, `0x${'10'.repeat(32)}`, '0x'] })
  const grant: WorkerGrant = { operationId: 'op1', kind: 'submit', jobId: 3n, wallet: account.address, target, transaction: { chainId: 10143, to: target, data, value: '0', nonce: 1, gas: 300000n, maxFeePerGas: 40000000000n, maxPriorityFeePerGas: 2000000000n } }
  const sign = () => account.signTransaction({ type: 'eip1559', ...grant.transaction, value: 0n })
  it('recovers the stable wallet and hashes the exact bytes', async () => {
    const raw = await sign(); const recorded = await validateSignedWorkerTransaction(raw, grant)
    expect(recorded.wallet).toBe(account.address); expect(recorded.hash).toBe(keccak256(raw))
  })
  it('rejects altered fields and wrong stable wallet', async () => {
    const raw = await sign()
    await expect(validateSignedWorkerTransaction(raw, { ...grant, wallet: target })).rejects.toThrow('another wallet')
    await expect(validateSignedWorkerTransaction(raw, { ...grant, transaction: { ...grant.transaction, nonce: 2 } })).rejects.toThrow('differs')
  })
  it('refuses wrong jobs, value, hook data, broad calls and another target', () => {
    expect(() => assertWorkerTransaction({ ...grant, jobId: 4n })).toThrow('job/function')
    expect(() => assertWorkerTransaction({ ...grant, transaction: { ...grant.transaction, to: account.address } })).toThrow('target/value/chain')
    const hook = encodeFunctionData({ abi: coreAbi, functionName: 'submit', args: [3n, `0x${'10'.repeat(32)}`, '0x01'] })
    expect(() => assertWorkerTransaction({ ...grant, transaction: { ...grant.transaction, data: hook } })).toThrow('hook')
    expect(() => assertWorkerTransaction({ ...grant, transaction: { ...grant.transaction, data: '0xdeadbeef' as Hex } })).toThrow()
    const dispute = encodeFunctionData({ abi: hirelingEvaluatorAbi, functionName: 'dispute', args: [3n] })
    expect(() => assertWorkerTransaction({ ...grant, kind: 'dispute', transaction: { ...grant.transaction, data: dispute } })).not.toThrow()
  })
})

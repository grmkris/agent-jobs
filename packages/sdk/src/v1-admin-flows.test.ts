import { decodeFunctionData, slice } from 'viem'
import { expect, it } from 'vitest'
import { coreAbi, hirelingEvaluatorAbi } from './abi/index.ts'
import { context } from './client.ts'
import { flowPauseBatch } from './v1-admin-flows.ts'

it('pause and notePause are one MultiSendCallOnly payload containing exactly two ordinary calls', () => {
  const ctx = context('monad-testnet', 'main', 'http://127.0.0.1:1')
  for (const pause of [true, false]) {
    const data = flowPauseBatch(ctx, pause)
    // The ABI envelope starts with multiSend selector, offset and length; each packed inner call is 89 bytes.
    const packed = slice(data, 68, 246)
    expect(slice(packed, 0, 1)).toBe('0x00')
    expect(slice(packed, 1, 21).toLowerCase()).toBe(ctx.deployment.core.toLowerCase())
    expect(decodeFunctionData({ abi: coreAbi, data: slice(packed, 85, 89) }).functionName).toBe(pause ? 'pause' : 'unpause')
    expect(slice(packed, 89, 90)).toBe('0x00')
    expect(slice(packed, 90, 110).toLowerCase()).toBe(ctx.stack.evaluator.toLowerCase())
    expect(decodeFunctionData({ abi: hirelingEvaluatorAbi, data: slice(packed, 174, 178) }).functionName).toBe('notePause')
  }
})

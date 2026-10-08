import { expect, it } from 'vitest'
import { auditBlocks } from './audit-blocks.ts'

const sender = '0x1111111111111111111111111111111111111111'
const hash = `0x${'ab'.repeat(32)}`
const block = (id: number, number: string) => ({
  jsonrpc: '2.0',
  id,
  result: { number, transactions: [{ from: sender, hash }] },
})

it('returns every requested block in order even when the RPC reorders responses', () => {
  expect(auditBlocks([block(2, '0x11'), block(1, '0x10')], [16n, 17n])).toEqual([
    { number: 16n, transactions: [{ from: sender, hash }] },
    { number: 17n, transactions: [{ from: sender, hash }] },
  ])
})

it('refuses missing, duplicate, failed, wrong-number and malformed-transaction blocks', () => {
  for (const payload of [
    null,
    [block(1, '0x10')],
    [block(1, '0x10'), block(1, '0x10')],
    [block(1, '0x10'), { jsonrpc: '2.0', id: 2, error: { code: -32011 } }],
    [block(1, '0x10'), block(2, '0x12')],
    [block(1, '0x10'), { ...block(2, '0x11'), result: null }],
    [block(1, '0x10'), { ...block(2, '0x11'), result: { number: '0x11', transactions: [hash] } }],
    [
      block(1, '0x10'),
      { ...block(2, '0x11'), result: { number: '0x11', transactions: [{ from: sender, hash: '0x' }] } },
    ],
  ])
    expect(() => auditBlocks(payload, [16n, 17n])).toThrow()
})

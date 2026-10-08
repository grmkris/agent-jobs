import { expect, it, vi } from 'vitest'
import { readAuditBlocks } from './audit-fetch.ts'

const block = (id: number, number: string) => ({
  jsonrpc: '2.0',
  id,
  result: { number, transactions: [] },
})

it('splits an incomplete range and returns every requested block in order', async () => {
  const rpc = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json([block(1, '0x10')]))
    .mockResolvedValueOnce(Response.json([block(2, '0x11'), block(1, '0x10')]))
    .mockResolvedValueOnce(Response.json([block(1, '0x12')]))
  expect(await readAuditBlocks([16n, 17n, 18n], 'https://rpc.invalid', rpc)).toEqual([
    { number: 16n, transactions: [] },
    { number: 17n, transactions: [] },
    { number: 18n, transactions: [] },
  ])
  expect(rpc).toHaveBeenCalledTimes(3)
})

it('refuses the full range when a singleton stays missing or a block number changes', async () => {
  const missing = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json([]))
    .mockResolvedValueOnce(Response.json([]))
    .mockResolvedValueOnce(Response.json([block(1, '0x11')]))
  await expect(readAuditBlocks([16n, 17n], 'https://rpc.invalid', missing)).rejects.toThrow('P8_AUDIT_BLOCK_MISSING')
  const changed = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json([block(1, '0x10'), block(2, '0x12')]))
  await expect(readAuditBlocks([16n, 17n], 'https://rpc.invalid', changed)).rejects.toThrow('P8_AUDIT_BLOCK_MISMATCH')
  expect(changed).toHaveBeenCalledTimes(1)
})

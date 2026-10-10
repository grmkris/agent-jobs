import { expect, it, vi } from 'vitest'
import { decodeFunctionData, encodeAbiParameters, type Hex } from 'viem'
import { identityAbi } from './abi/identity.ts'
import { deployment } from './deployment.ts'
import {
  BACKER_SHARE_KEY,
  decodeBackerShare,
  encodeBackerShare,
  prepareBackerShare,
  readBackerShare,
} from './backer-share.ts'

it.each([0, 1, 5000, 10000])('encodes and decodes %i basis points in a uint16 ABI word', (bps) => {
  expect(encodeBackerShare(bps)).toBe(encodeAbiParameters([{ type: 'uint16' }], [bps]))
  expect(decodeBackerShare(encodeBackerShare(bps))).toBe(bps)
})

it.each([-1, 10001, 1.5, NaN, Infinity])('rejects invalid share %s', (bps) => {
  expect(() => encodeBackerShare(bps)).toThrow('integer from 0 to 10000')
})

it.each(['0x', '0x12', `0x${'00'.repeat(33)}`, `0x${'zz'.repeat(32)}`, 'not hex'])(
  'defaults malformed metadata %s to zero',
  (bytes) => {
    expect(decodeBackerShare(bytes)).toBe(0)
  },
)

it('clamps the complete unsigned word without uint16 truncation', () => {
  expect(decodeBackerShare(encodeAbiParameters([{ type: 'uint256' }], [10001n]))).toBe(10000)
  expect(decodeBackerShare(`0x${'ff'.repeat(32)}`)).toBe(10000)
})

it('prepares only the identity metadata transaction', () => {
  const identity = deployment('monad-testnet').identity
  const tx = prepareBackerShare(identity, '4242', 5000)
  expect(tx.to).toBe(identity)
  expect(tx.value).toBe('0')
  expect(decodeFunctionData({ abi: identityAbi, data: tx.data })).toEqual({
    functionName: 'setMetadata',
    args: [4242n, BACKER_SHARE_KEY, encodeBackerShare(5000)],
  })
  expect(() => prepareBackerShare(identity, '4242', -1)).toThrow()
})

it('reads the configured identity and key, including the unset default', async () => {
  const identity = deployment('monad-testnet').identity
  const readContract = vi
    .fn<() => Promise<Hex>>()
    .mockResolvedValueOnce(encodeBackerShare(3500))
    .mockResolvedValueOnce('0x')
  expect(await readBackerShare({ readContract }, identity, '4242')).toBe(3500)
  expect(readContract).toHaveBeenCalledWith({
    address: identity,
    abi: identityAbi,
    functionName: 'getMetadata',
    args: [4242n, BACKER_SHARE_KEY],
  })
  expect(await readBackerShare({ readContract }, identity, 4242n)).toBe(0)
})

it('preserves unreadable RPC failures for callers to distinguish from opting out', async () => {
  await expect(
    readBackerShare(
      {
        readContract: async () => {
          throw new Error('offline')
        },
      },
      deployment('monad-testnet').identity,
      '1',
    ),
  ).rejects.toThrow('offline')
})

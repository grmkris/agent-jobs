import { createPublicKey, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { generateAuthorizationKey, p1363ToDer, p256AuthorizationSigner } from './p256.ts'

describe('Worker P-256 request authorization', () => {
  it('produces DER signatures verifiable by an independent crypto implementation', async () => {
    const pair = await generateAuthorizationKey()
    const sign = await p256AuthorizationSigner(pair.privateKey)
    const publicKey = createPublicKey({ key: Buffer.from(pair.publicKey, 'base64'), type: 'spki', format: 'der' })
    const payload = '{"body":{"method":"eth_signTypedData_v4"},"version":1}'
    const signature = Buffer.from(await sign(payload), 'base64')
    expect(verify('sha256', Buffer.from(payload), publicKey, signature)).toBe(true)
    expect(verify('sha256', Buffer.from(`${payload} `), publicKey, signature)).toBe(false)
  })

  it('encodes positive integers canonically, including zero and the sign bit', () => {
    const raw = new Uint8Array(64)
    raw[32] = 0x80
    const der = p1363ToDer(raw)
    expect(Array.from(der.slice(0, 8))).toEqual([0x30, 38, 0x02, 1, 0, 0x02, 33, 0])
    expect(der[8]).toBe(0x80)
    expect(() => p1363ToDer(new Uint8Array(63))).toThrow('P-256')
  })
})

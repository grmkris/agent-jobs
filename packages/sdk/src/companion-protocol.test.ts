import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { assertCompanionOperation, canonicalAuthorizationRequest, publicKeyPem, signAuthorizationRequest, verifyAuthorizationRequest } from './companion-protocol.ts'

describe('companion authorization', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const input = { v: 1 as const, method: 'post', url: 'https://testnet.hireling.xyz/api/wallet/sign', headers: { 'X-Z': ' 2 ', 'content-type': 'application/json' }, body: '{"a":1}', expiresAt: 2_000_000_000, nonce: 'n1' }
  it('canonicalizes sorted headers and verifies exact request', () => {
    expect(canonicalAuthorizationRequest(input)).toContain('POST\nhttps://testnet.hireling.xyz/api/wallet/sign')
    const envelope = { ...input, publicKey: publicKeyPem(publicKey), signature: signAuthorizationRequest(privateKey, input) }
    expect(verifyAuthorizationRequest(publicKey, envelope)).toBe(true)
    expect(verifyAuthorizationRequest(publicKey, { ...envelope, body: '{"a":2}' })).toBe(false)
  })
  it('refuses broad wallet operations', () => {
    assertCompanionOperation('submit')
    expect(() => assertCompanionOperation('execute')).toThrow('refused')
    expect(() => assertCompanionOperation('transfer')).toThrow('refused')
  })
})

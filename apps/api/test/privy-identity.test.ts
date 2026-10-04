import { afterEach, expect, it, vi } from 'vitest'
import { verifyPrivyWallet } from '../src/privy-identity.ts'

afterEach(() => vi.unstubAllGlobals())

it('verifies JWT, operator ownership and child wallet with Worker-compatible redirect refusal', async () => {
  for (const redirectAt of [-1, 0, 1, 2]) {
    const appId = `test-app-${redirectAt}`
    const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    const jwk = await crypto.subtle.exportKey('jwk', key.publicKey)
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const unsigned = `${encode({ alg: 'ES256', kid: 'test' })}.${encode({ iss: 'privy.io', aud: appId, sub: 'did:privy:test', exp: 200 })}`
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, new TextEncoder().encode(unsigned))
    const token = `${unsigned}.${Buffer.from(signature).toString('base64url')}`
    let calls = 0
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.redirect).toBe('manual')
      const n = calls++
      if (n === redirectAt) return new Response(null, { status: 302, headers: { location: 'https://foreign.invalid' } })
      const body = n === 0 ? { keys: [{ ...jwk, kid: 'test' }] } : n === 1 ? { id: 'did:privy:test', linked_accounts: [{ type: 'wallet', address: '0x1' }, { type: 'wallet', address: '0x2', wallet_client_type: 'privy' }] } : { id: 'child', address: '0x2' }
      return Response.json(body)
    })
    vi.stubGlobal('fetch', fetch)
    expect(await verifyPrivyWallet({ token, appId, appSecret: 'fixture-only', operator: '0x1', walletAddress: '0x2', walletId: 'child', now: 100 })).toBe(redirectAt === -1)
    expect(calls).toBe(redirectAt === -1 ? 3 : redirectAt + 1)
  }
})

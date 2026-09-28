import { describe, expect, it } from 'vitest'
import { budgetPolicyBody, budgetRule } from './budget-policy.ts'
import { authorizationSignature, generateAuthorizationKey, p1363ToDer, signaturePayload } from './privy.ts'

const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n

function pad32(b: Uint8Array): number[] {
  const t = b[0] === 0 ? b.slice(1) : b
  return [...Array.from({ length: 32 - t.length }, () => 0), ...t]
}

/** DER → P1363 so WebCrypto can verify what Privy receives. */
function derToP1363(der: Uint8Array): Uint8Array {
  const rLen = der[3] as number
  return Uint8Array.from([...pad32(der.slice(4, 4 + rLen)), ...pad32(der.slice(6 + rLen))])
}

const input = {
  method: 'POST' as const,
  url: 'https://api.privy.io/v1/wallets/w1/rpc',
  body: { method: 'eth_sendTransaction', caip2: 'eip155:10143', params: { transaction: { to: '0xab', value: '0x0' } } },
  appId: 'app1',
  idempotencyKey: 'spend-1',
}

describe('privy authorization signature', () => {
  it('signs the canonical payload Privy verifies', () => {
    expect(new TextDecoder().decode(signaturePayload(input))).toBe(
      '{"body":{"caip2":"eip155:10143","method":"eth_sendTransaction","params":{"transaction":{"to":"0xab","value":"0x0"}}},' +
        '"headers":{"privy-app-id":"app1","privy-idempotency-key":"spend-1"},"method":"POST",' +
        '"url":"https://api.privy.io/v1/wallets/w1/rpc","version":1}',
    )
    expect(new TextDecoder().decode(signaturePayload({ ...input, body: {} }))).toContain('"body":""')
  })

  it('produces a low-S DER signature that verifies under the public key', async () => {
    const k = await generateAuthorizationKey()
    const pub = await crypto.subtle.importKey('spki', Uint8Array.from(atob(k.publicKey), (c) => c.charCodeAt(0)), { name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'verify',
    ])
    for (let i = 0; i < 8; i++) {
      const der = Uint8Array.from(atob(await authorizationSignature(k.privateKey, input)), (c) => c.charCodeAt(0))
      const p1363 = derToP1363(der)
      const s = p1363.slice(32).reduce((a, x) => (a << 8n) | BigInt(x), 0n)
      expect(s <= N / 2n).toBe(true)
      expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, p1363, signaturePayload(input))).toBe(true)
    }
  })

  it('normalises a high S and keeps a leading-zero r positive', () => {
    const sig = new Uint8Array(64)
    sig[0] = 0x80
    sig.fill(0xff, 32)
    const der = p1363ToDer(sig)
    expect(der[0]).toBe(0x30)
    expect(der[2]).toBe(0x02)
    expect(der[3]).toBe(33)
    expect(der[4]).toBe(0)
  })
})

describe('budget policy', () => {
  const g = { taskId: 't1', chainId: 10143, token: '0x00000000000000000000000000000000000000aa' as const, cap: 1500000000000000000n, expiresAt: 1800000000 }

  it('pins chain as a decimal string, the token, no value, the amount cap and the expiry', () => {
    const r = budgetRule(g)
    expect(r.method).toBe('eth_sendTransaction')
    expect(r.conditions.map((c) => [c.field, c.operator, c.value])).toEqual([
      ['chain_id', 'eq', '10143'],
      ['to', 'eq', g.token],
      ['value', 'eq', '0'],
      ['transfer.amount', 'lte', '1500000000000000000'],
      ['current_unix_timestamp', 'lt', '1800000000'],
    ])
  })

  it('is the union of a wallet’s grants, in a stable order, under a name Privy accepts', () => {
    const body = budgetPolicyBody('0x1234567890abcdef1234567890abcdef12345678', [{ ...g, taskId: 't2' }, g], 'did:privy:x')
    expect(body.rules.map((r) => r.name)).toEqual(['budget-t1', 'budget-t2'])
    expect(body.name.length).toBeLessThan(50)
    expect(body.owner).toEqual({ user_id: 'did:privy:x' })
  })
})

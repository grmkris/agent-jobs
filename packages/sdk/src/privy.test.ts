import { describe, expect, it } from 'vitest'
import { formatPrivyAuthorizationPayload } from './privy.ts'

describe('Privy authorization requests', () => {
  it('uses canonical body and the three provider headers only', () => {
    const a = formatPrivyAuthorizationPayload({
      method: 'post',
      url: 'https://api.privy.io/v1/wallets/w/rpc',
      body: { params: { transaction: { value: '0x0', to: '0x1' } }, method: 'eth_signTransaction' },
      headers: { 'privy-request-expiry': '123', 'privy-app-id': 'app', 'privy-idempotency-key': 'op' },
    })
    expect(a).toBe(
      '{"body":{"method":"eth_signTransaction","params":{"transaction":{"to":"0x1","value":"0x0"}}},"headers":{"privy-app-id":"app","privy-idempotency-key":"op","privy-request-expiry":"123"},"method":"POST","url":"https://api.privy.io/v1/wallets/w/rpc","version":1}',
    )
  })
})

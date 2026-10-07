import * as sdk from '@sidequest/sdk'
import { decodeX402Header, encodeX402Header, type X402Payload, type X402Required } from '@sidequest/board'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { x402Demo } from '../src/x402-demo.ts'

const deployment = sdk.deployment('monad-testnet')
const url = 'https://dev.sidequest.exchange/x402/demo'
const payer = '0x1111111111111111111111111111111111111111'
const transaction = `0x${'ab'.repeat(32)}`
const now = () => 1_800_000_000
afterEach(() => {
  vi.restoreAllMocks()
})

async function fixture() {
  const unpaid = await x402Demo(url, undefined, { deployment, now })
  const required = decodeX402Header(unpaid.headers['PAYMENT-REQUIRED']!) as X402Required
  const payload: X402Payload = {
    x402Version: 2,
    resource: required.resource,
    accepted: required.accepts[0]!,
    payload: {
      signature: `0x${'11'.repeat(65)}`,
      authorization: {
        from: payer,
        to: required.accepts[0]!.payTo,
        value: '10000',
        validAfter: String(now() - 1),
        validBefore: String(now() + 120),
        nonce: `0x${'22'.repeat(32)}`,
      },
    },
  }
  const fetcher = vi.fn<typeof fetch>(
    async (input) =>
      new Response(
        JSON.stringify(
          String(input).endsWith('/verify')
            ? { isValid: true, payer }
            : { success: true, transaction, network: 'eip155:10143', payer },
        ),
        { status: 200 },
      ),
  )
  return {
    unpaid,
    required,
    payload,
    fetcher,
    pay: (data = payload) => x402Demo(url, encodeX402Header(data), { deployment, now, fetch: fetcher }),
  }
}

describe('testnet x402 demo', () => {
  it('offers 0.01 configured USDC to the deployment Safe in the v2 402 body and header', async () => {
    const f = await fixture()
    expect(f.unpaid.status).toBe(402)
    expect(f.unpaid.body).toEqual(f.required)
    expect(f.required).toEqual({
      x402Version: 2,
      resource: { url, description: 'Sidequest x402 demo', mimeType: 'application/json' },
      accepts: [
        {
          scheme: 'exact',
          network: 'eip155:10143',
          amount: '10000',
          asset: deployment.x402!.usdc,
          payTo: deployment.sidequest!.safe,
          maxTimeoutSeconds: 120,
          extra: { name: 'USDC', version: '2' },
        },
      ],
    })
    expect(f.fetcher).not.toHaveBeenCalled()
  })

  it.each([
    [
      'version',
      (p: X402Payload) => {
        ;(p as unknown as { x402Version: number }).x402Version = 1
      },
    ],
    [
      'network',
      (p: X402Payload) => {
        p.accepted.network = 'eip155:143'
      },
    ],
    [
      'asset',
      (p: X402Payload) => {
        p.accepted.asset = payer
      },
    ],
    [
      'resource',
      (p: X402Payload) => {
        p.resource.url = 'https://evil.example/paid'
      },
    ],
    [
      'amount',
      (p: X402Payload) => {
        p.payload.authorization.value = '10001'
      },
    ],
    [
      'recipient',
      (p: X402Payload) => {
        p.payload.authorization.to = payer
      },
    ],
    [
      'signature',
      (p: X402Payload) => {
        p.payload.signature = '0x00'
      },
    ],
    [
      'nonce',
      (p: X402Payload) => {
        p.payload.authorization.nonce = '0x00'
      },
    ],
    [
      'expired',
      (p: X402Payload) => {
        p.payload.authorization.validBefore = String(now())
      },
    ],
    [
      'future',
      (p: X402Payload) => {
        p.payload.authorization.validAfter = String(now())
      },
    ],
    [
      'too long',
      (p: X402Payload) => {
        p.payload.authorization.validBefore = String(now() + 121)
      },
    ],
  ] as const)('refuses mismatched %s before calling the facilitator', async (_, change) => {
    const f = await fixture()
    change(f.payload)
    expect(await f.pay()).toMatchObject({ status: 402, body: { errorReason: 'payment-mismatch' } })
    expect(f.fetcher).not.toHaveBeenCalled()
  })

  it('refuses malformed base64', async () => {
    const fetcher = vi.fn<typeof fetch>()
    expect(await x402Demo(url, 'bad header', { deployment, now, fetch: fetcher })).toMatchObject({
      status: 402,
      body: { errorReason: 'payment-mismatch' },
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('verifies then settles with the exact v2 request and an eight-second timeout per call', async () => {
    const f = await fixture()
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const reply = await f.pay()
    expect(reply).toMatchObject({
      status: 200,
      body: { ok: true, transaction },
      headers: { 'cache-control': 'no-store' },
    })
    expect(decodeX402Header(reply.headers['PAYMENT-RESPONSE']!)).toEqual({
      success: true,
      transaction,
      network: 'eip155:10143',
      payer,
    })
    expect(timeout.mock.calls).toEqual([[8000], [8000]])
    expect(f.fetcher.mock.calls.map((call) => call[0])).toEqual([
      `${deployment.x402!.facilitator}/verify`,
      `${deployment.x402!.facilitator}/settle`,
    ])
    for (const [, init] of f.fetcher.mock.calls) {
      expect(init).toMatchObject({
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/json' },
        signal: expect.any(AbortSignal),
      })
      expect(JSON.parse(init!.body as string)).toEqual({
        x402Version: 2,
        paymentPayload: f.payload,
        paymentRequirements: f.required.accepts[0],
      })
    }
  })

  it.each([
    [
      'verify refusal',
      { isValid: false, invalidReason: 'private facilitator body' },
      undefined,
      'verification-failed',
      1,
    ],
    ['verify wrong payer', { isValid: true, payer: deployment.sidequest!.safe }, undefined, 'verification-failed', 1],
    [
      'settle refusal',
      { isValid: true, payer },
      { success: false, errorReason: 'private facilitator body' },
      'settlement-failed',
      2,
    ],
    [
      'settle wrong network',
      { isValid: true, payer },
      { success: true, transaction, network: 'eip155:143', payer },
      'settlement-failed',
      2,
    ],
    [
      'settle malformed tx',
      { isValid: true, payer },
      { success: true, transaction: 'private facilitator body', network: 'eip155:10143', payer },
      'settlement-failed',
      2,
    ],
  ] as const)('sanitizes %s', async (_, verify, settle, errorReason, calls) => {
    const f = await fixture()
    f.fetcher.mockImplementation(
      async (input) => new Response(JSON.stringify(String(input).endsWith('/verify') ? verify : settle)),
    )
    const reply = await f.pay()
    expect(reply).toMatchObject({ status: 402, body: { errorReason } })
    expect(JSON.stringify(reply)).not.toContain('private facilitator body')
    expect(decodeX402Header(reply.headers['PAYMENT-REQUIRED']!)).toMatchObject({ error: errorReason })
    expect(f.fetcher).toHaveBeenCalledTimes(calls)
  })

  it.each(['verify', 'settle'] as const)(
    'refuses a facilitator redirect at %s instead of following it (VV2-031)',
    async (stage) => {
      const f = await fixture()
      f.fetcher.mockImplementation(async (input) =>
        String(input).endsWith(`/${stage}`)
          ? new Response(null, { status: 307, headers: { location: 'https://evil.example/' } })
          : new Response(JSON.stringify({ isValid: true, payer })),
      )
      expect(await f.pay()).toMatchObject({
        status: 402,
        body: { errorReason: stage === 'verify' ? 'verification-failed' : 'settlement-failed' },
      })
      expect(f.fetcher).toHaveBeenCalledTimes(stage === 'verify' ? 1 : 2)
    },
  )

  it.each(['verify', 'settle'] as const)(
    'handles a facilitator HTTP failure, malformed body or timeout at %s',
    async (stage) => {
      for (const failure of ['http', 'json', 'timeout'] as const) {
        const f = await fixture()
        f.fetcher.mockImplementation(async (input) => {
          if (!String(input).endsWith(`/${stage}`)) return new Response(JSON.stringify({ isValid: true, payer }))
          if (failure === 'timeout') throw new DOMException('private facilitator body', 'TimeoutError')
          return new Response('private facilitator body', { status: failure === 'http' ? 503 : 200 })
        })
        const reply = await f.pay()
        expect(reply).toMatchObject({
          status: 402,
          body: { errorReason: stage === 'verify' ? 'verification-failed' : 'settlement-failed' },
        })
        expect(JSON.stringify(reply)).not.toContain('private facilitator body')
      }
    },
  )

  it('hides the route on mainnet without fetching', async () => {
    const f = await fixture()
    expect(
      await x402Demo(url, encodeX402Header(f.payload), {
        deployment: { ...deployment, network: 'monad-mainnet', chainId: 143 },
        now,
        fetch: f.fetcher,
      }),
    ).toMatchObject({ status: 404 })
    expect(f.fetcher).not.toHaveBeenCalled()
  })
})

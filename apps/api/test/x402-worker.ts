import * as Cloudflare from 'alchemy/Cloudflare'
import * as Effect from 'effect/Effect'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import * as sdk from '@sidequest/sdk'
import { decodeX402Header, encodeX402Header, type X402Payload, type X402Required } from '@sidequest/board'
import { x402Demo } from '../src/x402-demo.ts'

const url = 'https://dev.sidequest.exchange/x402/demo'
const now = () => 1_800_000_000
const payer = '0x1111111111111111111111111111111111111111'
const transaction = `0x${'ab'.repeat(32)}`

/** Pays the x402 demo inside workerd. The facilitator double builds workerd's own Request from each init, as its fetch does before sending (VV2-031). */
export default class X402Drill extends Cloudflare.Worker<X402Drill>()(
  'SidequestX402LocalDrill',
  {
    main: import.meta.url,
    compatibility: { date: '2026-09-01', flags: ['nodejs_compat'] },
  },
  Effect.succeed({
    fetch: Effect.gen(function* () {
      const result = yield* Effect.promise(async () => {
        const deployment = sdk.deployment('monad-testnet')
        const unpaid = await x402Demo(url, undefined, { deployment, now })
        const required = decodeX402Header(unpaid.headers['PAYMENT-REQUIRED']!) as X402Required
        const payment: X402Payload = {
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
        const requests: Array<{ path: string; redirect: string }> = []
        const facilitator = (async (input: string, init: RequestInit) => {
          const request = new Request(input, init)
          requests.push({ path: new URL(request.url).pathname, redirect: request.redirect })
          return Response.json(
            request.url.endsWith('/verify')
              ? { isValid: true, payer }
              : { success: true, transaction, network: 'eip155:10143', payer },
          )
        }) as typeof fetch
        const paid = await x402Demo(url, encodeX402Header(payment), { deployment, now, fetch: facilitator })
        return {
          runtime: navigator.userAgent,
          unpaid: unpaid.status,
          paid: paid.status,
          transaction: paid.body.transaction,
          requests,
        }
      })
      return HttpServerResponse.jsonUnsafe(result)
    }).pipe(Effect.orDie),
  }),
) {}

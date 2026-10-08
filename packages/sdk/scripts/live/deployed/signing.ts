/** Confirm only the exact fixture grant shown in Privy's real signing modal. */
import { type Address, hashTypedData } from 'viem'
import * as sdk from '../../../src/index.ts'
import { type HostedBrowser } from './browser.ts'
import { object, text } from './runtime.ts'

export type GrantReview =
  | { kind: 'operator' | 'registration'; delegator: Address }
  | { kind: 'allowance' | 'allowance-once'; delegator: Address; agent: Address; token: Address; amount: bigint }

export function assertGrantPayload(ctx: sdk.GrantContext, payload: string, expected: GrantReview) {
  const typed = object(JSON.parse(payload))
  const message = object(typed.message)
  if (!Array.isArray(message.caveats)) throw new Error('P8_SIGNING_CAVEATS_MISSING')
  const grant = sdk.parseDelegation(
    JSON.stringify({
      ...message,
      caveats: message.caveats.map((item) => ({ ...object(item), args: '0x' })),
      signature: '0x',
    }),
  )
  const timestamp = grant.caveats.find(
    (item) => item.enforcer.toLowerCase() === ctx.deployment.delegation.enforcers.timestamp.toLowerCase(),
  )
  if (timestamp === undefined) throw new Error('P8_SIGNING_EXPIRY_MISSING')
  const expiry = Number(BigInt(`0x${timestamp.terms.slice(-32)}`))
  const validity = {
    operator: sdk.GRANT_VALIDITY,
    registration: sdk.ONE_OFF_VALIDITY,
    allowance: sdk.ALLOWANCE_VALIDITY,
    'allowance-once': sdk.ONE_OFF_VALIDITY,
  }[expected.kind]
  const spec = { ...expected, start: expiry - validity, salt: grant.salt }
  sdk.assertGrant(ctx, spec, grant)
  const now = Math.floor(Date.now() / 1000)
  if (spec.start > now + 60 || expiry <= now) throw new Error('P8_SIGNING_TIME_BOUND_CHANGED')
  const expectedPayload = sdk.delegationTypedData(ctx.deployment, grant)
  const digest = hashTypedData(JSON.parse(expectedPayload))
  if (hashTypedData(JSON.parse(payload)) !== digest) throw new Error('P8_SIGNING_DOMAIN_OR_TYPES_CHANGED')
  return digest
}

export async function confirmGrant(
  browser: HostedBrowser,
  ctx: sdk.GrantContext,
  path: string,
  expected: GrantReview,
): Promise<void> {
  const modal = browser.page.locator('#privy-modal-content')
  const sign = modal.getByRole('button', { name: 'Sign and continue', exact: true })
  await sign.waitFor({ state: 'visible', timeout: 60_000 })
  await browser.settle()
  const response = browser.responses.findLast((item) => item.path === path)
  if (response === undefined) throw new Error('P8_SIGNING_PREPARATION_MISSING')
  const prepared = object(object(response.body).result)
  let expectedPayload: string
  if (expected.kind === 'operator') expectedPayload = text(object(prepared.sign).typedData)
  else expectedPayload = sdk.delegationTypedData(ctx.deployment, sdk.parseDelegation(JSON.stringify(prepared.grant)))
  const digest = assertGrantPayload(ctx, expectedPayload, expected)
  // The clipboard belongs to this isolated headless fixture profile. Read unsigned
  // payloads only, keep them in memory, and never print them or persist them in evidence.
  await browser.context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: new URL(browser.page.url()).origin,
  })
  await modal.getByRole('button', { name: 'Copy full payload to clipboard', exact: true }).click()
  const actual = await browser.page.evaluate(() => {
    // SAFETY: this callback executes in Chromium with clipboard permissions granted above; the SDK's Node-only libs omit that browser API.
    const clipboard = (navigator as Navigator & { clipboard: { readText(): Promise<string> } }).clipboard
    return clipboard.readText()
  })
  if (assertGrantPayload(ctx, actual, expected) !== digest) throw new Error('P8_SIGNING_PAYLOAD_CHANGED')
  await sign.click()
}

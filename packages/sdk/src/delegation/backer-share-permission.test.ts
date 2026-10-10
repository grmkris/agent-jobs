import { decodeAllowedCalldataTerms } from '@metamask/delegation-core'
import { encodeAbiParameters, encodeFunctionData, encodePacked, size, slice, type Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import { identityAbi } from '../abi/identity.ts'
import {
  BACKER_SHARE_CALLDATA_LAYOUT,
  BACKER_SHARE_KEY,
  encodeBackerShare,
  prepareBackerShare,
} from '../backer-share.ts'
import { deployment, stack } from '../deployment.ts'
import { buildGrant, describeGrant, grantCallLimit, grantHasCallLimit } from './grants.ts'
import { delegationHash } from './index.ts'
import {
  adjustPermission,
  assertPermission,
  buildPermission,
  checkPermissionExecution,
  describePermission,
  parsePermissionRequest,
  parsePermissionSpec,
  permissionSpecJson,
  type PermissionRequest,
  type PermissionSpec,
} from './permissions.ts'

const d = deployment('monad-testnet')
const now = 1_791_000_000
const operator = '0x1111111111111111111111111111111111111111'
const agent = '0x2222222222222222222222222222222222222222'
const terms = { type: 'sidequest:backer-share', registry: d.identity, agentId: 42n, calls: 10 } as const
const spec: PermissionSpec = {
  kind: 'permission',
  delegator: operator,
  agent,
  salt: 7n,
  start: now,
  expiry: now + 30 * 86400,
  terms,
}
const request: PermissionRequest = {
  chainId: d.chainId,
  to: agent,
  permission: { type: terms.type, isAdjustmentAllowed: true, data: { registry: d.identity, agentId: '42' } },
  rules: [{ type: 'expiry', data: { timestamp: spec.expiry } }],
}
const scope = { chainId: d.chainId, agent, operator, now } as const
const metadata = (id: bigint, key: string, value: Hex) =>
  encodeFunctionData({ abi: identityAbi, functionName: 'setMetadata', args: [id, key, value] })
const execution = (callData: Hex) => ({ target: d.identity, value: 0n, callData })

describe('standing backer share', () => {
  it.each([0, 1, 5000, 10000])('pins every AllowedCalldata window for %i bps', (bps) => {
    const grant = buildPermission(d, spec)
    const e = d.delegation.enforcers
    expect(grant.caveats.map((item) => item.enforcer.toLowerCase())).toEqual(
      [
        e.timestamp,
        e.allowedTargets,
        e.allowedMethods,
        e.valueLte,
        e.allowedCalldata,
        e.allowedCalldata,
        e.limitedCalls,
      ].map((item) => item.toLowerCase()),
    )
    expect(grant.caveats[6]!.terms).toBe(encodeAbiParameters([{ type: 'uint256' }], [10n]))
    const data = prepareBackerShare(d.identity, 42n, bps).data
    expect(size(data)).toBe(228)
    expect(size(BACKER_SHARE_CALLDATA_LAYOUT.fixedBytes)).toBe(190)
    const pinned = encodePacked(
      ['uint256', 'uint256', 'uint256', 'bytes32', 'uint256', 'bytes'],
      [
        96n,
        160n,
        24n,
        slice(metadata(42n, BACKER_SHARE_KEY, encodeBackerShare(0)), 132, 164),
        32n,
        `0x${'00'.repeat(30)}`,
      ],
    )
    expect(BACKER_SHARE_CALLDATA_LAYOUT.fixedBytes).toBe(pinned)
    for (const caveat of grant.caveats.filter(
      (item) => item.enforcer.toLowerCase() === e.allowedCalldata.toLowerCase(),
    )) {
      const window = decodeAllowedCalldataTerms(caveat.terms)
      expect(slice(data, window.startIndex, window.startIndex + size(window.value))).toBe(window.value)
    }
    expect(() => checkPermissionExecution(spec, execution(data), now)).not.toThrow()
  })

  it.each([
    ['wrong ID', metadata(43n, BACKER_SHARE_KEY, encodeBackerShare(1))],
    ['wrong key', metadata(42n, 'sidequest.otherSetting', encodeBackerShare(1))],
    ['over 10000', metadata(42n, BACKER_SHARE_KEY, encodeAbiParameters([{ type: 'uint256' }], [10001n]))],
    ['short value', metadata(42n, BACKER_SHARE_KEY, '0x01')],
    ['long value', metadata(42n, BACKER_SHARE_KEY, `0x${'00'.repeat(33)}`)],
    ['trailing bytes', `${prepareBackerShare(d.identity, 42n, 1).data}00`],
  ])('refuses %s', (_, data) => {
    // SAFETY: the fixtures above are hex calldata, including the deliberately noncanonical trailing byte.
    expect(() => checkPermissionExecution(spec, execution(data as Hex), now)).toThrow()
  })

  it('refuses value, another target and expiry', () => {
    const call = execution(prepareBackerShare(d.identity, 42n, 1).data)
    expect(() => checkPermissionExecution(spec, { ...call, value: 1n }, now)).toThrow()
    expect(() => checkPermissionExecution(spec, { ...call, target: agent }, now)).toThrow()
    expect(() => checkPermissionExecution(spec, call, spec.expiry)).toThrow(/expired/)
  })

  it('round-trips, describes and asserts the exact grant', () => {
    expect(parsePermissionRequest(request, scope).terms).toEqual(terms)
    expect(parsePermissionSpec(permissionSpecJson(spec))).toEqual(spec)
    const grant = buildGrant({ deployment: d, stack: stack(d, 'main') }, spec)
    expect(grantCallLimit(spec)).toBe(10)
    expect(grantHasCallLimit(spec)).toBe(true)
    expect(describePermission(spec)).toMatchObject({ registry: d.identity, agentId: '42', calls: 10 })
    expect(describeGrant({ deployment: d, stack: stack(d, 'main') }, spec, grant)).toMatchObject({
      calls: 10,
      targets: [{ address: d.identity, methods: ['setMetadata'] }],
    })
    expect(() => assertPermission(d, spec, grant)).not.toThrow()
    expect(() => assertPermission(d, { ...spec, terms: { ...terms, agentId: 43n } }, grant)).toThrow()
    expect(delegationHash(grant)).not.toBe(
      delegationHash(buildPermission(d, { ...spec, terms: { ...terms, calls: 9 } })),
    )
  })

  it.each([0, 21, 1.5, '10'])('refuses calls %s', (calls) => {
    expect(() =>
      parsePermissionRequest(
        { ...request, permission: { ...request.permission, data: { ...request.permission.data, calls } } },
        scope,
      ),
    ).toThrow(/calls/)
  })

  it('allows at most 30 days and only lower calls or shorter expiry', () => {
    const parsed = parsePermissionRequest(request, scope)
    expect(adjustPermission(parsed, { calls: 1, expiry: now + 60 })).toMatchObject({
      terms: { calls: 1 },
      expiry: now + 60,
    })
    for (const adjust of [
      { calls: 11 },
      { calls: 0 },
      { amount: 1n },
      { periodAmount: 1n },
      { expiry: spec.expiry + 1 },
    ])
      expect(() => adjustPermission(parsed, adjust)).toThrow()
    expect(() =>
      parsePermissionRequest({ ...request, rules: [{ type: 'expiry', data: { timestamp: spec.expiry + 1 } }] }, scope),
    ).toThrow()
    expect(() => buildPermission(d, { ...spec, expiry: spec.expiry + 1 })).toThrow()
    expect(() => adjustPermission({ ...parsed, adjustable: false }, { calls: 1 })).toThrow()
  })
})

import * as sdk from '@agent-jobs/sdk'
import { type Abi, type Hex, concat, encodeAbiParameters, encodePacked, toFunctionSelector } from 'viem'
import { describe, expect, it } from 'vitest'
import { type SponsorRules, readDelegation } from './sponsor.ts'
import { deepLink, linkMessageProblem } from './telegram.ts'

const wallet = '0x1111111111111111111111111111111111111111'
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as const
const caveat = (enforcer: string, terms: Hex) => ({ enforcer, terms, args: '0x' })
/** The delegation with one caveat's terms replaced. */
const swap =
  (enforcer: string, terms: Hex) =>
  <T extends { message: { caveats: Array<{ enforcer: string; terms: Hex }> } }>(x: T) => ({ ...x, message: { ...x.message, caveats: x.message.caveats.map((c) => (c.enforcer === enforcer ? { ...c, terms } : c)) } })

describe('Telegram link', () => {
  it('builds the bot deep link only for a code Telegram passes to /start', () => {
    expect(deepLink('a1_B-2')).toBe('https://t.me/hireling_xyz_bot?start=a1_B-2')
    expect(deepLink('')).toBeNull()
    expect(deepLink('has space')).toBeNull()
    expect(deepLink('x&start=evil')).toBeNull()
    expect(deepLink('a'.repeat(65))).toBeNull()
  })

  it('signs only text that names this wallet and this code', () => {
    const prep = { nonce: 'code123', message: `Link Telegram to Hireling\nWallet: ${wallet.toUpperCase().replace('0X', '0x')}\nCode: code123`, expiresAt: 0 }
    expect(linkMessageProblem(prep, wallet)).toBeNull()
    expect(linkMessageProblem({ ...prep, message: 'Link Telegram\nCode: code123' }, wallet)).toMatch(/wallet/)
    expect(linkMessageProblem({ ...prep, nonce: 'other' }, wallet)).toMatch(/code/)
    expect(linkMessageProblem({ ...prep, nonce: 'bad code', message: `${wallet} bad code` }, wallet)).toMatch(/Telegram accepts/)
  })
})

describe('sponsorship delegation', () => {
  const enforcers = { erc20TransferAmount: a(0xc1), allowedCalldata: a(0xc2), valueLte: a(0xc3), allowedTargets: a(0xc4), allowedMethods: a(0xc5), limitedCalls: a(0xc6), timestamp: a(0xc7) }
  const holding = a(0xd1)
  const vault = a(0xd2)
  const rules: SponsorRules = {
    chainId: 10143,
    manager: a(0xaa),
    relay: a(0xbb),
    enforcers,
    targets: { [holding]: { name: 'Holding', abi: sdk.hirelingHoldingAbi as Abi }, [vault]: { name: 'Stake vault', abi: sdk.stakeVaultAbi as Abi } },
  }
  const settle = toFunctionSelector('function settle(uint256 jobId)')
  const withdraw = toFunctionSelector('function withdraw()')
  const caveats = [
    caveat(enforcers.allowedTargets, concat([holding, vault])),
    caveat(enforcers.allowedMethods, concat([settle, withdraw])),
    caveat(enforcers.limitedCalls, encodeAbiParameters([{ type: 'uint256' }], [50n])),
    caveat(enforcers.timestamp, encodePacked(['uint128', 'uint128'], [0n, 1_800_000_000n])),
    caveat(enforcers.valueLte, encodeAbiParameters([{ type: 'uint256' }], [0n])),
  ]
  const good = {
    primaryType: 'Delegation',
    domain: { name: 'DelegationManager', version: '1', chainId: 10143, verifyingContract: rules.manager.toUpperCase().replace('0X', '0x') },
    message: { delegate: rules.relay, delegator: wallet, authority: `0x${'f'.repeat(64)}`, caveats, salt: '1' },
  }
  const read = (patch: (x: typeof good) => unknown) => readDelegation(JSON.stringify(patch(structuredClone(good))), wallet, rules)
  const problem = (patch: (x: typeof good) => unknown) => {
    const r = read(patch)
    return r.ok ? null : r.problem
  }
  const without = (enforcer: string) => (x: typeof good) => ({ ...x, message: { ...x.message, caveats: x.message.caveats.filter((c) => c.enforcer !== enforcer) } })

  it('reads the limits from the caveats of a root delegation from this wallet to the relay', () => {
    const r = read((x) => x)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.policy.targets.map((t) => t.name)).toEqual(['Holding', 'Stake vault'])
    expect(r.policy.methods.map((m) => m.name)).toEqual(['settle', 'withdraw'])
    expect(r.policy.calls).toBe(50n)
    expect(r.policy.validUntil).toBe(1_800_000_000)
  })

  it('refuses the wrong envelope', () => {
    expect(readDelegation('not json', wallet, rules)).toMatchObject({ ok: false, problem: expect.stringMatching(/could not be read/) })
    expect(problem((x) => ({ ...x, primaryType: 'Permit' }))).toMatch(/not a delegation/)
    expect(problem((x) => ({ ...x, domain: { ...x.domain, chainId: 143 } }))).toMatch(/another network/)
    expect(problem((x) => ({ ...x, domain: { ...x.domain, verifyingContract: rules.relay } }))).toMatch(/another network/)
    expect(problem((x) => ({ ...x, message: { ...x.message, delegator: rules.relay } }))).toMatch(/not from your wallet/)
    expect(problem((x) => ({ ...x, message: { ...x.message, delegate: wallet } }))).toMatch(/relay/)
    expect(problem((x) => ({ ...x, message: { ...x.message, authority: `0x${'1'.repeat(64)}` } }))).toMatch(/derives/)
  })

  it('refuses a delegation without all four limits, or with an unknown enforcer', () => {
    expect(problem((x) => ({ ...x, message: { ...x.message, caveats: [] } }))).toMatch(/no limits/)
    expect(problem((x) => ({ ...x, message: { ...x.message, caveats: [...x.message.caveats, caveat(wallet, '0x')] } }))).toMatch(/does not know/)
    for (const e of [enforcers.allowedTargets, enforcers.allowedMethods, enforcers.limitedCalls, enforcers.timestamp]) expect(problem(without(e))).toMatch(/missing a limit/)
  })

  it('refuses a target that is not a Hireling contract, and empty bounds', () => {
    expect(problem(swap(enforcers.allowedTargets, concat([holding, a(0xee)])))).toMatch(/not a Hireling contract/)
    expect(problem(swap(enforcers.allowedTargets, '0x1234'))).toMatch(/malformed/)
    expect(problem(swap(enforcers.limitedCalls, encodeAbiParameters([{ type: 'uint256' }], [0n])))).toMatch(/no call count/)
    expect(problem(swap(enforcers.timestamp, encodePacked(['uint128', 'uint128'], [0n, 0n])))).toMatch(/no end time/)
  })

  // The AllowedTargetsEnforcer reads its terms 20 bytes at a time. `encodePacked(['address[]'], …)` pads each address
  // to 32 bytes, which the enforcer refuses on every redemption; so does this check, before anything is signed.
  it('refuses targets packed as a padded address array', () => {
    expect(problem(swap(enforcers.allowedTargets, encodePacked(['address[]'], [[holding, vault]])))).toMatch(/malformed|not a Hireling contract/)
    expect(problem(swap(enforcers.allowedTargets, encodePacked(['address[]'], [[holding, vault, holding, vault]])))).toMatch(/malformed|not a Hireling contract/)
  })
})

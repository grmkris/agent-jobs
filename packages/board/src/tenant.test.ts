import { describe, expect, it } from 'vitest'
import * as sdk from '@agent-jobs/sdk'
import { isAllowedOrigin, originOf, publicTenant, tenantDefaults, tenantRefusal, tenantToken, validateBoardInput } from './tenant.ts'

const deployment = sdk.deployment('monad-testnet')
const tokens = deployment.rewardTokens.map((address, i) => ({ address, symbol: ['mUSD', 'mEUR', 'CHOMP'][i] ?? `T${i}`, decimals: 18 }))
/** A user's token nobody lists (ADR-0010): any ERC-20 by address. */
const userToken = { address: '0x00000000000000000000000000000000000c40a1' as const, symbol: 'PET', decimals: 18 }
const resolveToken = async (address: `0x${string}`) => {
  const t = [...tokens, userToken].find((x) => x.address.toLowerCase() === address.toLowerCase())
  if (t === undefined) throw new Error('not an ERC-20')
  return t
}
const owner = '0x9819C243702dD06E8D793987F0F46f793996c71c' as const

describe('tenant', () => {
  it('the public board offers every stack and token and allows only its own host', () => {
    const t = publicTenant(deployment, tokens)
    expect(t.id).toBe('public')
    expect(t.stacks).toEqual(Object.keys(deployment.stacks))
    expect(isAllowedOrigin(t, 'https://api.example', 'api.example')).toBe(true)
    expect(isAllowedOrigin(t, 'https://evil.example', 'api.example')).toBe(false)
    expect(isAllowedOrigin(t, undefined, 'api.example')).toBe(false)
    expect(tenantRefusal(t, { token: userToken.address })).toBeUndefined()
    expect(tenantRefusal(t, { tokens: [userToken.address, 'mUSD'] })).toBeUndefined()
  })

  it('validates a board: slug, stacks, tokens by symbol or address, origins', async () => {
    const t = await validateBoardInput(
      { slug: 'monad-pet', name: 'Monad Pet', stacks: ['demo'], rewardTokens: ['mUSD', tokens[1]!.address], allowedOrigins: ['https://pet.example', 'http://localhost:*'], drip: true },
      deployment,
      owner,
      1000,
      resolveToken,
    )
    expect(t.defaultStack).toBe('demo')
    expect(t.rewardTokens).toEqual([tokens[0]!.address, tokens[1]!.address])
    expect(isAllowedOrigin(t, 'https://pet.example', 'api.example')).toBe(true)
    expect(isAllowedOrigin(t, 'http://localhost:5173', 'api.example')).toBe(true)
    expect(isAllowedOrigin(t, 'https://pet.example.evil', 'api.example')).toBe(false)
    await expect(validateBoardInput({ slug: 'Bad Slug', name: 'x' }, deployment, owner, 1, resolveToken)).rejects.toThrow(/slug/)
    await expect(validateBoardInput({ slug: 'public', name: 'x' }, deployment, owner, 1, resolveToken)).rejects.toThrow(/hosted board/)
    await expect(validateBoardInput({ slug: 'ok-slug', name: 'x', stacks: ['nope'] }, deployment, owner, 1, resolveToken)).rejects.toThrow(/unknown stack/)
    await expect(validateBoardInput({ slug: 'ok-slug', name: 'x', rewardTokens: ['DOGE'] }, deployment, owner, 1, resolveToken)).rejects.toThrow(/by its address/)
    await expect(
      validateBoardInput({ slug: 'ok-slug', name: 'x', rewardTokens: ['0x00000000000000000000000000000000000dead1'] }, deployment, owner, 1, resolveToken),
    ).rejects.toThrow(/not an ERC-20/)
    const own = await validateBoardInput({ slug: 'pet-board', name: 'Pet', rewardTokens: [userToken.address] }, deployment, owner, 1, resolveToken)
    expect(own.tokens).toEqual([userToken])
    expect(tenantRefusal(own, { token: 'mUSD' })).toMatch(/pays in PET/)
    await expect(validateBoardInput({ slug: 'ok-slug', name: 'x', allowedOrigins: ['https://a.example/path'] }, deployment, owner, 1, resolveToken)).rejects.toThrow(/origin/)
    await expect(validateBoardInput({ slug: 'ok-slug', name: 'x', allowedOrigins: ['http://a.example'] }, deployment, owner, 1, resolveToken)).rejects.toThrow(/https/)
  })

  it('refuses a stack or token outside the board and fills defaults', async () => {
    const t = await validateBoardInput({ slug: 'monad-pet', name: 'Monad Pet', stacks: ['demo'], rewardTokens: ['mUSD'], defaultApprover: owner }, deployment, owner, 1, resolveToken)
    expect(tenantRefusal(t, { stack: 'main' })).toMatch(/stacks demo/)
    expect(tenantRefusal(t, { token: 'mEUR' })).toMatch(/pays in mUSD/)
    expect(tenantRefusal(t, { tokens: ['mUSD', 'mEUR'] })).toMatch(/pays in mUSD/)
    expect(tenantRefusal(t, { stack: 'demo', token: tokens[0]!.address })).toBeUndefined()
    expect(tenantDefaults(t, { title: 'x' })).toEqual({ title: 'x', stack: 'demo', approver: owner })
    expect(tenantDefaults(t, { stack: 'demo', approver: '0x0000000000000000000000000000000000000001' }).approver).toBe('0x0000000000000000000000000000000000000001')
    expect(tenantToken(t, 'musd')?.symbol).toBe('mUSD')
    expect(tenantToken(t, 'mEUR')).toBeUndefined()
  })

  it('originOf', () => {
    expect(originOf('https://a.example:8443/x?y')).toBe('https://a.example:8443')
    expect(originOf('nope')).toBeUndefined()
    expect(originOf(undefined)).toBeUndefined()
  })
})

import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MONAD_BADGE, TOKEN_LOGOS } from './tokens.generated.ts'

const publicDir = fileURLToPath(new URL('../public', import.meta.url))

describe('vendored token logos', () => {
  it('are keyed by chain and lowercase address, each with its PNG and a symbol', () => {
    const keys = Object.keys(TOKEN_LOGOS)
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) {
      expect(key).toMatch(/^(143|10143):0x[0-9a-f]{40}$/)
      const [chainId, address] = key.split(':')
      expect(existsSync(`${publicDir}/tokens/${chainId}/${address}.png`), key).toBe(true)
      expect(TOKEN_LOGOS[key]!.symbol.trim()).not.toBe('')
    }
    expect(existsSync(`${publicDir}${MONAD_BADGE}`)).toBe(true)
  })

  it('ship no logo the manifest does not name (a stale file would be served)', () => {
    for (const chainId of ['143', '10143']) {
      for (const file of readdirSync(`${publicDir}/tokens/${chainId}`))
        expect(TOKEN_LOGOS[`${chainId}:${file.replace(/\.png$/, '')}`], file).toBeDefined()
    }
  })

  it("lists testnet USDC, so Sidequest's reward token shows its real logo", () => {
    expect(TOKEN_LOGOS['10143:0x534b2f3a21130d7a60830c2df862319e593943a3']?.symbol).toBe('USDC')
  })
})

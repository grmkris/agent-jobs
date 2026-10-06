import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { WagmiProvider } from 'wagmi'
import { describe, expect, it } from 'vitest'
import { registerTokens } from '../../format.ts'
import { deployment, wagmiConfig } from '../../wallet.ts'
import { StaticTokens, TokenAmount } from './TokenAmount.tsx'

const render = (node: ReactNode) =>
  renderToStaticMarkup(
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>
    </WagmiProvider>,
  )
const text = (html: string) => html.replace(/<[^>]*>/g, '')
const musd = deployment.rewardTokens[0]!
const fakeUsdc = '0x00000000000000000000000000000000000fa4e1'
const realUsdc = '0x534b2f3A21130d7a60830c2Df862319e593943A3'
registerTokens([{ address: fakeUsdc, symbol: 'USDC', decimals: 6 }, { address: realUsdc, symbol: 'USDC', decimals: 6 }])

describe('token chip', () => {
  it('reads as exactly its amount: one text span, an icon that adds no text, no popover until opened', () => {
    const html = render(<TokenAmount value="4500000" token={musd} />)
    expect(text(html)).toBe('4.5 mUSD')
    expect(html.match(/<span>4\.5 mUSD<\/span>/g)).toHaveLength(1)
    expect(html).toContain('<button')
    expect(html).not.toMatch(/Listed by|View on|Copy token address/)
  })

  it('is plain inside a link or button', () => {
    const html = render(<StaticTokens><TokenAmount value={4500000n} token={musd} /></StaticTokens>)
    expect(html).not.toContain('<button')
    expect(text(html)).toBe('4.5 mUSD')
  })

  it('never gives an unlisted token a logo for its symbol: a fake "USDC" gets a marked letter disc', () => {
    const fake = render(<TokenAmount value="1000000" token={fakeUsdc} static />)
    expect(fake).not.toContain('<img')
    expect(fake).toContain('data-label="U"')
    expect(fake).toContain('bg-warning')
    expect(text(fake)).toBe('1 USDC')
    const real = render(<TokenAmount value="1000000" token={realUsdc} static />)
    expect(real).toContain(`src="/tokens/10143/${realUsdc.toLowerCase()}.png"`)
    expect(real).not.toContain('bg-warning')
  })

  it('draws the tokens Sidequest deploys', () => {
    expect(render(<TokenAmount value="10000000000000000000000" token={deployment.factory} static />)).toMatch(/<svg[^>]*aria-hidden="true"[\s\S]*10,000 SIDE/)
  })
})

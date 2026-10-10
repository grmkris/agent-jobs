import { BACKER_SHARE_KEY, encodeBackerShare, identityAbi } from '@sidequest/sdk'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import { WagmiProvider } from 'wagmi'
import { hashFn, readContractsQueryOptions } from 'wagmi/query'
import { chain, deployment, wagmiConfig } from '../../wallet.ts'
import * as profiles from '../../agent-profiles.ts'
import { AgentPicker, rankBackable } from './AgentPicker.tsx'

afterEach(() => vi.restoreAllMocks())

it('shows Backers get for a positive share and hides zero-share chips', () => {
  vi.spyOn(profiles, 'useAgentAvatar').mockReturnValue(null)
  const client = new QueryClient({ defaultOptions: { queries: { queryKeyHashFn: hashFn } } })
  const options = readContractsQueryOptions(wagmiConfig, {
    contracts: ['7', '8'].map(
      (id) =>
        ({
          address: deployment.identity,
          abi: identityAbi,
          functionName: 'getMetadata',
          args: [BigInt(id), BACKER_SHARE_KEY],
          chainId: chain.id,
        }) as const,
    ),
  })
  client.setQueryData(options.queryKey, [
    { status: 'success', result: encodeBackerShare(5000) },
    { status: 'success', result: encodeBackerShare(0) },
  ])
  const html = renderToStaticMarkup(
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={client}>
        <AgentPicker
          agents={[
            { wallet: deployment.relay, name: 'Sharing agent', agentId: '7', yours: false },
            { wallet: deployment.admin, name: 'Zero-share agent', agentId: '8', yours: false },
          ]}
          onPick={() => undefined}
        />
      </QueryClientProvider>
    </WagmiProvider>,
  )
  expect(html).toContain('Backers get 50 %')
  expect(html).not.toContain('Backers get 0 %')
  expect(html).not.toContain('shares 50 %')
  client.clear()
})

const presence = (freshness: 'fresh' | 'unknown') => ({
  presence: { freshness, state: null, accepting: true, lastSeenBucket: null },
})

const agent = (name: string, agentId: string, yours: boolean, around: boolean) => ({
  wallet: deployment.relay,
  name,
  agentId,
  yours,
  presence: presence(around ? 'fresh' : 'unknown'),
})

it('ranks your own agents first, then agents around now, then by work delivered', () => {
  const ranked = rankBackable(
    [
      agent('quiet', '1', false, false),
      agent('busy', '2', false, false),
      agent('live', '3', false, true),
      agent('mine', '4', true, false),
    ],
    new Map([
      ['1', 1],
      ['2', 9],
    ]),
    1_000,
  )
  expect(ranked.map((a) => a.name)).toEqual(['mine', 'live', 'busy', 'quiet'])
})

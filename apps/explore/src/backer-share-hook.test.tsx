import { BACKER_SHARE_KEY, encodeBackerShare, identityAbi } from '@sidequest/sdk'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { WagmiProvider } from 'wagmi'
import { hashFn, readContractsQueryOptions } from 'wagmi/query'
import { useBackerShares } from './backer-share.ts'
import { chain, deployment, wagmiConfig } from './wallet.ts'

type ReadResult = { status: 'success'; result: `0x${string}` } | { status: 'failure'; error: Error }

/** Server rendering consumes the real wagmi cache without running effects or contacting an RPC. */
function read(ids: string[], cachedIds: string[], results?: ReadResult[]) {
  const observed = new Map<string, number | null>()
  const client = new QueryClient({ defaultOptions: { queries: { queryKeyHashFn: hashFn } } })
  const options = readContractsQueryOptions(wagmiConfig, {
    contracts: cachedIds.map(
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
  if (results !== undefined) client.setQueryData(options.queryKey, results)
  function View() {
    const result = useBackerShares(ids)
    for (const [id, value] of result.shares) observed.set(id, value)
    return null
  }
  renderToStaticMarkup(
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={client}>
        <View />
      </QueryClientProvider>
    </WagmiProvider>,
  )
  return observed
}

it('batches distinct valid IDs at this deployment’s metadata key', () => {
  expect([
    ...read(
      ['7', '7', '-1', 'bad', '9', '9'.repeat(78)],
      ['7', '9'],
      [
        { status: 'success', result: encodeBackerShare(5000) },
        { status: 'success', result: encodeBackerShare(10000) },
      ],
    ),
  ]).toEqual([
    ['7', 5000],
    ['9', 10000],
  ])
})

it('distinguishes unset or malformed metadata from a failed read', () => {
  expect([
    ...read(
      ['1', '2', '3', '4'],
      ['1', '2', '3', '4'],
      [
        { status: 'success', result: encodeBackerShare(5000) },
        { status: 'success', result: '0x' },
        { status: 'success', result: '0x1234' },
        { status: 'failure', error: new Error('offline') },
      ],
    ),
  ]).toEqual([
    ['1', 5000],
    ['2', 0],
    ['3', 0],
    ['4', null],
  ])
  expect([...read(['1'], ['1'])]).toEqual([['1', null]])
})

it('returns no shares for an empty set', () => {
  expect(read([], []).size).toBe(0)
})

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { agentAction } from '../../agent-api.ts'
import { type ManagedAgent, directoryListing } from '../../api.ts'
import { presenceLabel } from '../../directory-presence.ts'
import { relative } from '../../format.ts'
import { finishListingOperation, listingOperationKey } from '../../listing.ts'
import { Button } from '../ui/button.tsx'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../ui/card.tsx'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../ui/item.tsx'
import { Skeleton } from '../ui/skeleton.tsx'

/** Refusals the same key cannot fix; anything else (unavailable, a lost reply) retries with the saved key. */
const NEW_KEY = new Set(['invalid', 'forbidden', 'conflict'])

/**
 * The operator's view of an agent's worker-directory listing: not listed, or its live service ads with their expiry
 * and the agent's last activity. The operator can take one ad down or remove the agent from the directory; the agent
 * lists itself again with advertise_service. A listing is discovery only and moves no money.
 */
export function ListingCard({ agent }: { agent: ManagedAgent }) {
  const agentId = agent.agent_id
  const qc = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const listing = useQuery({
    queryKey: ['directory-listing', agentId],
    queryFn: () => directoryListing(agentId!),
    enabled: agentId !== null,
    refetchInterval: 30_000,
  })
  const takeDown = useMutation({
    mutationFn: async (serviceId: string | null) => {
      const operationKey = listingOperationKey(localStorage, agentId!, serviceId)
      try {
        await agentAction(agent.id, 'execute', { tool: 'withdraw_service', args: serviceId === null ? {} : { serviceId }, operationKey })
      } catch (failure) {
        if (NEW_KEY.has((failure as { code?: string }).code ?? '')) finishListingOperation(localStorage, agentId!, serviceId)
        throw failure
      }
      finishListingOperation(localStorage, agentId!, serviceId)
    },
    onSettled: () => {
      setConfirming(false)
      void qc.invalidateQueries({ queryKey: ['directory-listing', agentId] })
      void qc.invalidateQueries({ queryKey: ['directory-agent', agentId] })
      void qc.invalidateQueries({ queryKey: ['directory'] })
    },
  })
  if (agentId === null) return null
  const now = Math.floor(Date.now() / 1000)
  const listed = listing.data ?? null
  return (
    <Card>
      <CardHeader>
        <CardTitle>Directory listing</CardTitle>
        <CardDescription>
          {listing.isLoading
            ? 'Checking the worker directory…'
            : listing.isError
              ? 'The worker directory cannot be read right now.'
              : listed === null
                ? 'Not listed. Your agent lists its services itself with advertise_service.'
                : `Listed · ${presenceLabel(listed, now)}`}
        </CardDescription>
      </CardHeader>
      {listing.isLoading && (
        <CardContent>
          <Skeleton className="h-12 w-full" />
        </CardContent>
      )}
      {listed !== null && (
        <CardContent className="flex flex-col gap-3">
          {listed.ads.length === 0 ? (
            <p className="text-sm text-muted-foreground">No live service ads. Each ad lasts 24 hours unless the agent renews it.</p>
          ) : (
            <ItemGroup>
              {listed.ads.map((ad) => (
                <Item key={ad.serviceId} variant="outline" size="sm">
                  <ItemContent>
                    <ItemTitle>{ad.name}</ItemTitle>
                    <ItemDescription>
                      {ad.serviceId} · expires {relative(ad.expiresAt, now)}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button variant="outline" size="sm" disabled={takeDown.isPending} onClick={() => takeDown.mutate(ad.serviceId)}>
                      Take down
                    </Button>
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
          )}
          {takeDown.isError && (
            <p role="alert" className="text-sm text-destructive-text">
              {takeDown.error instanceof Error ? takeDown.error.message : 'The take-down failed.'} Nothing else changed; try again.
            </p>
          )}
        </CardContent>
      )}
      {listed !== null && (
        <CardFooter className="flex flex-wrap gap-2">
          {confirming ? (
            <>
              <Button variant="destructive" disabled={takeDown.isPending} onClick={() => takeDown.mutate(null)}>
                Remove from directory
              </Button>
              <Button variant="ghost" disabled={takeDown.isPending} onClick={() => setConfirming(false)}>
                Keep listed
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => setConfirming(true)}>
              Remove from directory…
            </Button>
          )}
        </CardFooter>
      )}
    </Card>
  )
}

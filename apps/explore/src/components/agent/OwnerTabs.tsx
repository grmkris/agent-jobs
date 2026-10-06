import { Alert, AlertDescription } from '../ui/alert.tsx'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '../ui/empty.tsx'
import { useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useEffect, useState } from 'react'
import type { Address } from 'viem'
import type { ManagedAgent } from '../../api.ts'
import { useManagedApprovals } from '../../managed.ts'
import { StartPrompt } from '../AgentStartLink.tsx'
import { ConnectionCard } from '../ConnectionCard.tsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs.tsx'

import { useAuth } from '../Wallet.tsx'
import { Approval } from './Approval.tsx'
import { ManagedAgentCard } from './ManagedAgentCard.tsx'

const TABS = ['overview', 'approvals', 'manage', 'connect'] as const
export type OwnerTab = (typeof TABS)[number]

/** The tab a link asked for (`?tab=`), Overview otherwise. */
export function ownerTab(search: string): OwnerTab {
  const tab = new URLSearchParams(search).get('tab')
  return TABS.find((t) => t === tab) ?? 'overview'
}

const triggerClass = 'flex-none px-0 min-h-9 pointer-coarse:min-h-11 group-data-horizontal/tabs:after:bottom-[-1px]'

/**
 * An agent's page as its operator sees it: the public profile under Overview, then what only the operator can do —
 * decide its approvals, manage its weekly budget, earnings and access, and connect it. The tab is kept in the URL.
 */
export function OwnerTabs({ id, managed, overview }: { id: string; managed: ManagedAgent; overview: ReactNode }) {
  const [tab, setTab] = useState(() => ownerTab(window.location.search))
  const approvals = useManagedApprovals()
  const pending = (approvals.data?.approvals ?? []).filter((a) => a.agent_id === managed.id && a.status === 'pending').length
  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    if (tab === 'overview') p.delete('tab')
    else p.set('tab', tab)
    const s = p.toString()
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${s === '' ? '' : `?${s}`}`)
  }, [tab])
  return (
    <Tabs value={tab} onValueChange={(value) => setTab(value as OwnerTab)} className="gap-7">
      <TabsList
        variant="line"
        aria-label="Your agent"
        className="w-full justify-start gap-5 rounded-none border-b p-0 group-data-horizontal/tabs:h-auto"
      >
        <TabsTrigger value="overview" className={triggerClass}>
          Overview
        </TabsTrigger>
        <TabsTrigger value="approvals" className={triggerClass}>
          Approvals
          {pending > 0 && (
            <span className="rounded-full bg-warning/15 px-1.5 text-micro font-semibold text-warning-text tabular">
              {pending}
              <span className="sr-only"> waiting</span>
            </span>
          )}
        </TabsTrigger>
        <TabsTrigger value="manage" className={triggerClass}>
          Manage
        </TabsTrigger>
        <TabsTrigger value="connect" className={triggerClass}>
          Connect
        </TabsTrigger>
      </TabsList>
      <TabsContent value="overview" className="grid gap-7 text-base">
        {overview}
      </TabsContent>
      <TabsContent value="approvals" className="grid gap-7 text-base">
        <Approvals managed={managed} />
      </TabsContent>
      <TabsContent value="manage" className="grid gap-7 text-base">
        <ManagedAgentCard agent={managed} />
      </TabsContent>
      <TabsContent value="connect" className="grid gap-7 text-base">
        <StartPrompt />
        <ConnectionCard />
      </TabsContent>
    </Tabs>
  )
}

/** This agent's decisions, waiting ones first. Within-limit work never lands here. */
function Approvals({ managed }: { managed: ManagedAgent }) {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const approvals = useManagedApprovals()
  const mine = (approvals.data?.approvals ?? [])
    .filter((a) => a.agent_id === managed.id)
    .toSorted((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending'))
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['managed-approvals', auth.address] })
  if (approvals.error !== null)
    return (
      <Alert variant="destructive">
        <AlertDescription>Approval records are unavailable. No decision has been submitted.</AlertDescription>
      </Alert>
    )
  if (approvals.isLoading) return <p className="text-muted-foreground">Reading this agent’s decisions…</p>
  if (mine.length === 0)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{'Nothing waiting for you'}</EmptyTitle>
          <EmptyDescription>Hires within the weekly budget go ahead without asking. Bigger spends wait here for you.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  return mine.map((approval) => (
    <Approval key={approval.id} approval={approval} agent={managed} operator={auth.address as Address} refresh={refresh} />
  ))
}

/**
 * The top of an agent's page: its orb, its name (or "Agent ID N"), its wallet and presence, what it says it does, and
 * what a visitor can do — hire it, back it, share it, look it up on the explorer. Its owner gets no Hire.
 */
import type { DirectoryAgent } from '@sidequest/sdk'
import { Link } from '@tanstack/react-router'
import { Check, ExternalLink, Radio, Share } from 'lucide-react'
import { useState } from 'react'
import { directoryLiveness, presenceLabel } from '../../directory-presence.ts'
import { cn } from '../../lib/cn.ts'
import type { AgentIdentity } from '../../routes/Agent.tsx'
import { agentExplorerLinks, explorer } from '../../wallet.ts'
import { BoardLink, boardRoutes } from '../BoardLink.tsx'
import { Address } from '../kit.tsx'
import { useNow } from '../Time.tsx'
import { buttonVariants } from '../ui/button.tsx'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu.tsx'
import { AgentOrb } from './AgentOrb.tsx'

/** Where else to look it up: its identity NFT and 8004scan profile, and its wallet. */
function ExplorerMenu({ id, wallet }: { id: string; wallet: `0x${string}` | undefined }) {
  const links = [...agentExplorerLinks(id).map((l) => ({ label: `Agent on ${l.name}`, href: l.href })), ...(wallet === undefined ? [] : [{ label: 'Wallet on Monadscan', href: explorer('address', wallet) }])]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="Look it up on an explorer" title="Look it up on an explorer" className={buttonVariants({ variant: 'outline', size: 'icon' })}>
        <ExternalLink aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuGroup>
          {links.map((link) => (
            <DropdownMenuItem key={link.label} render={<a href={link.href} target="_blank" rel="noreferrer" />}>
              {link.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ShareButton({ title }: { title: string }) {
  const [copied, setCopied] = useState(false)
  async function share() {
    const url = window.location.href.split('?')[0] as string
    // The native sheet where there is one (iPhone, Mac Safari); otherwise the link goes to the clipboard.
    if (typeof navigator.share === 'function' && navigator.canShare?.({ url }) !== false) {
      await navigator.share({ title, url }).catch(() => undefined)
      return
    }
    await navigator.clipboard.writeText(url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    }, () => undefined)
  }
  return (
    <button type="button" onClick={() => void share()} aria-label={copied ? 'Link copied' : 'Share this agent'} title="Share" className={buttonVariants({ variant: 'outline', size: 'icon' })}>
      {copied ? <Check aria-hidden /> : <Share aria-hidden />}
    </button>
  )
}

export function ProfileHeader({
  id,
  identity,
  wallet,
  directory,
  owner,
}: {
  id: string
  identity: AgentIdentity
  wallet: `0x${string}` | undefined
  directory: DirectoryAgent | undefined
  owner: boolean
}) {
  const profile = identity.profile?.kind === 'json' ? identity.profile : null
  const name = profile?.name ?? directory?.profile.name ?? null
  const title = name ?? `Agent ID ${id}`
  const now = useNow()
  // The ring: working while it reports itself busy, live on a fresh heartbeat or an MCP call in the last ten minutes.
  const status = directory === undefined ? 'idle' : directoryLiveness(directory, now)
  return (
    <header className="grid gap-4">
      <div className="flex items-center gap-5">
        {profile?.image !== null && profile?.image !== undefined ? (
          <img src={profile.image} alt="" className="size-18 shrink-0 rounded-full bg-muted object-cover" />
        ) : (
          <AgentOrb agentId={id} size="lg" status={status} />
        )}
        <div className="grid min-w-0 gap-1">
          <h1 className="text-3xl leading-tight font-semibold tracking-tight [overflow-wrap:anywhere]">{title}</h1>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-muted-foreground">
            {name !== null && <span>Agent ID {id}</span>}
            {identity.exists === null && <span>Identity check unavailable</span>}
            {wallet !== undefined && <Address value={wallet} />}
            {directory !== undefined && (
              <span className="inline-flex items-center gap-1.5">
                <Radio aria-hidden className={cn('size-3.5 shrink-0', status !== 'idle' && 'text-success-text')} />
                {presenceLabel(directory, now)}
              </span>
            )}
          </div>
        </div>
      </div>
      {profile?.description !== null && profile?.description !== undefined && <p className="leading-relaxed text-muted-foreground">{profile.description}</p>}
      {identity.exists !== false && (
        <div className="flex flex-wrap items-center gap-2">
          {!owner && (
            <BoardLink target={{ ...boardRoutes().publish(), search: { invite: id } }} className={buttonVariants()}>
              Hire this agent
            </BoardLink>
          )}
          {wallet !== undefined && (
            <Link to="/backing" search={{ account: wallet }} className={buttonVariants({ variant: 'secondary' })}>
              Back this agent
            </Link>
          )}
          <ShareButton title={title} />
          <ExplorerMenu id={id} wallet={wallet} />
        </div>
      )}
    </header>
  )
}

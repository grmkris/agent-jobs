/**
 * Where the work is (ADR-0006: a git commit, a patch, a file, a live URL or an on-chain result) and what was checked
 * about it: the board's one-time check at submit (advisory) and any signed attestation of a required GitHub check.
 */
import { Check, CircleAlert, ExternalLink } from 'lucide-react'
import type { Deliverable, DeliverableCheck } from '../../api.ts'
import { Address, Badge, Group, ListRow, Section, TxLink, cn } from '../ui.tsx'

const httpUrl = (url: string) => (url.startsWith('ipfs://') ? `https://ipfs.io/ipfs/${url.slice('ipfs://'.length)}` : url)
const KIND: Record<Deliverable['kind'], string> = { git: 'Git commit', patch: 'Patch', artifact: 'File', url: 'Live URL', onchain: 'On-chain result' }

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 text-tint [overflow-wrap:anywhere]">
      <span className="min-w-0">{children}</span>
      <ExternalLink aria-hidden className="size-3 shrink-0" />
    </a>
  )
}

function Where({ d }: { d: Deliverable }) {
  switch (d.kind) {
    case 'git': {
      const tree = /^https:\/\/(github\.com|gitlab\.com|codeberg\.org|gitea\.com)\//.test(d.url) ? `${d.url.replace(/\.git$/, '')}/tree/${d.sha}` : d.url
      let host = d.url
      try {
        host = new URL(d.url).pathname.replace(/^\/|\.git$/g, '')
      } catch {
        // not a URL: show it as given
      }
      return <Link href={tree}>{host} · {d.ref} @ {d.sha.slice(0, 7)}</Link>
    }
    case 'patch':
      return <Link href={httpUrl(d.url)}>Patch on {d.base.slice(0, 7)}</Link>
    case 'artifact':
      return <Link href={httpUrl(d.url)}>{d.name} ({d.mediaType})</Link>
    case 'url':
      return <Link href={d.url}>{d.url.replace(/^https?:\/\//, '')}</Link>
    case 'onchain':
      return (
        <span className="inline-flex flex-wrap items-center gap-2">
          {d.txHash !== undefined && <TxLink hash={d.txHash} />}
          {d.address !== undefined && <Address value={d.address} />}
        </span>
      )
  }
}

function CheckLine({ check }: { check: DeliverableCheck | null }) {
  if (check === null) return null
  const ok = check.ok === true
  return (
    <span className={cn('flex items-center gap-1.5 text-ui', ok ? 'text-ok' : check.ok === false ? 'text-bad' : 'text-label-2')}>
      {ok ? <Check aria-hidden className="size-3.5" strokeWidth={3} /> : <CircleAlert aria-hidden className="size-3.5" />}
      {ok ? 'Checked at submit' : check.ok === false ? 'Check at submit failed' : 'Not checked'}
      <span className="text-label-3">· {check.detail}</span>
    </span>
  )
}

/** One deliverable as a line of text, with its check. */
export function DeliverableLine({ d, check }: { d: Deliverable; check: DeliverableCheck | null }) {
  return (
    <span className="grid gap-0.5 text-sm">
      <span className="text-label-2">
        {KIND[d.kind]} · <Where d={d} />
      </span>
      <CheckLine check={check} />
    </span>
  )
}

export interface EvidenceRow {
  verifier: string
  submission_hash: string
  tested_sha: string
  conclusion: string
  expired: boolean
  onchainMatch: boolean
  tx_hash: string
}

export function Delivered({
  deliverables,
  evidence,
}: {
  deliverables: Array<{ deliverable_hash: string; descriptor: Deliverable; check: DeliverableCheck | null }>
  evidence: EvidenceRow[]
}) {
  if (deliverables.length === 0 && evidence.length === 0) return null
  return (
    <Section title="Delivered" note="The board checks a delivery once when it is submitted; that check is advice. The approver decides.">
      <Group>
        {deliverables.map((x) => (
          <ListRow key={x.deliverable_hash}>
            <DeliverableLine d={x.descriptor} check={x.check} />
          </ListRow>
        ))}
        {evidence.map((e) => (
          <ListRow key={e.tx_hash}>
            <span className="grid flex-1 gap-1 text-sm">
              <span className="flex flex-wrap items-center gap-2">
                <Badge tone={e.conclusion === 'success' ? 'success' : 'danger'}>{e.conclusion === 'success' ? 'Check passed' : 'Check failed'}</Badge>
                <span className="text-label-2">{e.onchainMatch ? 'on the delivered commit' : e.expired ? 'attestation expired' : 'on a different commit'}</span>
              </span>
              <span className="flex flex-wrap items-center gap-2 text-ui text-label-3">
                Signed by <Address value={e.verifier} /> <TxLink hash={e.tx_hash} />
              </span>
            </span>
          </ListRow>
        ))}
      </Group>
    </Section>
  )
}

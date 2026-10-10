/** Display-only frozen terms from another board; they never create a local board task or action authority. */
import type { JobTag } from '@sidequest/sdk'
import type { TaskIndexEntry } from './api.ts'
import { Brief } from './components/job/JobParts.tsx'

export interface ForeignOffer {
  termsHash: string
  origin: string
  terms: {
    title: string
    brief: string
    acceptanceCriteria: readonly string[]
    tags?: readonly JobTag[]
    quote: { requestHash: string; quoteHash: string } | null
    windows: { reviewSeconds: number; disputeSeconds: number; arbitrationSeconds: number }
  }
}

interface LocalOfferDetail {
  title: string
  termsHash: string
  terms: { brief?: string; acceptanceCriteria?: readonly string[]; windows?: ForeignOffer['terms']['windows'] }
}

export function jobOfferFields(input: {
  jobId: string
  local?: TaskIndexEntry | undefined
  detail?: LocalOfferDetail | undefined
  foreign?: ForeignOffer | null | undefined
  chainHash?: string | null | undefined
}) {
  const { local, detail, foreign } = input
  const termsHash = local?.termsHash ?? detail?.termsHash ?? foreign?.termsHash ?? input.chainHash
  const origin = foreign?.origin
  const manifestUrl =
    local?.manifestUrl ??
    (detail === undefined ? undefined : `/offers/${detail.termsHash}.json`) ??
    (foreign == null ? undefined : `${foreign.origin}/offers/${foreign.termsHash}.json`)
  return {
    title: local?.title ?? detail?.title ?? foreign?.terms.title ?? `Job #${input.jobId}`,
    brief: local?.brief ?? detail?.terms.brief ?? foreign?.terms.brief,
    criteria: local?.acceptanceCriteria ?? detail?.terms.acceptanceCriteria ?? foreign?.terms.acceptanceCriteria ?? [],
    windows: detail?.terms.windows ?? foreign?.terms.windows,
    termsHash,
    manifestUrl,
    origin,
  }
}
export type JobOfferFields = ReturnType<typeof jobOfferFields>

export function HostedBy({ origin }: { origin: string | undefined }) {
  return origin === undefined ? null : <span>hosted by {new URL(origin).host}</span>
}

export function OfferIdentity({ offer }: { offer: JobOfferFields }) {
  if (offer.manifestUrl === undefined) return <span>offer not found on known boards</span>
  return (
    <a
      className="inline-flex py-3.5 font-mono text-ui underline underline-offset-4"
      href={offer.manifestUrl}
      target="_blank"
      rel="noreferrer"
    >
      {offer.termsHash?.slice(0, 12)}…
    </a>
  )
}

/** The job page's frozen brief and acceptance criteria. */
export function JobOfferBrief({ offer, met = false }: { offer: JobOfferFields; met?: boolean }) {
  if (offer.brief === undefined) return null
  return <Brief brief={offer.brief} criteria={offer.criteria} met={met} />
}

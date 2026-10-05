/** Public, bounded checks. Submitted code is never executed by the creator. */
import { type Hex, keccak256, stringToHex } from 'viem'
import { isImmutableSha } from './demand-bot.ts'
import { demandCanonicalJson } from './demand-bot-validation.ts'

export const DEMAND_REPOSITORY = 'https://github.com/grmkris/hireling-demo-deliveries'
const repositoryPath = 'grmkris/hireling-demo-deliveries'
const maxArtifactBytes = 8 * 1024 * 1024

export type DemandDescriptor =
  | { kind: 'artifact'; url: string; sha256: string; mediaType: string; name: string }
  | { kind: 'git'; url: string; ref: string; sha: string }

export interface DemandCheckRun {
  id: number
  name: string
  head_sha: string
  status: string
  conclusion: string | null
  app: { slug: string } | null
}

export function demandDescriptorHash(descriptor: DemandDescriptor): Hex {
  const value = descriptor.kind === 'git' ? { repo: descriptor.url, branch: descriptor.ref, sha: descriptor.sha } : descriptor
  return keccak256(stringToHex(demandCanonicalJson(value)))
}

export function latestDemandTestPassed(runs: readonly DemandCheckRun[], sha: string): boolean {
  if (!isImmutableSha(sha)) return false
  const relevant = runs.filter(run => run.name === 'test' && run.head_sha === sha && run.app?.slug === 'github-actions')
  const latest = relevant.toSorted((a, b) => b.id - a.id)[0]
  return latest?.status === 'completed' && latest.conclusion === 'success'
}

export function demandArtifactUrl(value: string): URL {
  const url = new URL(value)
  const segments = url.pathname.split('/')
  if (url.protocol !== 'https:' || url.host !== 'raw.githubusercontent.com' || url.username || url.password || url.search || url.hash) throw new Error('artifact must be hosted at an immutable public GitHub URL')
  if (segments[1] !== 'grmkris' || segments[2] !== 'hireling-demo-deliveries' || !isImmutableSha(segments[3])) throw new Error('artifact must name the delivery repository and exact commit')
  if (!/\.(png|jpe?g)$/i.test(url.pathname)) throw new Error('artifact must be a PNG or JPEG')
  return url
}

export function validDemandImage(bytes: Uint8Array, mediaType: string): boolean {
  if (bytes.length < 32 || bytes.length > maxArtifactBytes) return false
  if (mediaType === 'image/png') {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10]
    if (!signature.every((value, i) => bytes[i] === value)) return false
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return String.fromCharCode(...bytes.slice(12, 16)) === 'IHDR' && view.getUint32(16) > 0 && view.getUint32(16) <= 4096 && view.getUint32(20) > 0 && view.getUint32(20) <= 4096
  }
  return mediaType === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217
}

async function boundedPublicFetch(url: URL, limit: number): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20_000), headers: { 'user-agent': 'hireling-testnet-demand', accept: 'application/vnd.github+json' } })
  if (!response.ok || response.body === null) throw new Error('public deliverable is unavailable')
  const length = Number(response.headers.get('content-length') ?? '0')
  if (length > limit) throw new Error('public response is too large')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.length
      if (size > limit) throw new Error('public response is too large')
      chunks.push(chunk.value)
    }
  } finally {
    await reader.cancel()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

export async function checkDemandDeliverable(descriptor: DemandDescriptor): Promise<boolean> {
  if (descriptor.kind === 'artifact') {
    if (!/^[0-9a-f]{64}$/.test(descriptor.sha256)) return false
    const bytes = await boundedPublicFetch(demandArtifactUrl(descriptor.url), maxArtifactBytes)
    if (!validDemandImage(bytes, descriptor.mediaType)) return false
    const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
    return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('') === descriptor.sha256
  }
  if (descriptor.url !== DEMAND_REPOSITORY || !isImmutableSha(descriptor.sha)) return false
  const runs: DemandCheckRun[] = []
  for (let page = 1; page <= 5; page++) {
    const url = new URL(`https://api.github.com/repos/${repositoryPath}/commits/${descriptor.sha}/check-runs?filter=latest&per_page=100&page=${page}`)
    const bytes = await boundedPublicFetch(url, 1024 * 1024)
    const body = JSON.parse(new TextDecoder().decode(bytes)) as { check_runs: DemandCheckRun[]; total_count: number }
    if (!Array.isArray(body.check_runs) || !Number.isSafeInteger(body.total_count) || body.total_count > 500) return false
    runs.push(...body.check_runs)
    if (runs.length >= body.total_count) return latestDemandTestPassed(runs, descriptor.sha)
  }
  return false
}

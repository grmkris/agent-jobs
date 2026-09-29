import { encodeAbiParameters, hashTypedData, keccak256, parseAbiParameters, stringToHex, type Address, type Hex } from 'viem'
import { z } from 'zod'
import { evidenceTypes, evaluatorDomain } from '../../packages/sdk/src/typed-data.ts'

const word = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((v) => v as Hex)
const uint = z.string().regex(/^(0|[1-9][0-9]*)$/).refine((v) => BigInt(v) < 2n ** 256n, 'uint256 overflow')
export const requestSchema = z.object({
  // Keep the exact URL in the hash, as the board does. Never fetch a caller-controlled origin.
  repo: z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?\/?$/),
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  jobId: uint.refine((v) => BigInt(v) > 0n),
  policyHash: word,
  submissionHash: word,
  requiredChecks: z.array(z.string().min(1).max(256)).max(100),
  validUntil: uint.refine((v) => BigInt(v) < 2n ** 48n, 'evaluator stores uint48 validity'),
}).strict()
export type EvidenceRequest = z.infer<typeof requestSchema>

const checkSchema = z.object({
  name: z.string().min(1),
  status: z.enum(['queued', 'in_progress', 'completed', 'waiting', 'pending', 'requested']),
  conclusion: z.string().nullable(),
  head_sha: z.string().regex(/^[0-9a-f]{40}$/),
  app: z.object({ slug: z.string().optional() }).nullable().optional(),
})
const responseSchema = z.object({
  total_count: z.number().int().nonnegative().max(100),
  check_runs: z.array(checkSchema).max(100),
})

/** Same object-key ordering as board/terms.ts; array order is deliberately preserved. */
export function canonicalJson(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString())
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}
export const hashText = (s: string): Hex => keccak256(stringToHex(s))

export function checkRunsUrl(input: EvidenceRequest): string {
  const slug = input.repo.slice('https://github.com/'.length).replace(/\.git\/?$/, '').replace(/\/$/, '')
  return `https://api.github.com/repos/${slug}/commits/${input.sha}/check-runs?per_page=100`
}

/** Refuse incomplete responses; do not attest a successful subset of a larger result. */
export function buildEvidence(input: EvidenceRequest, body: unknown, now: number) {
  const req = requestSchema.parse(input)
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('invalid current time')
  const validUntil = BigInt(req.validUntil)
  if (validUntil <= BigInt(now) || validUntil > BigInt(now + 7 * 86400)) throw new Error('validity must be within the next seven days')
  const result = responseSchema.parse(body)
  if (result.total_count !== result.check_runs.length) throw new Error('incomplete GitHub check-runs response; pagination is unsupported')
  if (result.check_runs.some((r) => r.head_sha !== req.sha)) throw new Error('GitHub returned a different SHA')
  const relevant = req.requiredChecks.length === 0 ? result.check_runs : result.check_runs.filter((r) => req.requiredChecks.includes(r.name))
  if (relevant.length === 0) throw new Error('no required check runs yet')
  if (relevant.some((r) => r.status !== 'completed')) throw new Error('checks are still running')
  const missing = req.requiredChecks.filter((name) => !relevant.some((r) => r.name === name))
  const checks = relevant.map((r) => ({ name: r.name, conclusion: r.conclusion, app: r.app?.slug ?? null, sha: r.head_sha }))
  const checksJson = canonicalJson({ checks, missing })
  const shaWord = `0x${req.sha.padStart(64, '0')}` as Hex
  const attestation = {
    jobId: BigInt(req.jobId),
    submissionHash: req.submissionHash,
    policyHash: req.policyHash,
    repo: hashText(req.repo),
    headSha: shaWord,
    testedSha: shaWord,
    checkRunsHash: hashText(checksJson),
    conclusion: missing.length === 0 && relevant.every((r) => r.conclusion === 'success') ? 1 : 2,
    validUntil,
  }
  return { attestation, checksJson }
}
export type Attestation = ReturnType<typeof buildEvidence>['attestation']
export const reportParameters = parseAbiParameters('(uint256 jobId,bytes32 submissionHash,bytes32 policyHash,bytes32 repo,bytes32 headSha,bytes32 testedSha,bytes32 checkRunsHash,uint8 conclusion,uint256 validUntil)')
export const encodeReport = (attestation: Attestation) => encodeAbiParameters(reportParameters, [attestation])
export const evidenceDigest = (attestation: Attestation, chainId: number, evaluator: Address) =>
  hashTypedData({ domain: evaluatorDomain(chainId, evaluator), types: evidenceTypes, primaryType: 'EvidenceAttestation', message: attestation })

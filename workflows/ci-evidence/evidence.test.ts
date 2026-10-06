import { describe, expect, it } from 'vitest'
import { decodeAbiParameters, hashTypedData, type Address, type Hex } from 'viem'
import { evidenceTypes } from '../../packages/sdk/src/typed-data.ts'
import { canonicalJson as boardCanonicalJson } from '../../packages/board/src/terms.ts'
import { buildEvidence, canonicalJson, checkRunsUrl, encodeReport, evidenceDigest, reportParameters, requestSchema, type EvidenceRequest } from './evidence.ts'
import github from './fixtures/github-check-runs.json'
import golden from './fixtures/board-attestation.json'

const input: EvidenceRequest = {
  repo: 'https://github.com/grmkris/runner-spike-fixture', sha: 'c850f7a58015bafe065257f263a2ecc01da56dfe',
  jobId: '8', policyHash: golden.attestation.policyHash as Hex, submissionHash: golden.attestation.submissionHash as Hex,
  requiredChecks: ['test'], validUntil: golden.attestation.validUntil,
}
const now = Number(input.validUntil) - 7 * 86400
const run = github.check_runs[0]!
const body = (runs: unknown[]) => ({ total_count: runs.length, check_runs: runs })

describe('board attestation compatibility', () => {
  it('preserves the historical receipt and uses a distinct Sidequest signing domain', () => {
    const result = buildEvidence(input, github, now)
    expect(JSON.parse(canonicalJson(result.attestation))).toEqual(golden.attestation)
    expect(result.checksJson).toBe(boardCanonicalJson(golden.checks))
    const historicalDigest = hashTypedData({
      domain: { name: 'AgentJobsEvaluator', version: '1', chainId: 10143, verifyingContract: golden.evaluator as Address },
      types: evidenceTypes, primaryType: 'EvidenceAttestation', message: result.attestation,
    })
    expect(historicalDigest).toBe(golden.digest)
    expect(evidenceDigest(result.attestation, 10143, golden.evaluator as Address)).not.toBe(historicalDigest)
    expect(decodeAbiParameters(reportParameters, encodeReport(result.attestation))[0]).toEqual(result.attestation)
  })
  it('preserves board key ordering, nulls and array order', () => {
    const sample = { z: undefined, checks: [{ sha: 'a', name: 'z', app: null, conclusion: 'success' }, { name: 'a' }], missing: ['z', 'a'] }
    expect(canonicalJson(sample)).toBe(boardCanonicalJson(sample))
  })
  it('binds the digest to the chain and evaluator', () => {
    const { attestation } = buildEvidence(input, github, now)
    const digest = evidenceDigest(attestation, 10143, golden.evaluator as Address)
    expect(evidenceDigest(attestation, 143, golden.evaluator as Address)).not.toBe(digest)
    expect(evidenceDigest(attestation, 10143, '0x0000000000000000000000000000000000000001')).not.toBe(digest)
  })
  it('hashes failure and missing checks exactly like the board', () => {
    const failed = { ...run, conclusion: 'failure' }
    const result = buildEvidence({ ...input, requiredChecks: ['test', 'typecheck'] }, body([failed]), now)
    expect(result.attestation.conclusion).toBe(2)
    expect(result.checksJson).toBe(boardCanonicalJson({ checks: [{ name: 'test', conclusion: 'failure', app: 'github-actions', sha: input.sha }], missing: ['typecheck'] }))
  })
  it.each(['failure', 'cancelled', 'skipped', 'neutral', 'timed_out', null])('does not call %s a success', (conclusion) => {
    expect(buildEvidence(input, body([{ ...run, conclusion }]), now).attestation.conclusion).toBe(2)
  })
  it('records a missing required check as failure even if the available check passes', () => {
    expect(buildEvidence({ ...input, requiredChecks: ['test', 'typecheck'] }, github, now).attestation.conclusion).toBe(2)
  })
  it('uses all checks if no required names were supplied', () => {
    expect(buildEvidence({ ...input, requiredChecks: [] }, body([{ ...run, name: 'other', conclusion: 'failure' }]), now).attestation.conclusion).toBe(2)
  })
})

describe('fail closed before report generation', () => {
  it.each([{ runs: [] }, { runs: [{ ...run, name: 'unrelated' }] }])('rejects no relevant checks', ({ runs }) => {
    expect(() => buildEvidence(input, body(runs), now)).toThrow('no required check runs')
  })
  it('rejects pending checks', () => {
    expect(() => buildEvidence(input, body([{ ...run, status: 'in_progress', conclusion: null }]), now)).toThrow('still running')
  })
  it('rejects a different head SHA', () => {
    expect(() => buildEvidence(input, body([{ ...run, head_sha: 'a'.repeat(40) }]), now)).toThrow('different SHA')
  })
  it.each([101, 3, -1, 1.5])('rejects incomplete or invalid totals: %s', (total_count) => {
    expect(() => buildEvidence(input, { ...github, total_count }, now)).toThrow()
  })
  it.each(['8', '0x1234', '1791132076000000000000'])('rejects expired or overflowing validity %s', (validUntil) => {
    expect(() => buildEvidence({ ...input, validUntil }, github, now)).toThrow()
  })
  it('rejects validity beyond seven days', () => {
    expect(() => buildEvidence(input, github, now - 1)).toThrow('seven days')
  })
  it.each([
    { repo: 'https://evil.example/owner/repo' }, { repo: 'https://github.com/owner/repo?secret=x' },
    { repo: 'https://github.com/owner/repo/../../x' }, { sha: 'main' }, { sha: 'c850f7a' },
    { jobId: 8 }, { jobId: '0' }, { jobId: (2n ** 256n).toString() }, { policyHash: '0x12' },
  ])('rejects unsafe inputs %j', (change) => {
    expect(() => requestSchema.parse({ ...input, ...change })).toThrow()
  })
  it('fetches only the fixed public GitHub API', () => {
    expect(checkRunsUrl(input)).toBe(`https://api.github.com/repos/grmkris/runner-spike-fixture/commits/${input.sha}/check-runs?per_page=100`)
  })
})

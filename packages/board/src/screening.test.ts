import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { screenOffer, SCREENING_PROMPT_VERSION } from './screening.ts'
import type { OfferTerms } from './terms.ts'

const address = '0x1111111111111111111111111111111111111111'
const terms: OfferTerms = {
  v: 2, deployment: { chainId: 10143, core: address, holding: address, evaluator: address, identity: address },
  taskId: 'screen', projectId: null, policyVersion: null, mode: 'hire', title: 'Add CI',
  brief: 'Run tests on push', acceptanceCriteria: ['The named check passes'], token: address,
  reward: 1_000_000n, creatorBond: 0n, workerBond: 0n, deliveryDeadline: 1_800_000_600,
  selectionDeadline: null, creator: address, approver: address,
  windows: { reviewSeconds: 120, disputeSeconds: 120, arbitrationSeconds: 300 },
  eligibility: null, evidencePolicy: null, quote: null, salt: `0x${'11'.repeat(32)}`,
}
const credentials = ['{Authorization: Bearer SECRETKEY}', '{apiKey:short}', '{apiKey:"sk-1",details:"x-api-key: ab12"}']

describe('public screening failures', () => {
  let server: Server
  let origin: string

  beforeAll(async () => {
    // Real model HTTP responses exercise askJson and its JSON parser, not a replacement screening path.
    server = createServer((request, response) => {
      const index = Number(request.url?.split('/')[1])
      const content = credentials[index] ?? JSON.stringify({ verdict: 'clean', reasons: ['The requirements are clear'] })
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ choices: [{ message: { content } }] }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address()
    if (port === null || typeof port === 'string') throw new Error('No model test port')
    origin = `http://127.0.0.1:${port.port}`
  })

  afterAll(async () => {
    if (server !== undefined) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  })

  it.each(credentials.map((_, index) => index))('hides short credential text from model response %s in reasons and logs', async (index) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const result = await screenOffer({ baseUrl: `${origin}/${index}`, apiKey: 'fixture-key', model: 'test-model' }, terms, '1 mUSD', 123)
      expect(result).toMatchObject({ verdict: 'unscreened', model: 'test-model', at: 123, promptVersion: SCREENING_PROMPT_VERSION })
      expect(log).toHaveBeenCalledTimes(1)
      const diagnostics = JSON.parse(log.mock.calls[0]![0])
      const { at, ...facts } = diagnostics as { at?: unknown }
      expect(facts).toEqual({ event: 'screening-failed', errorId: expect.any(String), name: 'SyntaxError' })
      // Where it was thrown, as function names only.
      if (at !== undefined) for (const frame of at as string[]) expect(frame).toMatch(/^[\w$#.<>]+$/)
      expect(diagnostics.errorId).toMatch(/^[0-9a-f]{12}$/)
      expect(result.reasons).toEqual([`screening unavailable (error ${diagnostics.errorId})`])
      expect(JSON.stringify([result, log.mock.calls])).not.toMatch(/SECRETKEY|Bearer|Authorization|apiKey|short|sk-1|ab12|x-api-key/)
    } finally { log.mockRestore() }
  })

  it('keeps a valid advisory answer', async () => {
    const result = await screenOffer({ baseUrl: `${origin}/clean`, apiKey: 'fixture-key', model: 'test-model' }, terms, '1 mUSD', 123)
    expect(result).toEqual({ verdict: 'clean', reasons: ['The requirements are clear'], model: 'test-model', promptVersion: SCREENING_PROMPT_VERSION, at: 123 })
  })

  it('reports unconfigured screening without a model call', async () => {
    expect(await screenOffer(undefined, terms, '1 mUSD', 123)).toMatchObject({ verdict: 'unscreened', reasons: ['screening is not configured'], model: null })
  })
})

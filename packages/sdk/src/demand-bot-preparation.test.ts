import { erc20Abi } from 'viem'
/** Real HTTP streams and private filesystem persistence exercise the hosted response shape. */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeFunctionData } from 'viem'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type DemandOperation, openDemandStore, persistDemandManifest } from '../scripts/demand-bot-store.ts'
import { sidequestHoldingAbi } from './abi/index.ts'
import { hashText } from './actions.ts'
import { context } from './index.ts'
import { templateForSequence } from './demand-bot.ts'
import { DEMAND_MANIFEST_MAX_BYTES, demandCanonicalJson, loadDemandManifest, validateDemandPreparation } from './demand-bot-validation.ts'

describe('hosted demand preparation', () => {
  const ctx = context('monad-testnet', 'main', 'http://127.0.0.1:1')
  const creator = '0x0000000000000000000000000000000000000001'
  const arbitrator = '0x0000000000000000000000000000000000000002'
  const token = ctx.deployment.rewardTokens[0]!
  const template = templateForSequence(0)
  const intent = { creator, arbitrator, token, template, title: template.title, brief: template.brief, deliveryDeadline: 10_000, quoteDeadline: 2800, windows: { reviewSeconds: 3600, disputeSeconds: 3600, arbitrationSeconds: 43200 } } as const
  const requestHash = hashText('request')
  const quote = { quoteId: 'quote', worker: creator, agentId: '1', token, symbol: 'mUSD', amount: '3', quoteHash: hashText('quote') }
  const expiredAt = 65_000
  const manifest = demandCanonicalJson({
    v: 2, taskId: 'task', mode: 'hire', creator, approver: creator,
    deployment: { chainId: 10143, core: ctx.deployment.core, holding: ctx.stack.holding, evaluator: ctx.stack.evaluator, identity: ctx.deployment.identity },
    token, reward: '3000000', creatorBond: '0', workerBond: '0', deliveryDeadline: intent.deliveryDeadline, selectionDeadline: null, arbitrator, windows: intent.windows,
    title: intent.title, brief: intent.brief, acceptanceCriteria: template.acceptanceCriteria, quote: { requestHash, quoteHash: quote.quoteHash }, deliverable: template.deliverable,
    evidencePolicy: null, eligibility: null, projectId: null, policyVersion: null,
  })
  let respond: (response: ServerResponse) => void
  let baseUrl: string
  let path: string
  let requests: number
  const server = createServer((_request, response) => { requests++; respond(response) })

  beforeEach(async () => {
    requests = 0
    respond = response => response.end(manifest)
    path = mkdtempSync(join(tmpdir(), 'sidequest-demand-manifest-'))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(path, { recursive: true })
  })

  function operation(text = manifest): DemandOperation {
    const termsHash = hashText(text)
    return {
      id: 'demand-0', sequence: 0, intent, quote, request: { requestId: 'request', requestHash },
      prepared: {
        taskId: 'task', applicationId: 'application', termsHash, manifestUrl: `${baseUrl}/offers/${termsHash}.json`,
        transactions: [
          { description: 'approve', chainId: 10143, to: token, value: '0', data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ctx.stack.holding, 3_000_000n] }) },
          { description: 'publish', chainId: 10143, to: ctx.stack.holding, value: '0', data: encodeFunctionData({ abi: sidequestHoldingAbi, functionName: 'publish', args: [{ approver: creator, arbitrator, manifestHash: termsHash, policyHash: termsHash, token, reward: 3_000_000n, creatorBond: 0n, workerBond: 0n, deliveryDeadline: intent.deliveryDeadline, expiredAt, reviewWindow: 3600, disputeWindow: 3600, arbitrationWindow: 43200 }] }) },
        ],
      },
    }
  }

  it('fetches a URL-only response and durably saves the exact manifest under the same operation before validation', async () => {
    const store = openDemandStore(path, 'binding', 1)
    const saved = operation()
    store.bot.operations.push(saved)
    store.save()
    expect(() => validateDemandPreparation(ctx, intent, requestHash, quote, saved.prepared!, expiredAt)).toThrow('persisted before validation')
    await persistDemandManifest(saved, store.save, baseUrl)
    const restart = openDemandStore(path, 'binding', 2)
    expect(restart.bot.operations[0]!.prepared!.manifest).toBe(manifest)
    expect(restart.bot.operations[0]!.prepared!.taskId).toBe('task')
    validateDemandPreparation(ctx, intent, requestHash, quote, restart.bot.operations[0]!.prepared!, expiredAt)
    expect(requests).toBe(1)
    expect(store.state.sends).toEqual({})
  })

  it('rejects substituted bytes before persisting them', async () => {
    respond = response => response.end(`${manifest}\n`)
    const store = openDemandStore(path, 'binding', 1)
    const saved = operation()
    store.bot.operations.push(saved)
    store.save()
    await expect(persistDemandManifest(saved, store.save, baseUrl)).rejects.toThrow('manifest hash')
    expect(openDemandStore(path, 'binding', 2).bot.operations[0]!.prepared!.manifest).toBeUndefined()
  })

  it('persists hash-matching bytes but rejects changed intent before any signing', async () => {
    const poison = manifest.replace('"reward":"3000000"', '"reward":"4000000"')
    respond = response => response.end(poison)
    const store = openDemandStore(path, 'binding', 1)
    const saved = operation(poison)
    store.bot.operations.push(saved)
    const prepared = await persistDemandManifest(saved, store.save, baseUrl)
    expect(() => validateDemandPreparation(ctx, intent, requestHash, quote, prepared, expiredAt)).toThrow('manifest mismatch: reward')
    expect(store.state.sends).toEqual({})
  })

  it.each(['declared', 'streamed'])('bounds %s response size', async size => {
    respond = response => {
      if (size === 'declared') response.setHeader('content-length', DEMAND_MANIFEST_MAX_BYTES + 1)
      response.writeHead(200)
      response.end('x'.repeat(DEMAND_MANIFEST_MAX_BYTES + 1))
    }
    await expect(loadDemandManifest(operation().prepared!, baseUrl)).rejects.toThrow('too large')
  })

  it('times out a stalled body as well as a stalled connection', async () => {
    respond = response => { response.writeHead(200); response.write('{') }
    await expect(loadDemandManifest(operation().prepared!, baseUrl, 50)).rejects.toThrow()
  })

  it('refuses a different origin/path/hash and redirects', async () => {
    const prepared = operation().prepared!
    for (const manifestUrl of [`${baseUrl}/other.json`, `${baseUrl}/offers/${hashText('other')}.json`, 'https://example.com/offers/a.json']) {
      await expect(loadDemandManifest({ ...prepared, manifestUrl }, baseUrl)).rejects.toThrow('manifest URL')
    }
    expect(requests).toBe(0)
    respond = response => { response.writeHead(302, { location: '/different' }); response.end() }
    await expect(loadDemandManifest(prepared, baseUrl)).rejects.toThrow()
  })

  it('verifies inline manifests without fetching and refuses an inconsistent manifest hash', async () => {
    const prepared = { ...operation().prepared!, manifest }
    expect(await loadDemandManifest(prepared, baseUrl)).toBe(manifest)
    await expect(loadDemandManifest({ ...prepared, manifestHash: hashText('other') }, baseUrl)).rejects.toThrow('manifest hash')
    expect(requests).toBe(0)
  })
})

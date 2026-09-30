import { DirectoryError, DirectoryService, fromDurableObjectSql } from '@agent-jobs/board'
import { fromD1 } from '@agent-jobs/indexer'
import * as sdk from '@agent-jobs/sdk'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Effect from 'effect/Effect'
import { parseAbi } from 'viem'
import { DirectoryProjectionJournal } from './directory-projection.ts'
import { toJson } from './tools.ts'

export interface DirectoryCall {
  network: sdk.Network
  rpcUrl: string
  audience: string
  agentId: string
  action: 'prepare' | 'submit' | 'read'
  kind?: sdk.DirectoryKind
  payload?: unknown
  expiresAt?: number
  record?: unknown
  signature?: unknown
}

const URI_ABI = parseAbi(['function tokenURI(uint256 agentId) view returns (string)'])

export default class DirectoryObject extends Cloudflare.DurableObject<DirectoryObject>()(
  'DirectoryObject',
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState
    const environment = yield* Cloudflare.Workers.WorkerEnvironment
    return Effect.sync(() => {
      const storage = fromDurableObjectSql(state.storage.sql.raw)
      const journal = new DirectoryProjectionJournal(storage)
      const sql = fromD1(environment.DIRECTORY_DATABASE)
      let queue: Promise<unknown> = Promise.resolve()
      const serialized = <Result>(operation: () => Promise<Result>) => {
        const result = queue.then(operation)
        queue = result.catch(() => undefined)
        return result
      }
      const serviceFor = (request: DirectoryCall) => {
        const config = sdk.deployment(request.network)
        const reads = request.rpcUrl === '' ? undefined : sdk.context(request.network, 'main', request.rpcUrl).publicClient
        return new DirectoryService({
          sql: storage, chainId: config.chainId, identityRegistry: config.identity, audience: request.audience, agentId: request.agentId,
          now: () => Math.floor(Date.now() / 1000),
          readIdentity: async (id) => {
            if (reads === undefined) throw new Error('identity RPC unavailable')
            const [wallet, agentURI] = await Promise.all([
              reads.readContract({ address: config.identity, abi: sdk.identityAbi, functionName: 'getAgentWallet', args: [BigInt(id)] }),
              reads.readContract({ address: config.identity, abi: URI_ABI, functionName: 'tokenURI', args: [BigInt(id)] }),
            ])
            if (agentURI.length > 16384) throw new Error('identity profile reference is too large')
            return { wallet, agentURI }
          },
          verify: async (address, record, signature) => reads === undefined ? false : reads.verifyTypedData({ address, ...sdk.directoryTypedData(record), signature }),
        })
      }
      const flushProjection = async (service: DirectoryService) => {
        try {
          await journal.flush(sql, service.publicView())
          await state.raw.storage.deleteAlarm()
        } catch {
          await state.raw.storage.setAlarm(Date.now() + 60_000)
        }
      }
      return {
        call: (request: DirectoryCall) => Effect.promise(() => serialized(async () => {
          let service: DirectoryService | undefined
          let flush = true
          try {
            if (request.network === 'monad-mainnet' && request.action !== 'read') throw new DirectoryError('forbidden', 'directory writes are testnet-only until production admission is integrated')
            journal.prepare({ network: request.network, audience: request.audience, agentId: request.agentId })
            await state.raw.storage.setAlarm(Date.now() + 60_000)
            service = serviceFor(request)
            const result = request.action === 'read' ? await service.read() : request.action === 'prepare'
              ? await service.prepare(request.kind as sdk.DirectoryKind, request.payload, request.expiresAt)
              : await service.submit(request.record, request.signature)
            if (request.action === 'submit') flush = (result as { projection: sdk.DirectoryAgent | null }).projection !== null
            return toJson({ ok: true, result })
          } catch (error) {
            return toJson({ ok: false, code: error instanceof DirectoryError ? error.code : 'error', message: error instanceof DirectoryError ? error.message : 'directory unavailable' })
          } finally {
            if (service !== undefined && flush) await flushProjection(service)
          }
        })),
        alarm: () => Effect.promise(() => serialized(async () => {
          const scope = journal.scope()
          if (scope !== null) await flushProjection(serviceFor({ ...scope, rpcUrl: '', action: 'read' }))
        })),
      }
    })
  }),
) {}

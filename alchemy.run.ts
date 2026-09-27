import { fileURLToPath } from 'node:url'
import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Effect from 'effect/Effect'
import { Database } from './apps/api/src/database.ts'
import { Manifests } from './apps/api/src/manifests.ts'
import Api from './apps/api/src/worker.ts'
import Indexer from './apps/indexer/src/worker.ts'

/**
 * The whole Cloudflare stack. `alchemy dev` runs it in local workerd; `alchemy deploy --stage
 * staging` provisions it. State is local (`.alchemy/`) unless `ALCHEMY_REMOTE_STATE` is set, which
 * the staging/prod deploy scripts do; dev and the test harness stay credential-less.
 */
export default Alchemy.Stack(
  'AgentJobs',
  {
    providers: Cloudflare.providers(),
    state: process.env.ALCHEMY_REMOTE_STATE ? Cloudflare.state() : Alchemy.localState(),
  },
  Effect.gen(function* () {
    const database = yield* Database
    const manifests = yield* Manifests
    const api = yield* Api
    const indexer = yield* Indexer
    // Explore (spec §6): the SPA's assets, with the board API proxied same-origin through a service binding.
    // The local stack test leaves it out (AGENT_JOBS_WITHOUT_EXPLORE): its Vite child needs a remote session.
    if (process.env.AGENT_JOBS_WITHOUT_EXPLORE === '1') {
      return { apiUrl: api.url, indexerUrl: indexer.url, databaseName: database.databaseName, manifestsBucket: manifests.bucketName }
    }
    const explore = yield* Cloudflare.Website.Vite('Explore', {
      rootDir: fileURLToPath(new URL('./apps/explore/', import.meta.url)),
      main: 'worker.ts',
      env: { API: api },
      assets: {
        notFoundHandling: 'single-page-application',
        runWorkerFirst: ['/api/*', '/data/*', '/offers/*', '/mcp', '/health'],
      },
    })
    return {
      exploreUrl: explore.url,
      apiUrl: api.url,
      indexerUrl: indexer.url,
      databaseName: database.databaseName,
      manifestsBucket: manifests.bucketName,
    }
  }),
)

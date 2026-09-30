import { fileURLToPath } from 'node:url'
import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import { Stage } from 'alchemy/Stage'
import * as Effect from 'effect/Effect'
import { Database } from './apps/api/src/database.ts'
import { Manifests } from './apps/api/src/manifests.ts'
import Api from './apps/api/src/worker.ts'
import Indexer from './apps/indexer/src/worker.ts'
import { assertDeployConfig } from './apps/api/src/deploy-preflight.ts'

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
    const stage = yield* Stage
    yield* Effect.promise(() => assertDeployConfig(stage))
    const database = yield* Database
    const manifests = yield* Manifests
    const api = yield* Api
    const indexer = yield* Indexer
    // Explore (spec §6): the SPA's assets, with the board API proxied same-origin through a service binding.
    // The local stack test leaves it out (AGENT_JOBS_WITHOUT_EXPLORE): its Vite child needs a remote session.
    if (process.env.AGENT_JOBS_WITHOUT_EXPLORE === '1') {
      return { apiUrl: api.url, indexerUrl: indexer.url, databaseName: database.databaseName, manifestsBucket: manifests.bucketName }
    }
    // Hireling: mainnet on the apex, testnet on testnet.hireling.xyz. Until the prod stack exists the testnet stack
    // also holds the apex and answers it with a 301 from the Worker (HIRELING_APEX_REDIRECT=0 releases it for prod;
    // docs/mainnet-runbook.md). The Worker does the redirect because a zone redirect rule needs a token with ruleset
    // rights. workers.dev stays on: older sessions, published manifests and embeds still point there.
    const mainnet = process.env.AGENT_JOBS_NETWORK === 'monad-mainnet'
    const apexRedirect = !mainnet && process.env.HIRELING_APEX_REDIRECT !== '0'
    const explore = yield* Cloudflare.Website.Vite('Explore', {
      rootDir: fileURLToPath(new URL('./apps/explore/', import.meta.url)),
      main: 'worker.ts',
      domain: mainnet ? { name: 'hireling.xyz' } : { name: 'testnet.hireling.xyz', aliases: apexRedirect ? ['hireling.xyz'] : [] },
      env: { API: api, REDIRECT_FROM: apexRedirect ? 'hireling.xyz' : '', REDIRECT_TO: 'https://testnet.hireling.xyz' },
      assets: {
        notFoundHandling: 'single-page-application',
        // every path, so the apex redirect sees `/` too; the Worker hands everything else to ASSETS
        runWorkerFirst: true,
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

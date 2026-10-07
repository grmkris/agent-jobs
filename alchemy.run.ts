import { fileURLToPath } from 'node:url'
import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import { Stage } from 'alchemy/Stage'
import { defaultProviderMode } from 'alchemy/ProviderMode'
import * as Effect from 'effect/Effect'
import { Database } from './apps/api/src/database.ts'
import { Manifests } from './apps/api/src/manifests.ts'
import Api from './apps/api/src/worker.ts'
import Indexer from './apps/indexer/src/worker.ts'
import { assertDeployConfig } from './apps/api/src/deploy-preflight.ts'
import { stateMode } from './scripts/sidequest/state.ts'
import devInfrastructure from './infra/dev.json' with { type: 'json' }

const selectedState = stateMode(process.env)

/**
 * Sidequest's own stack and state namespace. Local workerd uses the local stage;
 * the guarded development release owns dev.sidequest.exchange. Production remains separate.
 */
export default Alchemy.Stack(
  'Sidequest',
  {
    providers: Cloudflare.providers(),
    // Staging recovery is deliberately explicit. A stray remote-state variable must
    // never redirect an update to the duplicate/unknown backend.
    state: selectedState === 'remote'
      ? Cloudflare.state()
      : Alchemy.localState(),
  },
  Effect.gen(function* () {
    const stage = yield* Stage
    const mode = yield* defaultProviderMode
    if (stage === 'staging') throw new Error('The previous staging stack is held for retirement; use deploy:dev')
    if (mode === 'live' && stage !== 'prod' && (stage !== 'dev' || process.env.SIDEQUEST_DEV_RELEASE !== '1' || process.env.SIDEQUEST_STAGE !== 'dev' || process.env.SIDEQUEST_NETWORK !== 'monad-testnet' || selectedState !== 'local' || process.env.SIDEQUEST_WITHOUT_EXPLORE === '1')) throw new Error('Use the guarded Sidequest development release with the complete stack')
    yield* Effect.promise(() => assertDeployConfig(stage))
    const database = yield* Database
    const manifests = yield* Manifests
    const api = yield* Api
    const indexer = yield* Indexer
    // Explore (spec §6): the SPA's assets, with the board API proxied same-origin through a service binding.
    // The local stack test leaves it out (SIDEQUEST_WITHOUT_EXPLORE): its Vite child needs a remote session.
    if (process.env.SIDEQUEST_WITHOUT_EXPLORE === '1') {
      return { apiUrl: api.url, indexerUrl: indexer.url, databaseName: database.databaseName, manifestsBucket: manifests.bucketName }
    }
    // Each stage owns only its canonical hostname. The development stack never claims the apex.
    const mainnet = process.env.SIDEQUEST_NETWORK === 'monad-mainnet'
    const explore = yield* Cloudflare.Website.Vite('Explore', {
      ...(stage === 'dev' ? { name: devInfrastructure.resources.Explore } : {}),
      rootDir: fileURLToPath(new URL('./apps/explore/', import.meta.url)),
      main: 'worker.ts',
      memo: { workspaces: [{ cwd: '../docs' }, { cwd: '../../skill' }, { cwd: '../../packages/sdk' }, { cwd: '../../packages/react' }, { cwd: '../../contracts/config' }, { cwd: '../../infra' }] },
      domain: { name: mainnet ? 'sidequest.exchange' : 'dev.sidequest.exchange' },
      env: { API: api },
      assets: {
        notFoundHandling: 'single-page-application',
        // The Worker proxies the API and adds the page security headers.
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

import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Effect from 'effect/Effect'
import { Database } from './apps/api/src/database.ts'
import { Manifests } from './apps/api/src/manifests.ts'
import Api from './apps/api/src/worker.ts'

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
    return {
      apiUrl: api.url,
      databaseName: database.databaseName,
      manifestsBucket: manifests.bucketName,
    }
  }),
)

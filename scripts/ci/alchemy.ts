/** Private subprocess boundary: only named plan actions and drift status cross stdout. */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import * as Alchemist from 'alchemy/Alchemist'
import * as Plan from 'alchemy/Plan'
import * as EngineDrift from 'alchemy/Drift'
import { makeHttpStateStore } from 'alchemy/State/HttpStateStore'
import { State, type StateService } from 'alchemy/State/State'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'

const [action, stage, adopt] = process.argv.slice(2)
if ((action !== 'plan' && action !== 'drift') || (stage !== 'dev' && stage !== 'prod')) {
  process.exitCode = 2
} else {
  const program = Effect.gen(function* () {
    const credential = JSON.parse(readFileSync(resolve(homedir(), '.alchemy/credentials/default/cloudflare-state-store.json'), 'utf8')) as { url: string; authToken: string }
    const remote = yield* makeHttpStateStore({ ...credential, id: 'cloudflare-http' })
    // Planning must never bootstrap the shared Worker or mutate state, even during adoption.
    const readOnly: StateService = {
      ...remote,
      set: () => Effect.die('state writes are refused during planning'),
      delete: () => Effect.die('state deletes are refused during planning'),
      deleteStack: () => Effect.die('state deletes are refused during planning'),
      setOutput: () => Effect.die('state writes are refused during planning'),
    }
    const session = yield* Alchemist.open({ entrypoint: resolve(import.meta.dirname, '../../alchemy.run.ts'), stage, profile: 'default', envFile: '/dev/null' }, { adopt: adopt === '--adopt-move', updateStateStore: false })
    const context = Context.add(session.context, State, Effect.succeed(readOnly))
    if (session.stack.name !== 'Sidequest' || session.stack.stage !== stage) return yield* Effect.die('unexpected stack identity')
    if (action === 'plan') {
      const plan = yield* Plan.make(session.stack).pipe(Effect.provide(context))
      // A create whose props wait on upstream outputs carries a deferred ownership probe: Apply reads the resource by
      // name first and adopts it when it exists. Report those so the release guard can tell them from real creates.
      const deferredAdoption = Object.entries(plan.resources).flatMap(([fqn, node]) => node !== undefined && 'deferredAdoption' in node && node.deferredAdoption !== undefined ? [fqn] : [])
      return { summary: Alchemist.Stack.summarize(plan), ...Plan.describePlan(plan), deferredAdoption }
    }
    const snapshot = yield* EngineDrift.plan({ name: 'Sidequest', stage }).pipe(Effect.provide(context))
    const drifted = Object.values(snapshot.result.resources).filter((resource) => resource.action !== 'unchanged' && resource.action !== 'skipped')
    return { drifted: drifted.length, summary: Alchemist.Stack.summarize(snapshot.plan) }
  })
  try {
    const result = await Effect.runPromise(program.pipe(Effect.provide(Alchemist.layer()), Effect.scoped))
    // Providers may emit other output; the parent accepts only this structured line.
    console.log(`SIDEQUEST_CI_RESULT=${JSON.stringify(result)}`)
  } catch {
    console.error('Sidequest planning unavailable (provider details withheld)')
    process.exitCode = 1
  }
}

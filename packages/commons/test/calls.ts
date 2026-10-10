import { Effect, Schema } from 'effect'
import { runTool } from '../src/tools.ts'

/** Exercise the public unknown-input boundary and decode the declared output in every integration-style unit test. */
export function invoke<A>(name: string, output: Schema.Codec<A, unknown>, caller: string | undefined, input: unknown) {
  return runTool(name, caller, input).pipe(Effect.map(Schema.decodeUnknownSync(output)))
}

/**
 * The hirers' model calls: one strict-JSON answer from Grok 4.7 through cliproxy, decoded by a schema, and the
 * schemas for a job idea, a quote choice and a review verdict. Bounded by a timeout and one retry.
 */
import { Option, Schema } from 'effect'
import { log } from './activity.ts'

const MODEL = process.env.ACTIVITY_MODEL ?? 'grok-4.7'
const JSON_ONLY =
  'Answer with one strict JSON object and nothing else: double-quoted keys, string values in double quotes, no comments.'
const LLM = `${process.env.CLIPROXY_URL ?? 'http://100.105.51.45:8317/v1'}/chat/completions`

const Completion = Schema.Struct({
  choices: Schema.Array(Schema.Struct({ message: Schema.Struct({ content: Schema.String }) })),
})
/** Grok sometimes answers a list as one string; both forms are accepted and `listOf` splits the string. */
const StringOrList = Schema.Union([Schema.Array(Schema.String), Schema.String])
export const IdeaSchema = Schema.Struct({
  title: Schema.String,
  brief: Schema.String,
  criteria: StringOrList,
  tags: Schema.optional(StringOrList),
})
export const listOf = (value: string | readonly string[] | undefined, separator: RegExp): string[] =>
  [value ?? []]
    .flat()
    .flatMap((part) => part.split(separator))
    .map((part) => part.trim())
    .filter(Boolean)
export const DirectorySchema = Schema.Struct({
  agents: Schema.Array(Schema.Struct({ agentId: Schema.String, profile: Schema.Struct({ name: Schema.String }) })),
})
export const ChoiceSchema = Schema.Struct({ index: Schema.Number, why: Schema.optional(Schema.String) })
export const VerdictSchema = Schema.Struct({
  approve: Schema.Boolean,
  failed: Schema.optional(Schema.NullOr(Schema.String)),
  reason: Schema.String,
})

/** One JSON answer from Grok through cliproxy, decoded by `schema`; a timeout and one retry, else null. */
export async function grok<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  system: string,
  user: string,
): Promise<S['Type'] | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let text = ''
    try {
      const res = await fetch(LLM, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${process.env.CLIPROXY_API_KEY_CREW ?? process.env.CLIPROXY_API_KEY ?? ''}`,
        },
        body: JSON.stringify({
          model: MODEL,
          temperature: 1,
          messages: [
            { role: 'system', content: `${system}\n${JSON_ONLY}` },
            { role: 'user', content: user },
          ],
        }),
        signal: AbortSignal.timeout(120_000),
      })
      text = Schema.decodeUnknownSync(Completion)(await res.json()).choices[0]?.message.content ?? ''
      const start = text.indexOf('{')
      const end = text.lastIndexOf('}')
      const raw: unknown = JSON.parse(text.slice(start, end + 1))
      const answer = Schema.decodeUnknownOption(schema)(raw)
      if (Option.isSome(answer)) return answer.value
      log('grok', 'unexpected', { text: text.slice(0, 1500) })
    } catch (error) {
      log('grok', 'error', { message: String(error).slice(0, 200), text: text.slice(0, 300) })
    }
  }
  return null
}

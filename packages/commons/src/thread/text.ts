import { Effect, Schema } from 'effect'
import { Invalid } from '../errors.ts'
import { Body } from '../schema/messages.ts'

export const normalizeText = (raw: unknown) =>
  Schema.decodeUnknownEffect(Body)(raw).pipe(
    Effect.mapError(() => new Invalid({ message: 'Body must have 1..2000 code points after normalization' })),
  )
export function mentionTokens(body: string): string[] {
  const tokens = [...body.matchAll(/@(?:0x[0-9a-fA-F]{40}|[\p{L}\p{N}_-]+)/gu)].map((match) => match[0].slice(1))
  return [...new Map(tokens.map((token) => [token.toLowerCase(), token])).values()]
}

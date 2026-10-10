import { Data, Match } from 'effect'

export class Unauthenticated extends Data.TaggedError('Unauthenticated')<{ message: string }> {}
export class Forbidden extends Data.TaggedError('Forbidden')<{ message: string }> {}
export class NotFound extends Data.TaggedError('NotFound')<{ message: string }> {}
export class Invalid extends Data.TaggedError('Invalid')<{ message: string }> {}
export class Conflict extends Data.TaggedError('Conflict')<{ message: string }> {}
export class Unavailable extends Data.TaggedError('Unavailable')<{ message: string }> {}
export class Disabled extends Data.TaggedError('Disabled')<{ message: string }> {}
export class RateLimited extends Data.TaggedError('RateLimited')<{ retryAfter: number }> {
  override get message() {
    return `retry in ${this.retryAfter}s`
  }
}
export class StakeRequired extends Data.TaggedError('StakeRequired')<{
  minimum: string
  stake: string
  backing: string
}> {
  override get message() {
    return `Requires ${this.minimum} active stake or backing`
  }
}
export type CommonsError =
  | Unauthenticated
  | Forbidden
  | NotFound
  | Invalid
  | Conflict
  | RateLimited
  | StakeRequired
  | Unavailable
  | Disabled
export type ErrorCode = 'unauthenticated' | 'forbidden' | 'not-found' | 'invalid' | 'conflict' | 'unavailable'
export function errorCode(e: CommonsError): ErrorCode {
  return Match.value(e).pipe(
    Match.tagsExhaustive({
      Unauthenticated: (): ErrorCode => 'unauthenticated',
      Forbidden: (): ErrorCode => 'forbidden',
      StakeRequired: (): ErrorCode => 'forbidden',
      NotFound: (): ErrorCode => 'not-found',
      Invalid: (): ErrorCode => 'invalid',
      Conflict: (): ErrorCode => 'conflict',
      RateLimited: (): ErrorCode => 'conflict',
      Unavailable: (): ErrorCode => 'unavailable',
      Disabled: (): ErrorCode => 'unavailable',
    }),
  )
}

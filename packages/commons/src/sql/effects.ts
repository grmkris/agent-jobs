import { Effect } from 'effect'
import { Conflict, Forbidden, Invalid, NotFound, RateLimited, Unavailable } from '../errors.ts'

/** Domain rejections from synchronous transactions retain their typed error channel. */
export const sqlEffect = <A>(f: () => A) =>
  Effect.try({
    try: f,
    catch: (e) => {
      if (
        e instanceof Conflict ||
        e instanceof Invalid ||
        e instanceof NotFound ||
        e instanceof Forbidden ||
        e instanceof RateLimited
      )
        return e
      return new Unavailable({ message: 'Commons persistence unavailable' })
    },
  })

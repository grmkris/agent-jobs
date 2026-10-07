/** Public HTTP responses use the same lossless integer encoding as board RPC replies. */
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { toJson } from './tools.ts'

export function jsonResponse(body: unknown, options?: Parameters<typeof HttpServerResponse.jsonUnsafe>[1]) {
  return HttpServerResponse.jsonUnsafe(JSON.parse(toJson(body)), options)
}

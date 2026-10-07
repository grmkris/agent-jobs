/** Public frozen manifests are content addressed; successful reads are immutable across every board. */
import * as HttpServerResponse from 'effect/http/HttpServerResponse'

export function offerResponse(body: string | null) {
  if (body === null)
    return HttpServerResponse.text('not found', { status: 404, headers: { 'access-control-allow-origin': '*' } })
  return HttpServerResponse.text(body, {
    contentType: 'application/json',
    headers: {
      'cache-control': 'public, max-age=31536000, immutable',
      'access-control-allow-origin': '*',
    },
  })
}

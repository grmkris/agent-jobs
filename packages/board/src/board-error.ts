/** A board refusal with a stable code; the API maps the code to an HTTP status and MCP clients branch on it. */
export class BoardError extends Error {
  constructor(
    readonly code: 'unauthenticated' | 'forbidden' | 'not-found' | 'invalid' | 'conflict' | 'chain' | 'unavailable',
    message: string,
  ) {
    super(message)
  }
}

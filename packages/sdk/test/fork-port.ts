import { createServer } from 'node:net'

/** Fork suites from different checkouts must not share a saved rehearsal's fixed port. */
export function localTestPort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('No local test port'))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}

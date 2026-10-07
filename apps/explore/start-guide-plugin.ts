import { readFileSync } from 'node:fs'
import type { Plugin } from 'vite'
import { renderStartGuide, startGuideType } from './start-guide.ts'

const source = () => readFileSync(new URL('../../skill/start.md', import.meta.url), 'utf8')

/** Emit the start guide; render its URLs at the serving origin. */
export function startGuide(): Plugin {
  return {
    name: 'sidequest-start-guide',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? '').split('?')[0] ?? ''
        const type = startGuideType(pathname)
        if (type === undefined) return next()
        const scheme = 'encrypted' in req.socket && req.socket.encrypted ? 'https' : 'http'
        const origin = `${scheme}://${req.headers.host ?? 'localhost'}`
        res.setHeader('Content-Type', type)
        res.end(req.method === 'HEAD' ? undefined : renderStartGuide(source(), origin))
      })
    },
    generateBundle() {
      const template = source()
      for (const fileName of ['start.md']) {
        this.emitFile({ type: 'asset', fileName, source: template })
      }
    },
  }
}

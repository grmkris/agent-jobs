import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { docsOutputFiles, assertDocsCollisions, docsSite } from './docs-site-plugin.ts'
const roots: string[] = []
const fixture = (files: string[]) => {
  const root = mkdtempSync(join(tmpdir(), 'sidequest-docs-test-'))
  roots.push(root)
  for (const file of files) {
    mkdirSync(join(root, file, '..'), { recursive: true })
    writeFileSync(join(root, file), 'fixture')
  }
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
describe('docs site build plugin', () => {
  it('only collects docs output, LLM files, and static server-function cache', () => {
    const expected = [
      'docs.html',
      'docs/quickstart.html',
      'docs/quickstart.md',
      'docs/_assets/app.js',
      'llms.txt',
      'llms-full.txt',
      '__tsr/staticServerFnCache/a.json',
    ].toSorted()
    const root = fixture([...expected, 'index.html', 'assets/app.js', 'server/index.js', '_shell.html', 'robots.txt'])
    expect(docsOutputFiles(root)).toEqual(expected)
  })
  it('fails when output is missing', () =>
    expect(() => docsOutputFiles('/missing-sidequest-docs-output')).toThrow('Missing docs output'))
  it('fails on both bundle and public file collisions', () => {
    expect(() => assertDocsCollisions(['docs.html'], { 'docs.html': {} }, false)).toThrow('collides')
    const root = fixture(['docs/index.md'])
    expect(() => assertDocsCollisions(['docs/index.md'], {}, root)).toThrow('collides')
    expect(() => assertDocsCollisions(['docs.html'], {}, root)).not.toThrow()
  })
  it('does not build or emit docs in the SSR environment', async () => {
    const plugin = docsSite()
    const context = {
      environment: { name: 'ssr' },
      emitFile: () => {
        throw new Error('SSR must not emit docs')
      },
    }
    const call = async (hook: unknown, args: unknown[]) => {
      const handler = typeof hook === 'function' ? hook : (hook as { handler: Function }).handler
      await Reflect.apply(handler, context, args)
    }
    await call(plugin.buildStart, [{}])
    await call(plugin.generateBundle, [{}, {}, false])
  })
})

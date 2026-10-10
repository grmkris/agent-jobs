import { expect, it } from 'vitest'

// Every source file's text, by its path from src/ (tests left out).
const sources = Object.entries(
  import.meta.glob<string>(['./**/*.ts', './**/*.tsx', '!./**/*.test.ts', '!./**/*.test.tsx'], {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
).map(([path, text]) => ({ file: path.replace(/^\.\//, ''), text }))

it('keeps three out of every page’s first bundle: only the model scene imports it, and only by import()', () => {
  const importers = sources.filter((s) => /from 'three(\/[^']*)?'/.test(s.text)).map((s) => s.file)
  expect(importers).toEqual(['components/delivery/model-scene.ts'])
  const scene = sources.filter((s) => s.text.includes('model-scene')).map((s) => s.file)
  expect(scene).toEqual(['components/delivery/ModelView.tsx'])
  const view = sources.find((s) => s.file === 'components/delivery/ModelView.tsx')?.text ?? ''
  expect(view).toContain("import('./model-scene.ts')")
  expect(view).not.toMatch(/^import .*model-scene/m)
})

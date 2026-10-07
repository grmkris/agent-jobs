import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
it('matches Explore background and foreground in both themes', () => {
  const docs = readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8')
  const explore = readFileSync(new URL('../../explore/src/styles.css', import.meta.url), 'utf8')
  for (const token of ['background', 'foreground']) {
    const matches = [...explore.matchAll(new RegExp(`--${token}: ([^;]+);`, 'g'))].slice(0, 2).map(match => match[1])
    expect([...docs.matchAll(new RegExp(`--color-fd-${token}: ([^;]+);`, 'g'))].slice(0, 2).map(match => match[1])).toEqual(matches)
  }
})

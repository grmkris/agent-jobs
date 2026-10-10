import { describe, expect, it } from 'vitest'
import {
  checkState,
  deliveryHref,
  deliveryTime,
  deliveryWhere,
  gitTree,
  hostOf,
  httpUrl,
  repoName,
} from './delivery.ts'

const sha = 'a'.repeat(40)
const tx = `0x${'b'.repeat(64)}`

describe('where a delivery opens', () => {
  it('opens ipfs through a public gateway and leaves web links as given', () => {
    expect(httpUrl('ipfs://bafy123/report.pdf')).toBe('https://ipfs.io/ipfs/bafy123/report.pdf')
    expect(httpUrl('https://site.example/')).toBe('https://site.example/')
  })

  it('opens a commit on the hosts that browse trees, any other git URL as given', () => {
    expect(gitTree('https://github.com/o/r.git', sha)).toBe(`https://github.com/o/r/tree/${sha}`)
    expect(gitTree('https://git.example/o/r', sha)).toBe('https://git.example/o/r')
    expect(repoName('https://github.com/o/r.git')).toBe('o/r')
    expect(hostOf('https://www.ember-oak.example/menu')).toBe('ember-oak.example')
  })

  it('opens web links only, never another scheme', () => {
    expect(deliveryHref({ kind: 'url', url: 'https://site.example/' })).toBe('https://site.example/')
    expect(deliveryHref({ kind: 'url', url: 'javascript:alert(1)' })).toBeNull()
    expect(deliveryHref({ kind: 'git', url: 'git@github.com:o/r.git', ref: 'main', sha })).toBeNull()
    expect(
      deliveryHref({
        kind: 'artifact',
        url: 'ipfs://bafy/a.glb',
        sha256: 'c'.repeat(64),
        mediaType: 'model/gltf-binary',
        name: 'a.glb',
      }),
    ).toBe('https://ipfs.io/ipfs/bafy/a.glb')
    expect(deliveryHref({ kind: 'onchain', chainId: 10143, txHash: tx })).toContain(tx)
  })
})

describe('the delivery in a few words', () => {
  it('names each kind by what identifies it', () => {
    expect(deliveryWhere({ kind: 'url', url: 'https://sq-ember-oak.example.workers.dev/' })).toBe(
      'sq-ember-oak.example.workers.dev',
    )
    expect(deliveryWhere({ kind: 'git', url: 'https://github.com/o/r', ref: 'main', sha })).toBe('o/r @ aaaaaaa')
    expect(deliveryWhere({ kind: 'patch', url: 'https://p.example/x.patch', sha256: 'c'.repeat(64), base: sha })).toBe(
      'patch on aaaaaaa',
    )
    expect(
      deliveryWhere({
        kind: 'artifact',
        url: 'https://f.example/a.zip',
        sha256: 'c'.repeat(64),
        mediaType: 'application/zip',
        name: 'icons.zip',
      }),
    ).toBe('icons.zip')
    expect(deliveryWhere({ kind: 'onchain', chainId: 10143, txHash: tx })).toBe('tx 0xbbbbbbbb…')
    expect(deliveryWhere({ kind: 'onchain', chainId: 10143, address: `0x${'d'.repeat(40)}` })).toBe(
      'contract 0xdddddddd…',
    )
  })
})

describe('how the work went', () => {
  it('times the work from the hire to the latest delivery', () => {
    const steps = [
      { step: 'posted', at: 100 },
      { step: 'hired', at: 160 },
      { step: 'delivered', at: 400 },
      { step: 'rejected', at: 500 },
      { step: 'delivered', at: 9000 },
    ]
    expect(deliveryTime(steps)).toBe(8840)
    expect(deliveryTime(steps.slice(0, 2))).toBeNull()
    expect(deliveryTime([{ step: 'delivered', at: 5 }])).toBeNull()
  })

  it("says the board's check in one word", () => {
    expect(checkState(null)).toBeNull()
    expect(checkState({ ok: true, detail: 'HTTP 200', checkedAt: 1 })).toBe('ok')
    expect(checkState({ ok: false, detail: 'HTTP 404', checkedAt: 1 })).toBe('failed')
    expect(checkState({ ok: null, detail: 'unverified host', checkedAt: 1 })).toBe('unchecked')
  })
})

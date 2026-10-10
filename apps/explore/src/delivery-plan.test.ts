import { describe, expect, it } from 'vitest'
import type { Deliverable } from './api.ts'
import type { DeliverablePreview } from './delivery-preview.ts'
import { modelFormat, previewPlan, thumbOf } from './delivery-plan.ts'

const NONE: DeliverablePreview = { source: null, type: null, title: null, summary: null, poster: null, media: null }
const site: Deliverable = { kind: 'url', url: 'https://sq-site.example.workers.dev' }
const artifact = (mediaType: string, name: string, url = `https://files.example/${name}`): Deliverable => ({
  kind: 'artifact',
  url,
  sha256: 'a'.repeat(64),
  mediaType,
  name,
})
const plan = (
  deliverable: Deliverable | null,
  preview: DeliverablePreview | null = NONE,
  jobId = '99',
  stage = 'dev',
) => previewPlan({ jobId, stage, deliverable, preview })

describe('previewPlan', () => {
  it("shows a curated job's vendored image on its own stage only", () => {
    expect(plan(site, NONE, '11', 'dev')).toMatchObject({ from: 'showcase', item: { kind: 'video' } })
    expect(plan(site, NONE, '11', 'prod').from).toBe('glyph')
  })

  it("prefers the site's own https poster, and notes a model it can turn", () => {
    const poster = {
      ...NONE,
      source: 'manifest' as const,
      type: 'code' as const,
      poster: 'https://s.example/preview.webp',
      media: 'https://s.example/model.stl',
    }
    expect(plan(site, poster)).toEqual({
      from: 'poster',
      src: 'https://s.example/preview.webp',
      type: 'code',
      href: 'https://sq-site.example.workers.dev',
      model: { src: 'https://s.example/model.stl', format: 'stl', name: 'model.stl' },
    })
    expect(plan(site, { ...poster, poster: 'http://s.example/p.png' }).from).toBe('glyph')
  })

  it('shows an image file as itself, ipfs through the gateway, and a model to turn', () => {
    expect(plan(artifact('image/png', 'sheet.png', 'ipfs://bafyimage/sheet.png'))).toMatchObject({
      from: 'image',
      src: 'https://ipfs.io/ipfs/bafyimage/sheet.png',
    })
    expect(plan(artifact('model/gltf-binary', 'duck.glb'))).toMatchObject({
      from: 'model',
      model: { format: 'gltf', name: 'duck.glb' },
    })
    expect(plan(artifact('application/octet-stream', 'part.stl'))).toMatchObject({
      from: 'model',
      model: { format: 'stl' },
    })
  })

  it('falls back to a glyph for its kind, marking audio and video', () => {
    expect(plan(artifact('video/mp4', 'cut.mp4'))).toMatchObject({ from: 'glyph', kind: 'artifact', media: 'video' })
    expect(plan(site, { ...NONE, source: 'manifest', type: 'audio' })).toMatchObject({ from: 'glyph', media: 'audio' })
    expect(plan({ kind: 'git', url: 'https://github.com/o/r', ref: 'main', sha: 'b'.repeat(40) })).toMatchObject({
      from: 'glyph',
      kind: 'git',
      href: `https://github.com/o/r/tree/${'b'.repeat(40)}`,
    })
    expect(plan(null, null)).toEqual({ from: 'glyph', kind: null, media: null, href: null })
  })
})

describe('modelFormat', () => {
  it('knows glTF and STL by media type, file name or URL path', () => {
    expect(modelFormat('x', 'model/gltf+json')).toBe('gltf')
    expect(modelFormat('x', 'model/stl; charset=binary')).toBe('stl')
    expect(modelFormat('https://s.example/a/b/Scene.GLTF?v=2')).toBe('gltf')
    expect(modelFormat('report.pdf', 'application/pdf')).toBeNull()
  })
})

describe('thumbOf', () => {
  it('has a picture for curated, poster and image plans, marking media; none for models and glyphs', () => {
    expect(thumbOf(plan(site, NONE, '11'))).toMatchObject({ media: true })
    expect(thumbOf(plan(site, NONE, '10'))).toMatchObject({ showcase: { kind: 'icons' }, media: false })
    expect(thumbOf(plan(artifact('image/webp', 'a.webp')))).toEqual({
      src: 'https://files.example/a.webp',
      media: false,
    })
    expect(thumbOf(plan(artifact('model/stl', 'a.stl')))).toBeNull()
    expect(thumbOf(plan(site))).toBeNull()
  })
})

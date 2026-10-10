/**
 * Vendors the landing showcase's images from what each job delivered (`src/components/landing/showcase-data.ts`):
 * the poster a delivered page publishes, a capture of the page, or an icon pack's own PNGs. The page's CSP keeps
 * images on this origin, so they are committed beside the cards and fingerprinted by Vite. Run by hand after a
 * showcase job changes: `bun apps/explore/scripts/showcase.ts [chromium-executable]` (without a path Playwright's own
 * Chromium is used). Chromium also re-encodes everything to WebP, so no image library is needed.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type Page, chromium } from 'playwright-core'
import { SHOWCASE, type ShowcaseItem } from '../src/components/landing/showcase-data.ts'

const out = (file: string) => fileURLToPath(new URL(`../src/components/landing/showcase/${file}`, import.meta.url))

/** The encoded size of each image: twice the largest card it fills, cropped from the top to the frame's shape. */
const SIZE: Record<'browser' | 'paper' | 'player' | 'cover', [number, number]> = {
  browser: [800, 450],
  paper: [780, 520],
  player: [800, 450],
  cover: [480, 480],
}
const frame = (item: ShowcaseItem): keyof typeof SIZE => {
  if (item.kind === 'podcast') return 'cover'
  if (item.kind === 'video' || item.kind === 'documentary') return 'player'
  return item.kind === 'site' || item.kind === 'dashboard' ? 'browser' : 'paper'
}

async function fetchBytes(url: string): Promise<Buffer> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

/** `bytes` as a WebP of exactly `width` × `height`, scaled to cover and cropped from the top. */
async function webp(page: Page, bytes: Buffer, type: string, [width, height]: [number, number]): Promise<Buffer> {
  const encoded = await page.evaluate(
    async ([src, w, h]) => {
      const image = new Image()
      image.src = src
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const context = canvas.getContext('2d')
      if (context === null) throw new Error('no 2d canvas')
      context.imageSmoothingQuality = 'high'
      const scale = Math.max(w / image.naturalWidth, h / image.naturalHeight)
      const sw = w / scale
      context.drawImage(image, (image.naturalWidth - sw) / 2, 0, sw, h / scale, 0, 0, w, h)
      return canvas.toDataURL('image/webp', 0.82)
    },
    [`data:${type};base64,${bytes.toString('base64')}`, width, height] as const,
  )
  return Buffer.from(encoded.slice(encoded.indexOf(',') + 1), 'base64')
}

/** The pack's 32 px icons, in the order its page lists them. */
async function icons(site: string): Promise<string[]> {
  const html = (await fetchBytes(site)).toString('utf8')
  const names = [...html.matchAll(/icons\/32\/([a-z0-9-]+)\.png/g)].map((match) => match[1] ?? '')
  const unique = [...new Set(names)]
  mkdirSync(out('icons'), { recursive: true })
  for (const name of unique) writeFileSync(out(`icons/${name}.png`), await fetchBytes(`${site}/icons/32/${name}.png`))
  return unique
}

mkdirSync(out(''), { recursive: true })
// A path argument, not an environment variable: Explore's build pins every env read under apps/explore (B12-003).
const browser = await chromium.launch({
  headless: true,
  ...(process.argv[2] === undefined ? {} : { executablePath: process.argv[2] }),
})
const encoder = await browser.newPage()
for (const item of SHOWCASE) {
  const { url } = item.delivered
  const { image } = item
  if (image.from === 'icons') {
    console.log(`${item.kind}: ${(await icons(url)).length} icons`)
    continue
  }
  let bytes: Buffer
  let type = 'image/png'
  if (image.from === 'poster') {
    bytes = await fetchBytes(`${url}/preview.webp`)
    type = 'image/webp'
  } else {
    const page = await browser.newPage({ viewport: { width: image.width, height: image.height }, deviceScaleFactor: 1 })
    await page.goto(`${url}${image.path}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(image.wait ?? 1000)
    bytes = await page.screenshot()
    await page.close()
  }
  const encoded = await webp(encoder, bytes, type, SIZE[frame(item)])
  writeFileSync(out(`${item.kind}.webp`), encoded)
  console.log(`${item.kind}: ${encoded.length} bytes`)
}
await browser.close()

/**
 * Renders the app icons from the Sidequest brand mark on evergreen ink with the headless
 * Chromium that playwright-core already brings, so no image library is needed. Run by hand after changing the mark;
 * the PNGs are committed (`bun apps/explore/scripts/icons.ts [chromium-executable]`; without a path Playwright's own
 * Chromium is used). Icons are opaque and full-bleed: iOS applies its own
 * mask, and a transparent icon would sit on black.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

/** --primary, oklch(0.34 0.06 165), in sRGB. */
const INK = '#124230'
const out = (p: string) => fileURLToPath(new URL(`../public/${p}`, import.meta.url))
const mark = readFileSync(new URL('../src/brand/mark.svg', import.meta.url), 'utf8')
const glyph = mark.match(/<path\b[^>]*\/>/)?.[0]
if (glyph === undefined) throw new Error('Brand mark has no path')
writeFileSync(out('favicon.svg'), mark)

/** The glyph at `scale` of the canvas (the maskable icon keeps it inside Android's 80% safe circle). */
const icon = (size: number, scale: number) => {
  const g = size * scale
  const o = (size - g) / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${INK}"/>
  <g transform="translate(${o} ${o}) scale(${g / 32})">${glyph}</g>
</svg>`
}

const targets: Array<[string, number, number]> = [
  ['apple-touch-icon.png', 180, 1],
  ['icons/icon-192.png', 192, 1],
  ['icons/icon-512.png', 512, 1],
  ['icons/icon-1024.png', 1024, 1],
  ['icons/icon-maskable-512.png', 512, 0.8],
]

mkdirSync(out('icons'), { recursive: true })
// A path argument, not an environment variable: Explore's build pins every env read under apps/explore (B12-003).
const browser = await chromium.launch({
  headless: true,
  ...(process.argv[2] === undefined ? {} : { executablePath: process.argv[2] }),
})
for (const [file, size, scale] of targets) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 })
  await page.setContent(`<html><body style="margin:0">${icon(size, scale)}</body></html>`)
  await page.screenshot({ path: out(file), clip: { x: 0, y: 0, width: size, height: size }, omitBackground: false })
  await page.close()
  console.log(file)
}
await browser.close()

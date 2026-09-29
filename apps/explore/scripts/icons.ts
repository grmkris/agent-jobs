/**
 * Renders the app icons from the one brand mark (src/brand/mark.svg's "H" on the Indigo tint) with the headless
 * Chromium that playwright-core already brings, so no image library is needed. Run by hand after changing the mark;
 * the PNGs are committed (`bun apps/explore/scripts/icons.ts`). Icons are opaque and full-bleed: iOS applies its own
 * mask, and a transparent icon would sit on black.
 */
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const TINT = '#5452d4'
const out = (p: string) => fileURLToPath(new URL(`../public/${p}`, import.meta.url))

/** The glyph at `scale` of the canvas (the maskable icon keeps it inside Android's 80% safe circle). */
const icon = (size: number, scale: number) => {
  const g = size * scale
  const o = (size - g) / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${TINT}"/>
  <g transform="translate(${o} ${o}) scale(${g / 32})"><path d="M10 8v16M22 8v16M10 16h12" stroke="#fff" stroke-width="3.5" stroke-linecap="round" fill="none"/></g>
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
const browser = await chromium.launch({ headless: true })
for (const [file, size, scale] of targets) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 })
  await page.setContent(`<html><body style="margin:0">${icon(size, scale)}</body></html>`)
  await page.screenshot({ path: out(file), clip: { x: 0, y: 0, width: size, height: size }, omitBackground: false })
  await page.close()
  console.log(file)
}
await browser.close()

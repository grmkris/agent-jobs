/**
 * The showcase's images, vendored from each job's delivery by `scripts/showcase.ts`: imported, so Vite fingerprints
 * them and the 32 px icons are inlined.
 */
import dashboard from './showcase/dashboard.webp'
import documentary from './showcase/documentary.webp'
import memo from './showcase/memo.webp'
import onchain from './showcase/onchain.webp'
import podcast from './showcase/podcast.webp'
import site from './showcase/site.webp'
import translation from './showcase/translation.webp'
import video from './showcase/video.webp'
import type { ShowcaseKind } from './showcase-data.ts'

export const SHOWCASE_SHOT: Readonly<Record<Exclude<ShowcaseKind, 'icons'>, string>> = {
  dashboard,
  documentary,
  memo,
  onchain,
  podcast,
  site,
  translation,
  video,
}

/** The icon pack's PNGs, by file name. */
export const ICON_PACK: readonly string[] = Object.values(
  import.meta.glob<string>('./showcase/icons/*.png', { eager: true, import: 'default' }),
)

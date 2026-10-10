/**
 * The showcase's images, vendored from each job's delivery by `scripts/showcase.ts`, one file per job
 * (`showcase/<jobId>.webp`): imported, so Vite fingerprints them and the 32 px icons are inlined.
 */
const SHOTS = import.meta.glob<string>('./showcase/*.webp', { eager: true, import: 'default' })

/** A showcase job's vendored image; undefined for the icon pack, which is drawn from its own PNGs. */
export const showcaseShot = (jobId: string): string | undefined => SHOTS[`./showcase/${jobId}.webp`]

/** The icon pack's PNGs, by file name. */
export const ICON_PACK: readonly string[] = Object.values(
  import.meta.glob<string>('./showcase/icons/*.png', { eager: true, import: 'default' }),
)

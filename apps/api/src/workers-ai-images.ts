/**
 * Avatars from Workers AI: FLUX.1 schnell answers a prompt with one base64 JPEG (1024 px, about 300 KB) in a few
 * steps; the Images binding then makes it a 256 px WebP, the size an orb ever shows, at a tenth of the weight.
 */
import { BoardError } from '@sidequest/board'
import { Schema } from 'effect'
import type { ImageModel } from './avatars.ts'

const MODEL = '@cf/black-forest-labs/flux-1-schnell'
const FluxOutput = Schema.Struct({ image: Schema.String })

/** The Worker's `AI` binding, as far as image generation uses it; its answer is parsed below, not trusted. */
export interface WorkersAi {
  run(model: string, inputs: { prompt: string; steps: number }): Promise<object>
}

/** The Worker's `IMAGES` binding, as far as resizing an avatar uses it. */
export interface ImagesResizer {
  input(stream: ReadableStream<Uint8Array>): {
    transform(transform: { width: number; height: number; fit: 'cover' }): {
      output(options: { format: 'image/webp'; quality: number }): Promise<{ response(): Response }>
    }
  }
}

export function workersAiImages(ai: WorkersAi, images?: ImagesResizer): ImageModel {
  return {
    generate: async (prompt) => {
      // The model's refusal (capacity, a daily limit) reaches the caller in its own words, not as an internal failure.
      const answer = await ai.run(MODEL, { prompt, steps: 6 }).catch((failure: unknown) => {
        throw new BoardError('unavailable', `The image model refused: ${String(failure).slice(0, 200)}`)
      })
      const { image } = Schema.decodeUnknownSync(FluxOutput)(answer)
      const jpeg = Uint8Array.from(atob(image), (char) => char.charCodeAt(0))
      if (images === undefined) return { bytes: jpeg, type: 'image/jpeg' }
      // Resizing only saves weight: when the Images binding refuses, the full drawing is still a good avatar.
      try {
        const resized = await images
          .input(new Blob([jpeg]).stream())
          .transform({ width: 256, height: 256, fit: 'cover' })
          .output({ format: 'image/webp', quality: 85 })
        return { bytes: new Uint8Array(await resized.response().arrayBuffer()), type: 'image/webp' }
      } catch (failure) {
        console.warn(JSON.stringify({ event: 'avatar-resize-failed', message: String(failure).slice(0, 300) }))
        return { bytes: jpeg, type: 'image/jpeg' }
      }
    },
  }
}

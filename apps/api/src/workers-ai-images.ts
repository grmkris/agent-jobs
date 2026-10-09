/** Avatars from Workers AI: FLUX.1 schnell answers a prompt with one base64 JPEG in a few steps. */
import { Schema } from 'effect'
import type { ImageModel } from './avatars.ts'

const MODEL = '@cf/black-forest-labs/flux-1-schnell'
const FluxOutput = Schema.Struct({ image: Schema.String })

/** The Worker's `AI` binding, as far as image generation uses it; its answer is parsed below, not trusted. */
export interface WorkersAi {
  run(model: string, inputs: { prompt: string; steps: number }): Promise<object>
}

export function workersAiImages(ai: WorkersAi): ImageModel {
  return {
    generate: async (prompt) => {
      const { image } = Schema.decodeUnknownSync(FluxOutput)(await ai.run(MODEL, { prompt, steps: 6 }))
      return { bytes: Uint8Array.from(atob(image), (char) => char.charCodeAt(0)), type: 'image/jpeg' }
    },
  }
}

/** An owner's edits to their hosted agent's profile: text fields, a generated avatar, an uploaded one. */
import { agentAction } from './agent-api.ts'
import { ApiError, boardPrefix, session } from './api.ts'

export interface ProfileFields {
  name: string
  tagline: string
  description: string
}

/** What every profile write answers with: the agent's public profile as `/data/profiles` serves it. */
export interface SavedProfile extends ProfileFields {
  agentId: string | null
  image: string | null
}

export const saveProfile = (managedId: string, fields: Partial<ProfileFields>) =>
  agentAction<SavedProfile>(managedId, 'profile', { ...fields })

export const generateAvatar = (managedId: string, prompt: string) =>
  agentAction<SavedProfile>(managedId, 'avatar/generate', { prompt })

export const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const MAX_AVATAR_BYTES = 1024 * 1024

/** A picture from the owner's device, sent as its own bytes (the API caps it at 1 MiB and checks what it really is). */
export async function uploadAvatar(managedId: string, file: File): Promise<SavedProfile> {
  if (!AVATAR_TYPES.includes(file.type)) throw new ApiError('invalid', 'Choose a PNG, JPEG or WebP picture')
  if (file.size > MAX_AVATAR_BYTES) throw new ApiError('invalid', 'Choose a picture of at most 1 MB')
  const token = session()
  const response = await fetch(`${boardPrefix()}/api/agents/${encodeURIComponent(managedId)}/avatar`, {
    method: 'POST',
    headers: {
      'content-type': file.type,
      // A retry of the same upload is the same operation.
      'idempotency-key': `avatar-${managedId}-${file.size}-${file.lastModified}`,
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: file,
  })
  const body: { ok?: boolean; result?: SavedProfile; code?: string; message?: string } = await response.json()
  if (!response.ok || body.ok === false || body.result === undefined)
    throw new ApiError(body.code ?? 'error', body.message ?? 'The picture could not be saved')
  return body.result
}

/** Where a hosted agent's ERC-8004 registration file lives; publishing points the agent's `agentURI` here once. */
export const hostedRegistrationUrl = (origin: string, managedId: string) =>
  `${origin}/profiles/${encodeURIComponent(managedId)}.json`

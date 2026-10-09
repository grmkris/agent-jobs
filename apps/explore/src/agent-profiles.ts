/** Agents' public profiles (`/data/profiles`): name, description, tagline and a same-origin avatar. */
import { useQuery } from '@tanstack/react-query'
import { data } from './api.ts'

interface AgentProfile {
  agentId: string
  name: string
  description: string
  tagline: string
  /** An absolute URL on this origin (`/avatars/<sha>.png`), or null before the agent has an avatar. */
  image: string | null
}

/** Every profile in one cached read: avatars appear wherever agents do, so each orb must not fetch its own. */
export const useAgentProfiles = () =>
  useQuery({
    queryKey: ['data-profiles'],
    queryFn: () => data<{ profiles: AgentProfile[] }>('profiles'),
    staleTime: 60_000,
    refetchInterval: 120_000,
    retry: false,
  })

/** Only same-origin images: the page's CSP loads no others, and a profile is data its agent wrote. */
export function avatarOf(
  profiles: readonly AgentProfile[] | undefined,
  agentId: string,
  origin: string,
): string | null {
  const image = profiles?.find((profile) => profile.agentId === agentId)?.image ?? null
  if (image === null) return null
  try {
    return new URL(image, origin).origin === origin ? image : null
  } catch {
    return null
  }
}

export function useAgentAvatar(agentId: string): string | null {
  const profiles = useAgentProfiles()
  return avatarOf(profiles.data?.profiles, agentId, window.location.origin)
}

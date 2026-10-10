import type { DirectoryAgent } from '@sidequest/sdk'
import { agentListings } from '../services.ts'
import { Section } from './kit.tsx'
import { AgentServiceTiles } from './services/ServiceTile.tsx'
import { useNow } from './Time.tsx'

/**
 * What an agent offers, on its page: its live service listings as small tiles, each opening its card. Nothing shows
 * when it lists none; its record above already says what it has done.
 */
export function AgentServices({ agent, delivered }: { agent: DirectoryAgent; delivered: number }) {
  const now = useNow()
  const listings = agentListings(agent, now, delivered)
  if (listings.length === 0) return null
  return (
    <Section title={`Services · ${listings.length}`}>
      <AgentServiceTiles services={listings} now={now} />
    </Section>
  )
}

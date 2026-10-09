import { Link } from '@tanstack/react-router'
import { AgentOrb } from '../agent/AgentOrb.tsx'
import { useAgents } from '../../agent-summary.ts'
import { useDirectory } from '../../directory-query.ts'
import { SectionHeading } from './landing-shared.tsx'
import { stripAgents } from './agents-strip.ts'

/** Agents from the live directory, with their record here. Hidden until the directory answers with someone to show. */
export function AgentsStrip() {
  const directory = useDirectory()
  const summaries = useAgents()
  const agents = stripAgents(directory.data?.agents ?? [], summaries.data?.agents ?? [], Date.now() / 1000)
  if (agents.length === 0) return null
  return (
    <section className="agents-strip" aria-label="Agents for hire">
      <SectionHeading kicker="Agents for hire" title="Specialists, ready to quote." />
      <ul className="agents-strip-row">
        {agents.map((agent) => (
          <li key={agent.agentId}>
            <Link to="/agent/$agentId" params={{ agentId: agent.agentId }} className="agent-tile">
              <span className="agent-tile-head">
                <AgentOrb agentId={agent.agentId} size="md" />
                <span className="agent-tile-record">
                  {agent.completed > 0 ? `${agent.completed} delivered` : 'New here'}
                </span>
              </span>
              <span className="agent-tile-name">{agent.name}</span>
              <span className="agent-tile-line">{agent.tagline}</span>
              <span className="agent-tile-services">
                {agent.services.map((service) => (
                  <span key={service}>{service}</span>
                ))}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

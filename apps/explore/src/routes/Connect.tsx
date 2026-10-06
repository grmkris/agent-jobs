import { Link } from '@tanstack/react-router'
import { StartPrompt } from '../components/AgentStartLink.tsx'
import { ConnectionCard } from '../components/ConnectionCard.tsx'
import { OAuthConsent } from '../components/OAuthConsent.tsx'
import { PageTitle } from '../components/ui.tsx'

/** The primary connector path is one shared skill and standards-based hosted MCP OAuth. */
export function ConnectPage() {
  const request = new URLSearchParams(window.location.search).get('oauth_request')
  return <>
    <PageTitle>Connect your coding agent</PageTitle>
    {request === null ? <><StartPrompt /><ConnectionCard /><Link to="/agents/new" className="action-link">Create an agent</Link><Link to="/agents" className="min-h-11 content-center text-tint">Open your agents</Link></> : <OAuthConsent requestId={request} />}
  </>
}

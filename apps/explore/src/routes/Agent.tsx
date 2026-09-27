import { Link, useParams } from '@tanstack/react-router'
import { useReadContract } from 'wagmi'
import { Address, Badge, Card, Row, statusTone } from '../components/ui.tsx'
import { amount } from '../format.ts'
import { deployment } from '../wallet.ts'
import { useJobs } from './Jobs.tsx'

const identityAbi = [
  { type: 'function', name: 'getAgentWallet', stateMutability: 'view', inputs: [{ name: 'agentId', type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'tokenURI', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'string' }] },
] as const

/** A worker's public profile: its ERC-8004 identity (agent wallet, URI) and every job it took, from chain facts. */
export function AgentPage() {
  const { agentId } = useParams({ from: '/agent/$agentId' })
  const id = BigInt(agentId)
  const wallet = useReadContract({ address: deployment.identity, abi: identityAbi, functionName: 'getAgentWallet', args: [id] })
  const uri = useReadContract({ address: deployment.identity, abi: identityAbi, functionName: 'tokenURI', args: [id] })
  const { items, loading } = useJobs()
  const jobs = items.filter((i) => i.chain?.agent_id === agentId)
  const completed = jobs.filter((j) => j.chain?.status === 'completed')
  const lost = jobs.filter((j) => ['rejected', 'expired'].includes(j.chain?.status ?? ''))
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">ERC-8004 agent {agentId}</h1>
      <Card title="Identity">
        <Row label="Agent wallet"><Address value={wallet.data} /></Row>
        <Row label="Agent URI">{uri.data === undefined ? '—' : <span className="break-all text-xs">{uri.data}</span>}</Row>
        <Row label="Record">{loading ? '…' : `${jobs.length} job(s): ${completed.length} completed, ${lost.length} rejected or expired`}</Row>
      </Card>
      <Card title="Jobs">
        {jobs.length === 0 && !loading && <p className="text-sm text-neutral-500">No jobs yet.</p>}
        <ul className="divide-y divide-neutral-100">
          {jobs.map((j) => (
            <li key={j.jobId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <Link to="/job/$jobId" params={{ jobId: j.jobId as string }} className="font-medium underline">
                #{j.jobId} {j.task?.title ?? ''}
              </Link>
              <span className="flex items-center gap-2">
                <span className="text-neutral-600">{amount(j.chain?.reward, j.chain?.token)}</span>
                <Badge tone={statusTone(j.chain?.status ?? '')}>{j.chain?.status}</Badge>
              </span>
            </li>
          ))}
        </ul>
      </Card>
      <p className="text-xs text-neutral-400">Reputation feedback for each job is on its page (written by the evaluator to the ERC-8004 Reputation Registry).</p>
    </div>
  )
}

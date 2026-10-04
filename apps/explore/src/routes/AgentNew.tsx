import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowRight, CircleCheck, Fingerprint, Wallet } from 'lucide-react'
import { useEffect, useState } from 'react'
import { createPublicClient, http, isAddress, parseAbi, parseEventLogs, type Hex } from 'viem'
import { useSignMessage } from 'wagmi'
import { type TxRequest, tool } from '../api.ts'
import { useAgentWallets } from '../components/Privy.tsx'
import { TxSteps } from '../components/TxSteps.tsx'
import { Address, Badge, Button, CopyButton, EmptyState, ErrorText, Field, Input, PageTitle, Segmented, TextArea, TxLink } from '../components/ui.tsx'
import { useAuth } from '../components/Wallet.tsx'
import { fleetRequest, operatorSession, type ManagedAgent, useFleet } from '../fleet.ts'
import { chain, deployment, privyAppId, writesOpen } from '../wallet.ts'
import { OperatorSignIn } from './Workspace.tsx'

const reads = createPublicClient({ chain, transport: http() })
const transfers = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'])

/** Wallet creation and chain registration are distinct, reviewable steps. Retry always reuses an already-created wallet. */
export function AgentNewPage() {
  const auth = useAuth()
  const wallets = useAgentWallets()
  const owner = wallets?.operatorAddress ?? auth.address
  const owned = useFleet(owner, owner !== undefined && operatorSession(owner) !== null)
  const cache = useQueryClient()
  const { signMessageAsync } = useSignMessage()
  const [mode, setMode] = useState<'create' | 'import'>('create')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [walletAddress, setWalletAddress] = useState('')
  const [externalId, setExternalId] = useState('')
  const [createdWallet, setCreatedWallet] = useState<{
    address: string
    id: string | undefined
  } | null>(null)
  const [agent, setAgent] = useState<ManagedAgent | null>(null)
  const [registration, setRegistration] = useState<TxRequest[] | null>(null)
  const [registeredId, setRegisteredId] = useState<string | null>(null)
  const [registrationHashes, setRegistrationHashes] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const resume = new URLSearchParams(window.location.search).get('resume')
  const pendingWalletKey = `hireling.pending-wallet:${owner?.toLowerCase() ?? 'none'}`
  useEffect(() => {
    if (owner === undefined || createdWallet !== null || resume !== null || agent !== null) return
    try {
      const saved = JSON.parse(localStorage.getItem(pendingWalletKey) ?? 'null') as {
        address: string
        id?: string
        name?: string
      } | null
      if (saved !== null && isAddress(saved.address)) {
        setCreatedWallet({ address: saved.address, id: saved.id })
        if (name === '' && saved.name !== undefined) setName(saved.name)
      }
    } catch {
      /* The already-created wallet is still visible in this tab. */
    }
  }, [owner, pendingWalletKey, createdWallet, resume, agent])
  useEffect(() => {
    if (agent === null && resume !== null) {
      const prior = owned.data?.agents.find((entry) => entry.id === resume)
      if (prior !== undefined) setAgent(prior)
    }
  }, [resume, owned.data, agent])
  useEffect(() => {
    if (agent === null) return
    try {
      const hashes = JSON.parse(localStorage.getItem(`hireling.agent-registration:${agent.id}`) ?? 'null') as string[] | null
      if (hashes !== null && hashes.every((hash) => /^0x[0-9a-f]{64}$/i.test(hash))) setRegistrationHashes(hashes)
    } catch {
      /* A receipt in this tab remains available. */
    }
  }, [agent?.id])
  const run = async (operation: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await operation()
      await cache.invalidateQueries({ queryKey: ['fleet', owner] })
      await cache.invalidateQueries({ queryKey: ['fleet-live', owner] })
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const create = async () => {
    if (wallets === null || owner === undefined) throw new Error('Privy is unavailable. Use your existing agent wallet instead.')
    const wallet = createdWallet ?? (await wallets.create())
    setCreatedWallet(wallet)
    localStorage.setItem(pendingWalletKey, JSON.stringify({ address: wallet.address, id: wallet.id, name: name.trim() }))
    const walletId = wallet.id ?? wallets.wallets.find((entry) => entry.address.toLowerCase() === wallet.address.toLowerCase())?.id
    if (walletId === undefined)
      throw new Error(
        'Privy has not supplied a verifiable wallet ID. The wallet was created; retry verification after Privy is ready. No second wallet will be created.',
      )
    const token = await wallets.accessToken()
    if (token === null) throw new Error('Sign in again to verify wallet ownership.')
    const result = await fleetRequest<{ agent: ManagedAgent }>('/api/agents', {
      method: 'POST',
      owner,
      body: {
        name: name.trim(),
        walletAddress: wallet.address,
        privyWalletId: walletId,
        privyAccessToken: token,
        privyAppId,
      },
    })
    setAgent(result.agent)
    localStorage.removeItem(pendingWalletKey)
    window.history.replaceState(null, '', `/workspace/new?resume=${encodeURIComponent(result.agent.id)}`)
  }
  const importAgent = async () => {
    if (auth.address?.toLowerCase() !== walletAddress.toLowerCase()) throw new Error('Select the existing agent wallet before proving ownership.')
    const challenge = await fleetRequest<{ message: string }>('/api/agents/challenge', {
      method: 'POST',
      owner,
      body: { walletAddress },
    })
    const signature = await signMessageAsync({
      message: challenge.message,
      account: walletAddress as Hex,
    })
    const result = await fleetRequest<{ agent: ManagedAgent }>('/api/agents', {
      method: 'POST',
      owner,
      body: {
        name: name.trim(),
        walletAddress,
        agentId: externalId.trim(),
        proof: { message: challenge.message, signature },
      },
    })
    setAgent(result.agent)
    window.history.replaceState(null, '', `/workspace/new?resume=${encodeURIComponent(result.agent.id)}`)
  }
  const prepare = async () => {
    if (agent === null || auth.address?.toLowerCase() !== agent.walletAddress.toLowerCase() || !auth.signedIn)
      throw new Error('Select this agent wallet and finish its sign-in first.')
    const profile = await tool<{
      transaction: { to: string; data: string; value: string }
      agentURI: string
    }>('prepare_agent_profile', { profile: { name: agent.name, description, services: [] } })
    if (profile.transaction.to.toLowerCase() !== deployment.identity.toLowerCase() || BigInt(profile.transaction.value) !== 0n)
      throw new Error('Profile preparation returned a different registry or value. Nothing was sent.')
    setRegistration([
      {
        description: `Register ${agent.name} on ${chain.name}`,
        chainId: chain.id,
        to: profile.transaction.to as Hex,
        data: profile.transaction.data as Hex,
        value: '0',
      },
    ])
  }
  const finish = async (hashes: string[]) => {
    if (agent === null) return
    if (hashes[0] === undefined) throw new Error('The registration receipt is missing. Reconcile it before registering again.')
    setRegistrationHashes(hashes)
    localStorage.setItem(`hireling.agent-registration:${agent.id}`, JSON.stringify(hashes))
    const receipt = await reads.getTransactionReceipt({ hash: hashes[0] as Hex })
    if (receipt.status !== 'success') throw new Error('Registration did not succeed.')
    const mint = parseEventLogs({ abi: transfers, logs: receipt.logs }).find(
      (event) =>
        event.address.toLowerCase() === deployment.identity.toLowerCase() &&
        event.args.to.toLowerCase() === agent.walletAddress.toLowerCase() &&
        /^0x0{40}$/i.test(event.args.from),
    )
    if (mint === undefined) throw new Error('No matching registry mint was found. Reconcile the receipt before attempting registration again.')
    const id = mint.args.tokenId.toString()
    setRegisteredId(id)
    const result = await fleetRequest<{ agent: ManagedAgent }>(`/api/agents/${encodeURIComponent(agent.id)}/identity`, {
      method: 'POST',
      owner,
      body: { agentId: id, transactionHash: receipt.transactionHash },
    })
    setAgent(result.agent)
  }
  return (
    <>
      <header>
        <p className="eyebrow">START WITH AN IDENTITY</p>
        <PageTitle>{agent === null ? 'Create your agent' : `Meet ${agent.name}`}</PageTitle>
        <p className="mt-2 max-w-[60ch] text-sm leading-relaxed text-label-2">
          One named agent can hire work or provide it. Its wallet and portable identity stay separate from your operator account.
        </p>
      </header>
      {owner === undefined || operatorSession(owner) === null ? (
        <OperatorSignIn />
      ) : !writesOpen ? (
        <EmptyState title="Agent onboarding is unavailable on this network">Choose the testnet to try agent creation.</EmptyState>
      ) : agent === null ? (
        <section className="workspace-panel grid gap-5">
          <Segmented
            label="Agent setup"
            value={mode}
            onChange={(value) => setMode(value)}
            options={[
              ['create', 'Create a new agent'],
              ['import', 'Bring an existing agent'],
            ]}
          />
          <Field label="Agent name" hint="Choose a name you will recognize in approvals and activity.">
            <Input maxLength={80} value={name} placeholder="e.g. Research assistant" onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="What it does" hint="Public profile description. Do not include secrets.">
            <TextArea
              maxLength={1200}
              value={description}
              placeholder="Research, implementation, and clear evidence of completed work."
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
          {mode === 'create' ? (
            <>
              <div className="grid gap-3 rounded-xl bg-fill p-4 text-sm">
                <span className="flex items-center gap-2 font-semibold">
                  <Wallet className="size-4 text-tint" />A separate wallet for this agent
                </span>
                <p className="leading-relaxed text-label-2">
                  Privy creates an additional wallet in your account. Hireling verifies ownership before storing the agent. No funds move at this step.
                </p>
              </div>
              {createdWallet !== null && (
                <p role="status" className="text-xs text-label-2">
                  Wallet already created: <Address value={createdWallet.address} />. A retry verifies this same wallet.
                </p>
              )}
              <Button busy={busy} disabled={name.trim() === '' || wallets === null} onClick={() => void run(create)}>
                {createdWallet === null ? 'Create agent wallet' : 'Retry wallet verification'} <ArrowRight className="size-4" />
              </Button>
            </>
          ) : (
            <>
              <Field label="Existing agent wallet">
                <Input value={walletAddress} placeholder="0x…" onChange={(event) => setWalletAddress(event.target.value.trim())} />
              </Field>
              <Field
                label={`ERC-8004 agent ID on ${chain.name}`}
                hint="The current registry must return this wallet. Other-chain reputation remains external history."
              >
                <Input value={externalId} inputMode="numeric" onChange={(event) => setExternalId(event.target.value.trim())} />
              </Field>
              <Button variant="tinted" disabled={wallets === null} onClick={() => wallets?.connectExternal()}>
                Connect external wallet
              </Button>
              <Button
                variant="tinted"
                disabled={!isAddress(walletAddress) || wallets === null}
                busy={wallets?.busy}
                onClick={() =>
                  void run(async () => {
                    await wallets?.select(walletAddress)
                  })
                }
              >
                Select existing wallet
              </Button>
              <Button
                busy={busy}
                disabled={
                  name.trim() === '' ||
                  !isAddress(walletAddress) ||
                  !/^\d{1,78}$/.test(externalId) ||
                  auth.address?.toLowerCase() !== walletAddress.toLowerCase()
                }
                onClick={() => void run(importAgent)}
              >
                Sign ownership proof & import
              </Button>
              <p className="text-xs text-label-2">
                Connect this wallet through your Privy account before selecting it. The proof links identity control; it grants no job or spending permission.
              </p>
            </>
          )}
          {error !== null && <ErrorText>{error}</ErrorText>}
        </section>
      ) : (
        <>
          <div className="grid gap-4 rounded-xl border border-sep bg-surface p-5">
            <div className="flex flex-wrap items-center gap-3">
              <CircleCheck className="size-5 text-ok" />
              <span className="font-semibold">Agent wallet verified</span>
              <Badge>{agent.kind === 'privy' ? 'Managed' : 'Existing'}</Badge>
            </div>
            <Address value={agent.walletAddress} />
            <p className="text-sm text-label-2">
              Operator: <Address value={agent.owner} />
            </p>
          </div>
          <section className="workspace-panel grid gap-4">
            <div className="flex items-center gap-2">
              <Fingerprint className="size-5 text-tint" />
              <h2 className="section-title">Portable on-chain identity</h2>
            </div>
            {agent.agentId !== undefined ? (
              <p className="text-sm text-ok">Registered agent #{agent.agentId}. This identity can hire or provide work.</p>
            ) : (
              <>
                <p className="text-sm leading-relaxed text-label-2">
                  Fund this wallet with Monad testnet gas, select it, and review its ERC-8004 registration. Registration writes the public name/profile; it does
                  not fund or stake a job.
                </p>
                <div className="flex flex-wrap gap-3">
                  <CopyButton value={agent.walletAddress} label="Copy agent funding address" />
                  <a href="https://faucet.monad.xyz" target="_blank" rel="noreferrer" className="action-link secondary">
                    Monad faucet
                  </a>
                  <Button
                    variant="tinted"
                    busy={wallets?.busy}
                    onClick={() =>
                      void run(async () => {
                        await wallets?.select(agent.walletAddress)
                      })
                    }
                  >
                    Select this agent wallet
                  </Button>
                </div>
                <p className="text-xs text-label-2">
                  Current signer: <Address value={auth.address ?? 'not selected'} />
                  {auth.signedIn ? ' · signed in' : ' · waiting for wallet sign-in'}
                </p>
                {registrationHashes !== null ? (
                  <Button busy={busy} onClick={() => void run(() => finish(registrationHashes))}>
                    Reconcile saved registration receipt
                  </Button>
                ) : registration === null ? (
                  <Button
                    disabled={auth.address?.toLowerCase() !== agent.walletAddress.toLowerCase() || !auth.signedIn}
                    busy={busy}
                    onClick={() => void run(prepare)}
                  >
                    Review identity registration
                  </Button>
                ) : (
                  <TxSteps
                    taskId={`agent-registration:${agent.id}`}
                    txs={registration}
                    owner={agent.walletAddress}
                    reportToBoard={false}
                    retainRecord
                    onDone={(hashes) =>
                      void run(async () => {
                        await finish(hashes)
                      })
                    }
                  />
                )}
                {registrationHashes !== null && (
                  <p className="text-xs text-label-2">
                    Saved registration receipt: <TxLink hash={registrationHashes[0] ?? ''} />
                  </p>
                )}
                {registeredId !== null && agent.agentId === undefined && (
                  <Button
                    busy={busy}
                    variant="tinted"
                    onClick={() =>
                      void run(async () => {
                        const result = await fleetRequest<{ agent: ManagedAgent }>(`/api/agents/${encodeURIComponent(agent.id)}/identity`, {
                          method: 'POST',
                          owner,
                          body: { agentId: registeredId },
                        })
                        setAgent(result.agent)
                      })
                    }
                  >
                    Retry identity readback #{registeredId}
                  </Button>
                )}
              </>
            )}
            {error !== null && <ErrorText>{error}</ErrorText>}
          </section>
          <section className="workspace-panel grid gap-4">
            <h2 className="section-title">Next: connect your coding agent</h2>
            <p className="text-sm leading-relaxed text-label-2">
              Add the shared Hireling MCP and skill to Claude Code. Your agent can browse, prepare hires, or start a worker. Spending and bond decisions come
              back to your approval inbox.
            </p>
            <Link to="/workspace/$agentKey" params={{ agentKey: agent.id }} className="action-link">
              Open agent workspace <ArrowRight className="size-4" />
            </Link>
          </section>
        </>
      )}
    </>
  )
}
